import { encodeHex, encodeLiteral, parseTextArrayRegion, replaceTextRuns, scanTextRuns } from "./content-stream.js";
import { FALLBACK_FONT_MARKER, buildFallbackFontObjects, fingerprintFont, freeResourceName, glyphSpaceWidth, glyphsFor, glyphsFromToUnicode, identityEncode, parseFallbackFont } from "./fallback-font.js";
import { classifyFontResource } from "./font-classification.js";
import { describeFontWidths, measureCodes, resolveDescendantFont } from "./font-metrics.js";
import { decodeWithCMap, encodeWithCMap, parseToUnicodeCMap } from "./cmap.js";
import { summarizeEncryption } from "./encryption.js";
import { deflate, decodeStreamBytes, filters } from "./flate.js";
import { PdfStructure, parseReferenceArray, reference } from "./pdf-structure.js";
import { authenticateEncryptedPdf, decryptStreamBytes } from "./security/decrypt.js";

const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

function encodeSingleByte(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) throw new Error("String replacements are limited to single-byte characters; pass encoded Uint8Array data for composite fonts");
    bytes[index] = code;
  }
  return bytes;
}

/**
 * How much of the surrounding line searchText() hands back with each match, in Unicode
 * code points either side. Enough for a caller to tell two hits of the same word apart
 * in a list; short enough that a match object stays cheap.
 */
const CONTEXT_RADIUS = 12;

/** An error carrying a stable `code`, so callers can branch on the reason rather than
 * on message text (which is free to change, and is localised nowhere). */
function searchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The runs of every scanned content stream, decoded, in document order -- with the
 * continuity metadata that scanTextRuns() attached and that listTextRuns() drops.
 *
 * `text` is each run's *current* text: the pending replacement's, where one has already
 * been staged by replaceText()/replaceTextMatch(), and the original otherwise. Search
 * therefore sees the document as the caller has edited it so far, which is also what
 * makes the staleness check in replaceTextMatch() meaningful -- a match whose runs have
 * moved on since it was found no longer compares equal to its recorded snapshot.
 */
function internalRuns(editor) {
  return editor.streams.flatMap((stream) => stream.runs.map((run, runIndex) => {
    const id = `${stream.object.number}:${runIndex}`;
    const mappings = stream.fontMaps.get(run.fontName);
    return {
      id,
      objectNumber: stream.object.number,
      continuityId: run.continuityId,
      joinBefore: run.joinBefore,
      fontName: run.fontName,
      // A run a fallback rewrite has replaced reads as what that rewrite drew, not as
      // what the original operand held -- otherwise search would keep reporting text the
      // document no longer shows, and a match into it would look fresh when it is not.
      text: editor.fallbackRunTexts.get(id) ?? decodeWithCMap(editor.pending.get(id) ?? run.value, mappings)
    };
  }));
}

/**
 * Joins runs into the strings a reader of the page actually sees.
 *
 * Two runs belong to the same segment only when they come from the same content stream
 * object *and* carry the same `continuityId` -- the judgement scanTextRuns() already
 * made from the PDF's own operators (a new `BT`, an `ET`, `Td`/`TD`/`Tm`/`T*`, `'`/`"`,
 * a font switch, ... all end a segment). Nothing here re-derives that from geometry or
 * guesses at it, and nothing joins across content streams: a run's position in this
 * list is never, on its own, a reason to join it to its neighbour.
 *
 * Offsets are counted in Unicode code points, not UTF-16 code units, so a character
 * outside the BMP counts once (see the character-count rule in replaceTextMatch()).
 */
function buildSegments(runs) {
  const segments = [];
  let current = null;
  for (const run of runs) {
    if (!current || current.objectNumber !== run.objectNumber || current.continuityId !== run.continuityId) {
      current = { objectNumber: run.objectNumber, continuityId: run.continuityId, points: [], entries: [] };
      segments.push(current);
    }
    const points = [...run.text];
    current.entries.push({ run, start: current.points.length, end: current.points.length + points.length });
    current.points.push(...points);
  }
  return segments;
}

/** indexOf() over arrays of code points, from `from` onwards; -1 when absent. */
function indexOfPoints(haystack, needle, from) {
  for (let start = from; start + needle.length <= haystack.length; start += 1) {
    let offset = 0;
    while (offset < needle.length && haystack[start + offset] === needle[offset]) offset += 1;
    if (offset === needle.length) return start;
  }
  return -1;
}

/**
 * Encodes a replacement for one specific run, through that run's own existing font:
 * its `/ToUnicode` CMap when it has one (reverse-mapped by encodeWithCMap), and plain
 * single-byte codes when it does not. No font is embedded and no subset is rebuilt, so
 * a character the existing font cannot express fails loudly here -- which is the point.
 */
/**
 * The characters of `text` the run's own font has no code for -- the reason the ordinary
 * path cannot write them. Reported alongside the refusal so a caller can name them to a
 * user without parsing an error message or knowing what a CMap is.
 */
function charactersOutsideFont(editor, run, text) {
  const stream = editor.streams.find((candidate) => candidate.object.number === run.objectNumber);
  const mappings = stream.fontMaps.get(run.fontName);
  const known = mappings?.size ? new Set(mappings.values()) : null;
  return [...text].filter((character) => (known ? !known.has(character) : character.codePointAt(0) > 0xff));
}

function encodeReplacement(editor, run, replacement) {
  if (typeof replacement !== "string") return Uint8Array.from(replacement);
  const stream = editor.streams.find((candidate) => candidate.object.number === run.objectNumber);
  const mappings = stream.fontMaps.get(run.fontName);
  return mappings ? encodeWithCMap(replacement, mappings) : encodeSingleByte(replacement);
}

/**
 * How replaceTextMatch() will write a given replacement. Reported by
 * checkTextMatchReplacement() so a caller can decide before committing to anything.
 */
const REPLACEMENT_MODE = {
  singleRun: "single-run",
  sameLength: "same-length",
  delete: "delete",
  variableLength: "variable-length-safe",
  // Written through a caller-supplied fallback font (see setFallbackFont), because the
  // document's own font has no code for some of the replacement's characters.
  fallbackFont: "fallback-font",
  fallbackFontPartial: "fallback-font-partial",
  fallbackFontMultiRun: "fallback-font-multi-run"
};

/**
 * Where the text position after a run is set by something other than that run's own
 * advance. Only there may a run be redrawn in a different font: restoring the font does
 * not restore the position, and an embedded font's glyphs are not the widths the
 * original's were, so anything drawn from that run's end would move.
 */
const POSITION_SAFE_AFTER = new Set(["end-of-text-object", "repositioned"]);

function refusal(code, reason, unsafeReason, diagnostics) {
  const result = { allowed: false, code, reason };
  if (unsafeReason) result.unsafeReason = unsafeReason;
  if (diagnostics) result.diagnostics = diagnostics;
  return result;
}

/**
 * Whether the runs of a match may have characters moved BETWEEN them -- the question a
 * variable-length replacement has to answer, and a stricter one than the search
 * continuity that let the runs be read as one string in the first place.
 *
 * Returns null when the move is safe, or a short reason why it is not.
 *
 * What makes it safe is narrow and provable, not estimated. Inside a group of operands
 * separated only by zero-valued `TJ` adjustments or by nothing at all, a zero adjustment
 * translates the text matrix by zero and an empty string operand shows no glyphs and
 * advances nothing -- so the page depends only on the concatenation of the operands, not
 * on how the characters are distributed among them. Moving them all into the first
 * operand is then exactly the single-operand replacement v0.2.1 already does, with no
 * glyph width, text matrix, or spacing arithmetic anywhere.
 *
 * "Separated only by zero-valued adjustments" is about the NET displacement between two
 * strings, not about where the numbers are written: a `TJ` number moves the next string
 * whether it sits at the end of one array, at the start of the next, or between two
 * operands of a single one, so `[(A) 120] TJ [(B)] TJ` is no more an adjacency than
 * `[(A) 120 (B)] TJ` is. scanTextRuns() sums across the operator boundary for exactly
 * this reason; reading only the numbers inside an array would let a kern be silently
 * relocated to after the replacement.
 *
 * Everything else is refused. A non-zero adjustment is real spacing between two specific
 * glyphs, and honouring it after moving characters would mean re-deciding what it should
 * be; a `Tc`/`Tw`/`Tz`/`Tr`, colour, or marked-content operator between two operands
 * means the two are drawn under different state, so a character moved across it would be
 * drawn differently than the PDF asked. Both are out of scope by design -- see the
 * README -- and neither is guessed at.
 */
function variableLengthObstacle(span, current) {
  for (let index = 1; index < span.length; index += 1) {
    const join = current.get(span[index].runId)?.joinBefore;
    // A null join means this run starts its own continuity group, which a match should
    // never span. Refuse rather than assume the scanner and the match agree.
    if (!join) return "unsupported-topology";
    if (join.kind === "state-change") return "text-state-boundary";
    // The two operands are adjacent only if nothing displaces the second relative to the
    // first. That holds for a `TJ` adjustment between two operands of one array and,
    // equally, for one spanning the operator boundary -- `[(A) 120] TJ [(B)] TJ` moves B
    // exactly as `[(A) 120 (B)] TJ` does, and a scanner that only looked inside arrays
    // would read it as a plain adjacency and quietly relocate the 120. Compared as a
    // number, so `0`, `0.0`, `+0`, `-0` and `-0.0` are all the same zero, and a pair
    // that cancels out (`[(A) 120] TJ [-120 (B)] TJ`) is genuinely adjacent.
    if (join.adjustment !== 0) return "non-zero-tj-adjustment";
  }
  return null;
}

/** Scanner runs behind a match's span entries, in span order. */
function scannedRuns(editor, span) {
  return span.map((entry) => {
    const [objectNumber, runIndex] = entry.runId.split(":").map(Number);
    const stream = editor.streams.find((candidate) => candidate.object.number === objectNumber);
    return { stream, run: stream?.runs[runIndex], entry };
  });
}

/**
 * Registers one fallback font in one page's `/Resources /Font`, leaving every other
 * resource as it was, and returns the resource name to use on that page. The font objects
 * themselves are shared: a second page gets its own name and its own resources entry, but
 * points at the same Type0 object, so the font file is never embedded twice.
 *
 * `pageResources` is `pageResourcesObjectNumber -> Map(fontDigest -> resourceName)`, shared
 * across every fallback font this document embeds -- not just the one being registered here
 * -- so that when a second fallback font (a different digest) is registered on a page a
 * first one already used, its resource name is chosen knowing about the first one's, even
 * though the page's own /Font dictionary (read fresh from the original document below) does
 * not yet mention it: that addition exists only as a pending object update, applied at
 * save(), not as a change `editor.document` itself can see.
 */
async function registerFallbackResource(editor, digest, type0Number, pageResources, resources) {
  if (resources?.number === undefined) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "This page's /Resources are not an addressable object, so the fallback font cannot be added to them");
  }
  let names = pageResources.get(resources.number);
  const existing = names?.get(digest);
  if (existing) return { name: existing };
  const reserved = names ? [...names.values()] : [];

  const indirect = reference(resources.dictionary, "Font");
  let holder = resources;
  if (indirect) {
    try {
      // Resolved rather than read directly: a /Font sub-dictionary may be compressed
      // inside an Object Stream, which reading it already allows for (see
      // fontReferences()). Writing it back as a plain object in the incremental update is
      // fine -- a later definition supersedes the compressed one.
      holder = await editor.document.resolveObject(indirect, editor.security, decryptStreamBytes);
    } catch (error) {
      return refusal("FALLBACK_LAYOUT_UNSUPPORTED", `This page's /Font resources could not be read in order to add the fallback font to them: ${error.message}`);
    }
  }
  // A different fallback font may already have added itself to this same object, as a
  // pending object update from an earlier, already-committed plan (see commitPlan()) --
  // editor.document itself does not see that, since it reads the original file. Building on
  // the pending dictionary rather than the original is what keeps that earlier font's entry
  // from being overwritten when this one is registered.
  const pending = editor.pendingObjects.get(holder.number);
  if (pending?.dictionary) holder = { ...holder, dictionary: pending.dictionary };

  const inline = indirect ? null : holder.dictionary.match(/\/Font\s*<<([\s\S]*?)>>/);
  let name;
  let dictionary;
  if (indirect) {
    name = freeResourceName(holder.dictionary, reserved);
    dictionary = holder.dictionary.replace(/>>\s*$/, `/${name} ${type0Number} 0 R >>`);
  } else if (inline) {
    name = freeResourceName(inline[1], reserved);
    dictionary = holder.dictionary.replace(inline[0], `/Font << ${inline[1].trim()} /${name} ${type0Number} 0 R >>`);
  } else {
    // A page with no /Font at all: give it one rather than refusing.
    name = freeResourceName("", reserved);
    dictionary = holder.dictionary.replace(/>>\s*$/, `/Font << /${name} ${type0Number} 0 R >> >>`);
  }
  if (!names) {
    names = new Map();
    pageResources.set(resources.number, names);
  }
  names.set(digest, name);
  return { name, object: { number: holder.number, generation: holder.generation, dictionary } };
}

/**
 * Finds a copy of this fallback font that a previous session already embedded, so editing
 * a document again adds to it rather than embedding a second copy of the same
 * multi-megabyte program. Callers normally save and reopen between edits, so without this
 * every round trip would grow the file by the whole font.
 *
 * A font is recognised by the marker buildFallbackFontObjects() writes into the Type0
 * dictionary, which records a SHA-256 of the program it holds. Only an exact match is
 * adopted: text written into an existing font carries glyph ids resolved against the font
 * supplied now, so anything but the same program byte for byte could draw the wrong
 * characters. Its existing glyphs are read back from its ToUnicode CMap, and the pages
 * already naming it are recorded, so neither is added twice.
 *
 * Returns null when the document carries no such font. Reads only; the caller decides
 * what to do with it.
 */
async function adoptExistingFallbackFont(editor, fallback) {
  const marker = new RegExp(`/${FALLBACK_FONT_MARKER}\\s*<\\s*([0-9a-fA-F]+)\\s*>`);
  for (const stream of editor.streams) {
    if (stream.resources?.number === undefined) continue;
    let holder = stream.resources;
    const indirect = reference(stream.resources.dictionary, "Font");
    if (indirect) {
      try {
        holder = await editor.document.resolveObject(indirect, editor.security, decryptStreamBytes);
      } catch {
        continue;
      }
    }
    const fonts = indirect ? holder.dictionary : (holder.dictionary.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? "");
    for (const entry of fonts.matchAll(/\/([^\s/<>{}[\]()]+)\s+(\d+)\s+(\d+)\s+R/g)) {
      let type0;
      try {
        type0 = await editor.document.resolveObject({ number: Number(entry[2]), generation: Number(entry[3]) }, editor.security, decryptStreamBytes);
      } catch {
        continue;
      }
      const marked = type0.dictionary.match(marker);
      if (!marked || marked[1].toLowerCase() !== fallback.digest) continue;
      // A secondary check only: the digest already settles which program this is.
      if (!new RegExp(`/BaseFont\\s*/${fallback.postScriptName}\\b`).test(type0.dictionary)) continue;

      const [cidFontReference] = parseReferenceArray(type0.dictionary, "DescendantFonts");
      const toUnicodeReference = reference(type0.dictionary, "ToUnicode");
      if (!cidFontReference || !toUnicodeReference) continue;
      const cidFont = await editor.document.resolveObject(cidFontReference, editor.security, decryptStreamBytes);
      const descriptorReference = reference(cidFont.dictionary, "FontDescriptor");
      if (!descriptorReference) continue;

      const cmapObject = editor.document.object(toUnicodeReference);
      const glyphs = glyphsFromToUnicode(fallback, parseToUnicodeCMap(await decodeStream(cmapObject, "ToUnicode stream", editor.security)));

      // Every page whose /Font already names this object keeps the name it was given.
      const resources = new Map();
      for (const other of editor.streams) {
        if (other.resources?.number === undefined) continue;
        const otherIndirect = reference(other.resources.dictionary, "Font");
        let otherHolder = other.resources;
        if (otherIndirect) {
          try {
            otherHolder = await editor.document.resolveObject(otherIndirect, editor.security, decryptStreamBytes);
          } catch {
            continue;
          }
        }
        const text = otherIndirect ? otherHolder.dictionary : (otherHolder.dictionary.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? "");
        const named = text.match(new RegExp(`/([^\\s/<>{}\\[\\]()]+)\\s+${type0.number}\\s+\\d+\\s+R`));
        if (named) resources.set(other.resources.number, named[1]);
      }

      return {
        numbers: {
          type0: type0.number,
          cidFont: cidFont.number,
          descriptor: descriptorReference.number,
          fontFile: null,
          toUnicode: toUnicodeReference.number
        },
        resources,
        glyphs,
        programAlreadyEmbedded: true
      };
    }
  }
  return null;
}

/** Whether two operand byte strings are the same bytes. */
function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * A `TJ` adjustment as a plain decimal a reader will read back as exactly this number.
 *
 * Returns null when it cannot be written exactly -- rather than rounding, which would put
 * the following text somewhere other than where the PDF had it. Widths are whole
 * glyph-space units in every font this engine can read metrics from, so this returns an
 * integer in practice; the fractional path exists so a `/Widths` entry written as a real
 * is refused rather than silently truncated. Exponent notation is never produced (a PDF
 * number may not use it).
 */
function formatAdjustment(value) {
  if (!Number.isFinite(value)) return null;
  // `-0` is a real JS value and would be written as "-0"; it is the same displacement as 0.
  const text = Number.isInteger(value)
    ? String(value === 0 ? 0 : value)
    : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  // A PDF number is plain decimal: no exponent, however JS chose to spell it. Anything
  // that does not read back as the same value is refused rather than rounded into place.
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  return Number(text) === value ? text : null;
}

/**
 * Splits one run's operand bytes into the part before the match, the match itself, and the
 * part after -- and proves the split by re-encoding all three and comparing the result with
 * the operand the document actually holds.
 *
 * Needed because the width of the removed text has to be measured from its *codes*, and the
 * run is known as text: a font whose `/ToUnicode` maps two different codes to the same
 * character would re-encode to a different code, of a possibly different width. Returning
 * null when the round trip does not reproduce the operand byte for byte is what keeps that
 * from being measured wrongly instead of refused.
 */
function splitRunOperand(editor, entry, run) {
  const points = [...entry.runText];
  const parts = {
    prefix: points.slice(0, entry.charStart).join(""),
    matched: points.slice(entry.charStart, entry.charEnd).join(""),
    suffix: points.slice(entry.charEnd).join("")
  };
  let encoded;
  try {
    encoded = {
      prefix: encodeReplacement(editor, entry, parts.prefix),
      matched: encodeReplacement(editor, entry, parts.matched),
      suffix: encodeReplacement(editor, entry, parts.suffix)
    };
  } catch {
    return null;
  }
  const rejoined = concat([encoded.prefix, encoded.matched, encoded.suffix]);
  // The run's *current* bytes: an ordinary replacement already staged on this run is what
  // the match was found in, and is what the rewrite is splitting.
  const current = editor.pending.get(entry.runId) ?? run.value;
  return sameBytes(rejoined, current) ? { ...parts, bytes: encoded } : null;
}

/**
 * Plans the rewrite of a match drawn inside one or more `TJ` arrays, keeping every glyph
 * after the match exactly where the PDF put it.
 *
 * A `TJ` array is a list of strings and displacements processed one after another, and the
 * boundary between two adjacent `TJ` operators does nothing at all -- so the whole stretch
 * from the `[` that opens the match's first array to the `TJ` that closes its last is one
 * flat list of elements (see parseTextArrayRegion()). The rewrite splits that list in three
 * and writes it back as up to three operators:
 *
 *     [ <elements before the match> <prefix> ] TJ
 *     /Fallback size Tf [ <replacement glyphs> ] TJ /Original size Tf
 *     [ <adjustment> <suffix> <elements after the match> ] TJ
 *
 * Everything outside the match is copied out of the original stream byte for byte, so no
 * adjustment is re-formatted, moved, merged, dropped or duplicated: `0`, `+0`, `-0` and
 * `0.0` all come back exactly as written, and the numbers before and after the match keep
 * both their values and their order.
 *
 * The one number this adds is `<adjustment>`, and it is what makes the rewrite safe. PDF
 * advances the text position by
 *
 *     tx = ((w0 - Tj/1000) * Tfs + Tc + Tw) * Th
 *
 * for each glyph, where `w0` is the glyph's width in glyph space and `Tj` an adjustment
 * from the array. Both the glyph widths and the adjustments are multiplied by `Tfs * Th`,
 * so font size and horizontal scaling cancel out of any equation between them, and what
 * remains is a comparison of plain glyph-space numbers:
 *
 *     advance(original) = W_original + g_original * Tc' + s_original * Tw' - K
 *     advance(replacement) = W_replacement + g_replacement * Tc' - n
 *
 * where `W` are summed glyph widths, `g` glyph counts, `s` the count of single-byte code
 * 32 (all `Tw` ever applies to), `K` the displacements the match's own operands were
 * separated by, and `Tc'`/`Tw'` the spacings expressed in glyph-space units. Setting the
 * two equal gives the adjustment to write:
 *
 *     n = W_replacement - W_original + K
 *
 * -- exactly, and with no dependence on font size or horizontal scaling -- provided the two
 * spacing terms cancel. They are made to, rather than assumed to:
 *
 * - `Tc` is only allowed to be non-zero when the replacement shows exactly as many glyphs
 *   as the original did, so `g_replacement * Tc'` equals `g_original * Tc'`. Otherwise the
 *   difference is a multiple of `Tc * 1000 / Tfs`, which is not in general a number a `TJ`
 *   adjustment can express exactly.
 * - `Tw` reaches single-byte code 32 only, and the fallback font is written through a
 *   2-byte encoding, so the replacement contributes no `Tw` at all. A match that removes a
 *   single-byte space while `Tw` is in force is therefore refused.
 * - a `Tc`/`Tw` this scanner could not track (a `Q` with nothing saved, a `"`) is unknown,
 *   not assumed to be zero.
 *
 * `W_original` comes from the document's own `/Widths` or `/W` -- the numbers a reader
 * positions with, read by src/font-metrics.js -- and `W_replacement` from the very `/W`
 * entries the fallback font is embedded with, so both sides are the numbers that will
 * actually be in the file. Where they cannot be had exactly, this refuses.
 *
 * Keeping the following text at `advance(original)` is necessary but not sufficient: `n`
 * can always be chosen to land the following text exactly there, however wide the
 * replacement is, because `n` only ever moves where the NEXT string starts. It says
 * nothing about whether the replacement's own glyphs -- drawn at their natural width,
 * with no `n` applied to them -- already reach past that point (v0.4.4; this is what let
 * `令和 -> しょうわ` through in v0.4.3, drawn over the `8` that followed it). So before `n`
 * is computed, `replacementWidth` (`W_replacement`) is compared against `availableAdvance`
 * -- the exact advance the original text had from the start of the match to wherever the
 * next unmoved glyph actually starts. `width - between` (`W_original` minus the same `K`
 * the adjustment arithmetic below uses) is only part of that: it is where the match's OWN
 * text ended, and a further `TJ` number can sit between there and the next glyph -- in
 * this match's own tail (`[(match) 50 (next)] TJ`) or at the very start of a later `TJ`'s
 * array (`[(match)] TJ [50 (next)] TJ`). `availableAdvance` also subtracts that gap, read
 * from the next run's own `displacement` (scanTextRuns(), src/content-stream.js) -- the
 * running total of numbers the scanner already accumulates towards whatever string
 * collects them next, reused here rather than parsed a second way. A replacement wider
 * than `availableAdvance` is refused: nothing here moves the following text further away,
 * shrinks the replacement, or reflows anything to make room. When no following text-
 * showing operand can be found at all (the content stream ends inside the open text
 * object), the replacement is refused rather than assuming the gap is zero.
 *
 * When nothing at all is drawn from the end of the match -- no elements after it, no suffix
 * in its own operand, and an `ET`/`BT`/`Td`/`TD`/`Tm`/`T*` next -- no adjustment is needed
 * or written, and no metrics are required: that is the same situation the `Tj` rewrite has
 * always relied on, and the replacement simply takes whatever width it takes.
 */
function planTextArrayRewrite(editor, pieces, glyphs, fallback) {
  const stream = pieces[0].stream;
  if (pieces.some((piece) => piece.stream !== stream)) {
    return refusal("FALLBACK_MULTI_RUN_UNSUPPORTED", "This match is drawn across more than one content stream, which cannot be rewritten as one piece", "unsupported-topology");
  }
  if (pieces.length > 1) {
    const current = new Map(internalRuns(editor).map((run) => [run.id, run]));
    for (let index = 1; index < pieces.length; index += 1) {
      const join = current.get(pieces[index].entry.runId)?.joinBefore;
      // Unlike the Tj rewrite, a non-zero displacement between two operands is not an
      // obstacle here: it sits inside the stretch being replaced and is accounted for in
      // the arithmetic above. A text-state change between them still is -- the operands
      // are drawn under different state, and this writes them as one.
      if (!join) return refusal("FALLBACK_MULTI_RUN_UNSUPPORTED", "This match's operands are not attached to each other in a shape this version knows", "unsupported-topology");
      if (join.kind === "state-change") {
        return refusal("FALLBACK_MULTI_RUN_UNSUPPORTED", "This match's operands are drawn under different text state (a Tc/Tw/Tz/Tr, colour or marked-content operator sits between them), so they cannot be redrawn in another font as one piece", "text-state-boundary");
      }
    }
  }

  const first = pieces[0].run;
  const last = pieces.at(-1).run;
  if (typeof first.arrayStart !== "number" || first.arrayStart >= first.start) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "This match's TJ array could not be located in the content stream");
  }
  const region = { start: first.arrayStart, end: last.operatorEnd };
  let elements;
  try {
    elements = parseTextArrayRegion(stream.decoded, region.start, region.end);
  } catch (error) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", `The TJ operators this match is drawn by could not be read as a whole: ${error.message}`);
  }
  const firstIndex = elements.findIndex((element) => element.kind === "string" && element.start === first.start);
  const lastIndex = elements.findIndex((element) => element.kind === "string" && element.start === last.start);
  if (firstIndex === -1 || lastIndex === -1 || lastIndex < firstIndex) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "This match's operands could not be located inside the TJ operators that draw them");
  }
  const inside = elements.slice(firstIndex, lastIndex + 1);
  const covered = new Set(pieces.map((piece) => piece.run.start));
  const insideStrings = inside.filter((element) => element.kind === "string");
  if (insideStrings.length !== pieces.length || insideStrings.some((element) => !covered.has(element.start))) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "The TJ operators this match is drawn by hold text the match does not cover between its own operands");
  }
  const head = elements.slice(0, firstIndex);
  const tail = elements.slice(lastIndex + 1);
  // The displacements written between the match's own operands. They are removed with the
  // text they separated, so they are added back into the one adjustment below.
  const between = inside.reduce((sum, element) => (element.kind === "number" ? sum + element.value : sum), 0);

  const firstEntry = pieces[0].entry;
  const lastEntry = pieces.at(-1).entry;
  const prefix = [...firstEntry.runText].slice(0, firstEntry.charStart).join("");
  const suffix = [...lastEntry.runText].slice(lastEntry.charEnd).join("");
  const nothingFollows = !tail.length && suffix === "";

  let adjustment = null;
  if (!nothingFollows || !POSITION_SAFE_AFTER.has(last.followedBy)) {
    const splits = pieces.map((piece) => splitRunOperand(editor, piece.entry, piece.run));
    const metrics = stream.fontWidths?.get(first.fontName);
    if (!metrics) {
      return refusal(
        "FALLBACK_FONT_METRICS_UNAVAILABLE",
        `Text is drawn after this match, so the width it occupied has to be measured to keep that text where it is -- but this document does not state the glyph widths of font /${first.fontName} in a form this engine can read exactly (a /Widths or /W array it can resolve). Nothing is estimated, so this replacement is refused.`,
        stream.fontWidthReasons?.get(first.fontName)
      );
    }
    if (splits.some((split) => !split)) {
      return refusal(
        "FALLBACK_FONT_METRICS_UNAVAILABLE",
        "The exact character codes this match is drawn with could not be recovered from the operand it sits in, so the width it occupies cannot be measured and the text after it cannot be kept in place",
        "operand-codes-unrecoverable"
      );
    }
    let width = 0;
    let glyphCount = 0;
    let spaceCount = 0;
    for (const split of splits) {
      const measured = measureCodes(metrics, split.bytes.matched);
      if (!measured) {
        return refusal("FALLBACK_FONT_METRICS_UNAVAILABLE", `This document does not give a width for every character code this match is drawn with in font /${first.fontName}, so the width it occupies cannot be measured`, "code-width-unavailable");
      }
      width += measured.width;
      glyphCount += measured.glyphs;
      spaceCount += measured.spaces;
    }
    const spacings = new Set(pieces.map((piece) => piece.run.charSpacing));
    const charSpacing = spacings.size === 1 ? [...spacings][0] : null;
    if (charSpacing === null || charSpacing === undefined) {
      return refusal("FALLBACK_CHAR_SPACING_UNSUPPORTED", "The character spacing (Tc) in force where this match is drawn could not be determined, so the width it occupies cannot be measured");
    }
    if (charSpacing !== 0 && glyphCount !== glyphs.length) {
      return refusal(
        "FALLBACK_CHAR_SPACING_UNSUPPORTED",
        `Character spacing (Tc ${charSpacing}) is in force and this replacement draws ${glyphs.length} glyphs where the original drew ${glyphCount}, so the text after it would move by the difference in spacing. A replacement drawing exactly ${glyphCount} glyphs is written normally.`
      );
    }
    if (spaceCount > 0 && pieces.some((piece) => piece.run.wordSpacing !== 0)) {
      return refusal(
        "FALLBACK_WORD_SPACING_UNSUPPORTED",
        "This match contains a single-byte space and word spacing (Tw) is in force, which does not reach text written through the fallback font, so the text after the match would move. Edit text drawn without word spacing, or a match that does not span a space."
      );
    }
    const replacementWidth = glyphs.reduce((sum, glyph) => sum + glyphSpaceWidth(fallback, glyph.advanceWidth), 0);
    // availableAdvance is "how far the original text advanced from the start of the match
    // to where the next unmoved text actually begins". `width - between` is only part of
    // that: it is where the match's OWN text ended, not where the next glyph starts, and
    // those two differ whenever a TJ number sits between them -- in the same array's tail
    // (`[(match) 50 (next)] TJ`), or at the very start of a later `TJ`'s own array
    // (`[(match)] TJ [50 (next)] TJ`). Missing that term let a match's own trailing
    // adjustment mask an overflow entirely: `[(令和) 50 (8年度)] TJ` measured availableAdvance
    // as 2000 (令和's own width) when 8年度 actually starts at 1950, and a 2000-wide
    // replacement was let through onto the 50 units of 8年度 it would be drawn over.
    //
    // That gap is exactly the next run's own `displacement` -- the running total of PDF
    // numbers scanTextRuns() (src/content-stream.js) accumulates towards whatever string
    // collects them next, reset to 0 by any operator that consumes a pending number as
    // its OWN operand instead (`Tc`, `rg`, and -- critically -- `Tf`'s own font size).
    // That reset is what keeps this exact whether the run's `joinBefore` reads
    // "tj-array", "adjacent-operator", or "state-change": a font restore between a
    // fallback replacement and the following text -- `/Fallback size Tf [...] TJ
    // /Original size Tf [50 (next)] TJ`, exactly what this engine's own TJ rewrite
    // writes, and so exactly what re-editing an already-rewritten match reopens into --
    // is a `joinBefore` "state-change" (a font switch, like any other operator between
    // two text-showing ones, marks the boundary unclean) yet the "50" is still read
    // correctly, because `displacement` does not depend on that classification at all.
    // When the match's own run still has a suffix (a partial match with more of the same
    // operand after it, e.g. 令和 inside 申請令和です), that suffix -- not the next run --
    // is what follows immediately, at zero gap, unaffected by any later displacement, so
    // this is skipped for it.
    let followingAdjustment = 0;
    if (suffix === "") {
      const nextRun = stream.runs[Number(lastEntry.runId.split(":")[1]) + 1];
      if (!nextRun) {
        // Something in this text flow depends on this position (that is why this branch
        // runs at all), but no following text-showing operand could be found at all --
        // this content stream ends inside the open text object, and whatever continues
        // it (perhaps a later content stream of the same page) is not something this can
        // see. Nothing is estimated, so this replacement is refused.
        return refusal(
          "FALLBACK_LAYOUT_UNSUPPORTED",
          "Text is drawn after this match, but this document does not state exactly how far away it starts, so whether the replacement would be drawn over it cannot be established. Nothing is estimated, so this replacement is refused.",
          "fallback-replacement-slot-unknown"
        );
      }
      followingAdjustment = nextRun.displacement;
    }
    const availableAdvance = width - between - followingAdjustment;
    if (replacementWidth > availableAdvance) {
      return refusal(
        "FALLBACK_LAYOUT_UNSUPPORTED",
        `This replacement would be ${replacementWidth} glyph-space units wide in the fallback font, but only ${availableAdvance} units are available before text that must keep its position -- so the replacement's own glyphs would be drawn over that text. Nothing is moved, shrunk, or reflowed to make room; a shorter replacement is written normally.`,
        "fallback-replacement-overflows-slot",
        { replacementAdvance: replacementWidth, availableAdvance }
      );
    }
    const value = replacementWidth - width + between;
    const formatted = formatAdjustment(value);
    // The invariant the whole rewrite rests on, checked rather than trusted: what the
    // replacement advances, after its adjustment, is what the original advanced.
    if (formatted === null || replacementWidth - Number(formatted) !== width - between) {
      return refusal(
        "FALLBACK_FONT_METRICS_UNAVAILABLE",
        "The width this match occupies cannot be matched exactly by a TJ adjustment, so the text after it would move",
        "adjustment-not-representable"
      );
    }
    adjustment = formatted;
  }

  return { region, head, tail, prefix, suffix, adjustment };
}

/**
 * Writes the rewrite planTextArrayRewrite() decided on back into content-stream bytes, as
 * one replacement spanning the whole stretch of `TJ` operators the match is drawn by.
 *
 * Every element outside the match is copied out of the original stream verbatim -- the one
 * exception being a string operand carrying an ordinary replacement already staged on the
 * same run, which is folded in here (as the `Tj` rewrite does) rather than left to be
 * applied separately over bytes this edit has replaced.
 *
 * Every run whose operand fell inside the rewritten stretch is reported back in `runTexts`,
 * both so search keeps showing what the page now draws and so the planner knows those runs'
 * recorded byte offsets have been superseded (see FALLBACK_EDIT_REQUIRES_SAVE).
 */
function buildTextArrayEdit(editor, pieces, array, glyphs, resourceName, replacement) {
  const stream = pieces[0].stream;
  const first = pieces[0];
  const size = first.run.fontSize;
  const mappings = stream.fontMaps.get(first.run.fontName);
  const runIds = new Map(stream.runs.map((run, index) => [run.start, `${stream.object.number}:${index}`]));
  const runTexts = [];
  const verbatim = (element) => latin1.decode(stream.decoded.subarray(element.start, element.end));
  const kept = (element) => {
    if (element.kind === "number") return verbatim(element);
    const runId = runIds.get(element.start);
    const pending = runId === undefined ? undefined : editor.pending.get(runId);
    if (runId !== undefined) runTexts.push([runId, decodeWithCMap(pending ?? element.value, mappings)]);
    if (!pending) return verbatim(element);
    return latin1.decode(element.syntax === "hex" ? encodeHex(pending) : encodeLiteral(pending));
  };
  const operand = (piece, text) => latin1.decode(
    piece.run.syntax === "hex"
      ? encodeHex(encodeReplacement(editor, piece.entry, text))
      : encodeLiteral(encodeReplacement(editor, piece.entry, text))
  );

  const leading = array.head.map(kept);
  if (array.prefix) leading.push(operand(first, array.prefix));
  const drawn = [];
  if (leading.length) drawn.push(`[${leading.join(" ")}] TJ`);
  drawn.push(`/${resourceName} ${size} Tf [${latin1.decode(encodeHex(identityEncode(glyphs)))}] TJ /${first.run.fontName} ${size} Tf`);
  const trailing = [];
  // A zero adjustment displaces nothing, so it is simply not written.
  if (array.adjustment !== null && Number(array.adjustment) !== 0) trailing.push(array.adjustment);
  if (array.suffix) trailing.push(operand(pieces.at(-1), array.suffix));
  trailing.push(...array.tail.map(kept));
  if (trailing.length) drawn.push(`[${trailing.join(" ")}] TJ`);

  pieces.forEach((piece, index) => {
    const text = pieces.length === 1
      ? array.prefix + replacement + array.suffix
      : (index === 0 ? array.prefix + replacement : (index === pieces.length - 1 ? array.suffix : ""));
    runTexts.push([piece.entry.runId, text]);
  });

  return {
    objectNumber: stream.object.number,
    start: array.region.start,
    end: array.region.end,
    bytes: encoder.encode(drawn.join(" ")),
    runTexts
  };
}

/**
 * Which of the caller's fallback fonts to draw a replacement in, given what the source run's
 * own font classified as (see font-classification.js). "serif" is chosen only when a serif
 * fallback font was actually supplied; every other case -- "sans", "unknown", or "serif"
 * with no serif font registered -- falls back to "sans", which is also what setFallbackFont()
 * (the single-font, back-compat API) always registers. That is what keeps a caller who has
 * only ever called setFallbackFont() behaving exactly as before this existed: with only
 * "sans" ever registered, every match routes to it regardless of classification.
 *
 * Relies on an invariant enforced at registration time (see setFallbackFonts()): "sans" is
 * registered before, or together with, "serif" -- never "serif" alone. So whenever
 * `editor.fallbackFonts` is non-empty (the only condition planTextMatchReplacement() calls
 * this under), "sans" is always in it, and the "sans"/"unknown" branch below never has to
 * fall through to "serif" for lack of anything else -- which would silently draw sans-
 * classified or unclassifiable text in a serif-looking font, the opposite of the v0.4.4
 * fallback this exists to preserve.
 */
function selectFallbackFont(editor, classification) {
  if (classification === "serif" && editor.fallbackFonts.has("serif")) {
    return { role: "serif", fallback: editor.fallbackFonts.get("serif") };
  }
  return { role: "sans", fallback: editor.fallbackFonts.get("sans") };
}

/**
 * Plans a replacement written through the fallback font, for a match the document's own
 * font cannot express. One of two rewrites, chosen by the operator that draws the match.
 *
 * **Drawn by `Tj`** (v0.4.0, unchanged). The pieces are simply drawn one after another and
 * each `Tj` continues where the last left off (verified against pdf.js: splitting a `Tj`
 * and re-stating the same font between the pieces draws the identical page, under
 * `Tc`/`Tw`/`Tz`/`Ts` alike). The match's first run becomes
 *
 *     <prefix> Tj  /Fallback size Tf  <replacement> Tj  /Original size Tf
 *
 * any run wholly inside the match is emptied, and the last run keeps its suffix. So the
 * replacement is drawn where the match began, the text after it flows on from the
 * replacement's own width -- which is what editing text should do -- and no width, matrix
 * or spacing arithmetic is involved anywhere. What has to hold, and is refused otherwise:
 *
 * - the runs are adjacent (the v0.3.0 rule: no state change and no net `TJ` displacement
 *   between them), so emptying the ones inside the match moves nothing.
 * - nothing is drawn from where the match's last run ends. The replacement's width is not
 *   the original's, so anything continuing from there would move. An `ET`, a `BT`, or an
 *   explicit `Td`/`TD`/`Tm`/`T*` all settle it; a following `Tj` does not.
 *
 * **Drawn by `TJ`** (v0.4.1). The array's own displacements are kept and one adjustment is
 * computed from both fonts' stated widths, so everything after the match stays exactly
 * where the PDF put it -- see planTextArrayRewrite() above for the arithmetic and for
 * everything it refuses rather than estimate.
 *
 * Either way: `'` and `"` carry a line move neither rewrite accounts for, a match split
 * between a `Tj` and a `TJ` would have to be both rewrites at once, and the runs must
 * share one font and one size so there is a single font to restore.
 */
async function planFallbackReplacement(editor, match, replacement) {
  const pieces = scannedRuns(editor, match.span);
  if (pieces.some(({ run }) => !run)) return refusal("MATCH_STALE", "This match no longer describes the document");
  // Which of the caller's fallback fonts looks closest to the run being replaced -- see
  // selectFallbackFont() for what decides it, and font-classification.js for how "serif"
  // and "sans" are read from the source font's own FontDescriptor. Every safety judgement
  // below is unchanged by which font this picks: it always measures the font actually
  // selected, exactly as a single caller-supplied fallback font was measured before this
  // existed.
  const classification = pieces[0].stream.fontClassifications?.get(pieces[0].run.fontName) ?? "unknown";
  const selected = selectFallbackFont(editor, classification);
  const { role, fallback } = selected;

  const operators = new Set(pieces.map(({ run }) => run.operator));
  // `TJ` is rewritten by planTextArrayRewrite() above, which keeps the array's own
  // displacements and the position of everything after the match; `Tj` by the simpler
  // rewrite documented below. A match mixing the two would have to be both at once, and
  // `'`/`"` carry a line move neither accounts for.
  const drawnByArray = operators.size === 1 && operators.has("TJ");
  if (!drawnByArray && !(operators.size === 1 && operators.has("Tj"))) {
    const other = pieces.find(({ run }) => run.operator !== "Tj");
    return refusal(
      "FALLBACK_OPERATOR_UNSUPPORTED",
      operators.size > 1
        ? `The fallback font is written with Tj or TJ; this match mixes ${[...operators].join(" and ")}`
        : `The fallback font is written with Tj and TJ; this match is drawn by ${other.run.operator}`
    );
  }
  // The fallback font is embedded with a horizontal encoding (/Identity-H). Putting it in
  // place of text a vertical font drew would lay that text out along the wrong axis. What
  // matters is the font's own writing mode, not how the page is rotated -- a horizontal
  // font under a rotated text matrix is still horizontal (see writingModeOf()).
  const sideways = pieces.find(({ stream, run }) => (stream.fontModes?.get(run.fontName) ?? "unknown") !== "horizontal");
  if (sideways) {
    const mode = sideways.stream.fontModes?.get(sideways.run.fontName) ?? "unknown";
    return refusal(
      "FALLBACK_WRITING_MODE_UNSUPPORTED",
      mode === "vertical"
        ? "This text is drawn with a vertical writing font, and the fallback font is embedded for horizontal writing, so it cannot stand in for it"
        : "This text's font does not say whether it writes horizontally or vertically, and the fallback font is embedded for horizontal writing, so it cannot safely stand in for it"
    );
  }
  const sizes = new Set(pieces.map(({ run }) => run.fontSize));
  if (sizes.size > 1 || sizes.has(null) || sizes.has(undefined)) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "This match has no single /Tf font size to restore after the fallback font");
  }
  if (pieces.some(({ run }) => !run.fontName)) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "This match has no /Tf font to restore after the fallback font");
  }
  // A `Tj` rewrite simply draws the pieces one after another, so the operands it spans have
  // to be adjacent already. The `TJ` rewrite does not need that -- it accounts for the
  // displacements between them -- and applies its own, narrower rule (see
  // planTextArrayRewrite()).
  if (!drawnByArray && match.span.length > 1) {
    const current = new Map(internalRuns(editor).map((run) => [run.id, run]));
    const obstacle = variableLengthObstacle(match.span, current);
    if (obstacle) {
      return refusal("FALLBACK_MULTI_RUN_UNSUPPORTED", `This match is drawn as ${match.span.length} text runs that are not simply adjacent (${obstacle}), so it cannot be redrawn in another font as one piece`, obstacle);
    }
  }
  // Word spacing reaches single-byte code 32 only, and the fallback font is written
  // through a 2-byte encoding -- measured against pdf.js: a `Tw` that visibly moves simple
  // font text leaves an Identity-H string exactly where it was. So a replacement holding a
  // space would not be spaced the way the rest of the document's spaces are.
  if ([...replacement].includes(" ") && pieces.some(({ run }) => run.wordSpacing !== 0)) {
    return refusal(
      "FALLBACK_WORD_SPACING_UNSUPPORTED",
      "This text is drawn with word spacing (Tw) in force, which does not reach text written through the fallback font, so a replacement containing a space would be spaced differently from the rest of the document. Replace without a space, or edit text drawn without word spacing."
    );
  }

  const { glyphs, missing } = glyphsFor(fallback, replacement);
  if (missing) {
    return { ...refusal("FALLBACK_FONT_MISSING_GLYPH", `The fallback font has no glyph for ${missing.map((character) => JSON.stringify(character)).join(", ")}`), characters: missing };
  }

  const last = pieces.at(-1).run;
  let array = null;
  if (drawnByArray) {
    array = planTextArrayRewrite(editor, pieces, glyphs, fallback);
    if (array.allowed === false) return array;
  } else if (!POSITION_SAFE_AFTER.has(last.followedBy)) {
    return refusal(
      "FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE",
      `Text is drawn from where this match ends (${last.followedBy}), and the fallback font's characters are not the widths the document's own font used, so that text would move. Only a match followed by ET or an explicit Td/TD/Tm/T* is redrawn in another font.`
    );
  }

  // A working copy of what has been embedded so far, for this one fallback font (there may
  // be more than one now -- see setFallbackFonts()). Planning must not touch the editor's
  // own record: checkTextMatchReplacement() runs this too, and if it marked a page as
  // already carrying the font, the replaceTextMatch() that followed would skip adding it --
  // writing a content stream that names a font the page's /Resources never got. Object
  // numbers are carried over, so replacing ten runs still embeds one font.
  const base = editor.fallbackEmbeddings.get(role) ?? await adoptExistingFallbackFont(editor, fallback);
  const start = Math.max(editor.document.size, ...[...editor.pendingObjects.keys()].map((number) => number + 1));
  const embedded = {
    numbers: base?.numbers ?? { type0: start, cidFont: start + 1, descriptor: start + 2, fontFile: start + 3, toUnicode: start + 4 },
    glyphs: new Map(base?.glyphs),
    // True once the font program is in the file, whether this session put it there or an
    // earlier one did: from then on only the widths and the ToUnicode CMap are rewritten.
    programAlreadyEmbedded: Boolean(base)
  };

  // Page resource names, shared across every fallback font this document embeds -- not
  // just this one -- so two different fallback fonts registered on the same page never
  // collide on the name given to either (see registerFallbackResource()). Copied so
  // planning does not touch the editor's persisted record until commitPlan() runs, for the
  // same reason `embedded` above is a working copy.
  const pageResources = new Map([...editor.fallbackPageResources].map(([number, names]) => [number, new Map(names)]));
  if (base?.resources) {
    for (const [pageNumber, name] of base.resources) {
      if (!pageResources.has(pageNumber)) pageResources.set(pageNumber, new Map());
      if (!pageResources.get(pageNumber).has(fallback.digest)) pageResources.get(pageNumber).set(fallback.digest, name);
    }
  }

  const objects = new Map();
  const resourceNames = new Map();
  for (const { stream } of pieces) {
    const registered = await registerFallbackResource(editor, fallback.digest, embedded.numbers.type0, pageResources, stream.resources);
    if (registered.allowed === false) return registered;
    resourceNames.set(stream.object.number, registered.name);
    if (registered.object) objects.set(registered.object.number, registered.object);
  }

  for (const glyph of glyphs) embedded.glyphs.set(glyph.glyphId, glyph);

  // Encode every piece before anything is staged, so a prefix or suffix the original font
  // cannot write fails here rather than half-way through.
  const edits = [];
  try {
    if (array) edits.push(buildTextArrayEdit(editor, pieces, array, glyphs, resourceNames.get(pieces[0].stream.object.number), replacement));
    else pieces.forEach(({ stream, run, entry }, index) => {
      const points = [...entry.runText];
      const prefix = points.slice(0, entry.charStart).join("");
      const suffix = points.slice(entry.charEnd).join("");
      const size = run.fontSize;
      const name = resourceNames.get(stream.object.number);
      const operand = (bytes) => latin1.decode(run.syntax === "hex" ? encodeHex(bytes) : encodeLiteral(bytes));
      if (index === 0) {
        const drawn = [];
        if (prefix) drawn.push(`${operand(encodeReplacement(editor, entry, prefix))} Tj`);
        drawn.push(`/${name} ${size} Tf ${latin1.decode(encodeHex(identityEncode(glyphs)))} Tj /${run.fontName} ${size} Tf`);
        // The suffix of a single-run match follows the replacement in the same operator.
        if (pieces.length === 1 && suffix) drawn.push(`${operand(encodeReplacement(editor, entry, suffix))} Tj`);
        edits.push({
          objectNumber: stream.object.number,
          start: run.start,
          end: run.operatorEnd,
          bytes: encoder.encode(drawn.join(" ")),
          runId: entry.runId,
          runText: prefix + replacement + (pieces.length === 1 ? suffix : "")
        });
      } else if (index === pieces.length - 1) {
        // The last run keeps only what lay outside the match; it is drawn where the
        // replacement ended, which is where it was drawn before.
        edits.push({ objectNumber: stream.object.number, start: run.start, end: run.end, bytes: encodeReplacement(editor, entry, suffix), operandOnly: true, runId: entry.runId, runText: suffix });
      } else {
        edits.push({ objectNumber: stream.object.number, start: run.start, end: run.end, bytes: new Uint8Array(), operandOnly: true, runId: entry.runId, runText: "" });
      }
    });
  } catch (error) {
    return { ...refusal("FONT_ENCODING_UNSUPPORTED", error.message), cause: error };
  }

  const mode = match.span.length > 1
    ? REPLACEMENT_MODE.fallbackFontMultiRun
    : (pieces[0].entry.charStart === 0 && pieces[0].entry.charEnd === [...pieces[0].entry.runText].length
      ? REPLACEMENT_MODE.fallbackFont
      : REPLACEMENT_MODE.fallbackFontPartial);

  for (const [number, object] of await buildFallbackFontObjects(fallback, embedded.numbers, embedded.glyphs, { programAlreadyEmbedded: embedded.programAlreadyEmbedded, serif: role === "serif" })) {
    objects.set(number, object);
  }
  return {
    allowed: true,
    mode,
    updates: [],
    fallback: { role, classification, sourceFontName: pieces[0].run.fontName, embedding: embedded, pageResources, objects, edits }
  };
}

/**
 * The single decision point for "may this match be replaced by this text, and with what
 * written where". Both checkTextMatchReplacement() and replaceTextMatch() go through it,
 * so a caller can never be told a replacement is allowed and then have it refused --
 * they are literally the same verdict, including the font encoding, which is attempted
 * here rather than left to fail later.
 *
 * Returns `{ allowed: false, code, reason, unsafeReason? }`, or `{ allowed: true, mode,
 * updates }` where `updates` is every run to rewrite, already encoded. Nothing is staged
 * here: the caller commits `updates` in one go, so a refusal -- or a character the font
 * cannot express -- leaves the document exactly as it was rather than half replaced.
 */
async function planTextMatchReplacement(editor, matchId, replacement) {
  // /P's modify permission is a property of the PDF, checked on every attempt: finding
  // text is a reading capability, changing it is not. Reported rather than thrown so
  // checkTextMatchReplacement() can tell a caller up front that editing is not allowed.
  if (editor.security && editor.security.modifyAllowed === false) {
    return refusal("MODIFICATION_NOT_PERMITTED", "Document modification is not permitted: this PDF's /P permissions disallow content changes (modify permission denied)");
  }
  if (typeof replacement !== "string") {
    return refusal("REPLACEMENT_NOT_A_STRING", "replaceTextMatch() takes the replacement as a string; use replaceText() to write raw font-encoded bytes to a single run");
  }
  const match = editor.matches.get(matchId);
  if (!match) {
    return refusal("UNKNOWN_MATCH", `Unknown search match: ${matchId} (match ids come from this editor's most recent searchText() call and are superseded by the next one)`);
  }

  const current = new Map(internalRuns(editor).map((run) => [run.id, run]));
  for (const entry of match.span) {
    if (current.get(entry.runId)?.text !== entry.runText) {
      return refusal("MATCH_STALE", `This match is stale: the text it was found in has changed since searchText() returned it (run ${entry.runId}). Search again and replace the new match.`);
    }
  }
  // A run a fallback rewrite has replaced is no longer described by the byte offsets
  // every plan here works from: the operator it came from has been rewritten into
  // several. Editing it again would write over the rewrite rather than after it.
  const rewritten = match.span.find((entry) => editor.fallbackRunTexts.has(entry.runId));
  if (rewritten) {
    return refusal(
      "FALLBACK_EDIT_REQUIRES_SAVE",
      `Text run ${rewritten.runId} has already been rewritten with the fallback font, which restructured the operators it was drawn by. Save this document and reopen it to edit that text again.`
    );
  }

  const replacementPoints = [...replacement];
  let mode;
  let chunks;
  if (match.span.length === 1) {
    // One operand: rewritten whole, so its length was never constrained.
    mode = REPLACEMENT_MODE.singleRun;
    chunks = [replacementPoints];
  } else {
    const fonts = new Set(match.span.map((entry) => entry.fontName));
    if (fonts.size > 1) {
      return refusal("MULTI_RUN_FONT_CHANGE_UNSUPPORTED", `This match spans ${fonts.size} fonts; replacing it would have to encode its characters through more than one font, which is not supported`);
    }
    const matchLength = [...match.text].length;
    if (!replacementPoints.length) {
      // Deletion, unchanged from v0.2.1: every run keeps its own prefix and suffix and
      // gives up only its share of the match, so no character moves between operands.
      mode = REPLACEMENT_MODE.delete;
      chunks = match.span.map(() => []);
    } else if (replacementPoints.length === matchLength) {
      // Equal length, unchanged from v0.2.1: each run gets back exactly as many
      // characters as it contributed, so the original operand boundaries survive and
      // nothing depends on what sits between them.
      mode = REPLACEMENT_MODE.sameLength;
      let cursor = 0;
      chunks = match.span.map((entry) => {
        const contributed = entry.charEnd - entry.charStart;
        const chunk = replacementPoints.slice(cursor, cursor + contributed);
        cursor += contributed;
        return chunk;
      });
    } else {
      const obstacle = variableLengthObstacle(match.span, current);
      if (obstacle) {
        return refusal(
          "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED",
          `This match is drawn as ${match.span.length} separate text runs, so a replacement of ${replacementPoints.length} characters cannot be written over ${matchLength} without moving text relative to the PDF's own spacing (${obstacle}). Use an equal-length replacement, or an empty one to delete.`,
          obstacle
        );
      }
      // Safe topology: the whole replacement goes into the first operand and the rest of
      // the match's operands are emptied. Operand count, operator structure and every
      // adjustment stay exactly as they were.
      mode = REPLACEMENT_MODE.variableLength;
      chunks = match.span.map((_, index) => (index === 0 ? replacementPoints : []));
    }
  }

  const updates = [];
  try {
    match.span.forEach((entry, index) => {
      const points = [...entry.runText];
      const text = points.slice(0, entry.charStart).join("") + chunks[index].join("") + points.slice(entry.charEnd).join("");
      if (text === entry.runText) return;
      updates.push({ id: entry.runId, bytes: encodeReplacement(editor, entry, text) });
    });
  } catch (error) {
    // A character the document's own font has no code for. When the caller has supplied a
    // fallback font, that is exactly what it is for; otherwise this stands as the refusal
    // it has always been, so an editor with no fallback font behaves as it did in v0.3.0.
    const characters = charactersOutsideFont(editor, match.span[0], replacement);
    if (!editor.fallbackFonts.size) {
      return { ...refusal("FONT_ENCODING_UNSUPPORTED", error.message), characters, cause: error };
    }
    const viaFallback = await planFallbackReplacement(editor, match, replacement);
    if (viaFallback.allowed) return viaFallback;
    // The fallback font could not help either. Its reason is the useful one -- it says
    // what about this position or this text stopped it -- so it is the one reported.
    return { ...viaFallback, characters: viaFallback.characters ?? characters };
  }
  return { allowed: true, mode, updates };
}

/**
 * Applies a plan's staging in one go. Called only once the whole plan is built and every
 * byte of it encoded, so a refusal -- or a character no font can write -- leaves the
 * editor exactly as it was.
 */
function commitPlan(editor, plan) {
  if (!plan.fallback) {
    for (const { id, bytes } of plan.updates) editor.pending.set(id, bytes);
    return;
  }
  // Every rewritten stream is built first, so a stream that cannot be rebuilt leaves the
  // editor exactly as it was rather than half updated.
  const edits = new Map();
  for (const [objectNumber, existing] of editor.fallbackEdits) edits.set(objectNumber, [...existing]);
  for (const edit of plan.fallback.edits) {
    edits.set(edit.objectNumber, [...(edits.get(edit.objectNumber) ?? []), edit]);
  }
  const rebuilt = new Map();
  for (const objectNumber of new Set(plan.fallback.edits.map((edit) => edit.objectNumber))) {
    rebuilt.set(objectNumber, rebuildContentStream(editor, objectNumber, edits.get(objectNumber)));
  }

  for (const { id, bytes } of plan.updates) editor.pending.set(id, bytes);
  editor.fallbackEmbeddings.set(plan.fallback.role, plan.fallback.embedding);
  editor.fallbackPageResources = plan.fallback.pageResources;
  for (const [number, object] of plan.fallback.objects) editor.pendingObjects.set(number, object);
  editor.fallbackEdits = edits;
  for (const [objectNumber, bytes] of rebuilt) editor.pendingStreams.set(objectNumber, bytes);
  for (const edit of plan.fallback.edits) {
    if (edit.runId !== undefined) editor.fallbackRunTexts.set(edit.runId, edit.runText);
    // A TJ rewrite spans a whole stretch of operators, so it supersedes every run inside
    // it -- the match's own operands and any neighbouring operand it copied through.
    for (const [runId, text] of edit.runTexts ?? []) editor.fallbackRunTexts.set(runId, text);
  }
}

/**
 * Rebuilds one content stream from its original decoded bytes, applying every fallback
 * rewrite recorded for it plus any ordinary run-level edit staged on the same stream --
 * so a whole-stream replacement never silently drops the latter. Rebuilding from the
 * original each time keeps the recorded offsets valid however many edits accumulate.
 */
function rebuildContentStream(editor, objectNumber, fallbackEdits) {
  const stream = editor.streams.find((candidate) => candidate.object.number === objectNumber);
  // A fallback rewrite of a run supersedes any ordinary edit staged on that same run: the
  // rewrite was planned from the run's current text, so it already contains that edit.
  // Matched by run id rather than by byte range, because a rewrite of the match's first
  // run spans its whole operator (run.start..run.operatorEnd) while an ordinary edit spans
  // only the operand (run.start..run.end) -- comparing ranges leaves both in place, and
  // they then overlap.
  const rewritten = new Set(fallbackEdits.flatMap((edit) => [
    ...(edit.runId === undefined ? [] : [edit.runId]),
    ...(edit.runTexts ?? []).map(([runId]) => runId)
  ]));
  const runEdits = stream.runs.flatMap((run, index) => {
    const id = `${objectNumber}:${index}`;
    const bytes = editor.pending.get(id);
    if (!bytes || rewritten.has(id)) return [];
    return [{ start: run.start, end: run.end, bytes: run.syntax === "hex" ? encodeHex(bytes) : encodeLiteral(bytes) }];
  });
  const ordered = [...fallbackEdits, ...runEdits]
    .map((edit) => ({ ...edit, bytes: edit.operandOnly ? (stream.runs.find((run) => run.start === edit.start)?.syntax === "hex" ? encodeHex(edit.bytes) : encodeLiteral(edit.bytes)) : edit.bytes }))
    .sort((a, b) => a.start - b.start);
  const chunks = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) throw new Error("Two edits to one content stream overlap");
    chunks.push(stream.decoded.subarray(cursor, edit.start), edit.bytes);
    cursor = edit.end;
  }
  chunks.push(stream.decoded.subarray(cursor));
  return concat(chunks);
}

function planError(plan) {
  const error = new Error(plan.reason);
  error.code = plan.code;
  if (plan.unsafeReason) error.unsafeReason = plan.unsafeReason;
  if (plan.characters?.length) error.characters = plan.characters;
  if (plan.diagnostics) error.diagnostics = plan.diagnostics;
  if (plan.cause) error.cause = plan.cause;
  return error;
}

function concat(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Decrypts (when `security` is set -- an authenticated encrypted PDF) and then
 * inflates one stream object's bytes. Decryption always runs before FlateDecode:
 * the PDF spec encrypts the *filtered* stream bytes, so a Crypt Filter is
 * conceptually the outermost filter, applied first on read (and would be the last
 * one applied on write, which is exactly why save() refuses encrypted PDFs instead
 * of re-encrypting -- see PdfTextEditor#save()).
 */
async function decodeStream(object, kind, security) {
  const data = security
    ? await decryptStreamBytes(security, { objectNumber: object.number, generation: object.generation, bytes: object.data })
    : object.data;
  return decodeStreamBytes(object.dictionary, data, `${kind} object ${object.number}`);
}

function replacementDictionary(dictionary, length) {
  // save() re-deflates the decoded (already predictor-reversed) content directly,
  // without re-applying any predictor (see save()'s comment). A /DecodeParms carried
  // over from the original stream would tell a reader reopening this file to reverse
  // a predictor that the new bytes were never encoded with, so it is dropped here.
  const withoutDecodeParms = dictionary
    .replace(/\/DecodeParms\s*\[\s*<<[\s\S]*?>>\s*\]/, "")
    .replace(/\/DecodeParms\s*<<[\s\S]*?>>/, "");
  if (/\/Length\s+\d+\s+\d+\s+R/.test(withoutDecodeParms)) return withoutDecodeParms.replace(/\/Length\s+\d+\s+\d+\s+R/, `/Length ${length}`);
  if (/\/Length\s+\d+/.test(withoutDecodeParms)) return withoutDecodeParms.replace(/\/Length\s+\d+/, `/Length ${length}`);
  return withoutDecodeParms.replace(/>>\s*$/, `/Length ${length} >>`);
}

// The /Font sub-dictionary of /Resources can itself be an indirect object, and
// (like Resources, Pages, and Page) that indirect object can be compressed inside
// an Object Stream -- so this resolves it the same way pageContentObjects() does.
async function fontReferences(resources, structure, security) {
  const indirect = reference(resources.dictionary, "Font");
  const fontDictionary = indirect
    ? (await structure.resolveObject(indirect, security, decryptStreamBytes)).dictionary
    : resources.dictionary.match(/\/Font\s*<<(.*?)>>/s)?.[1] ?? "";
  return new Map([...fontDictionary.matchAll(/\/([^\s/<>{}\[\]()]+)\s+(\d+)\s+(\d+)\s+R/g)].map((match) => [
    match[1], { number: Number(match[2]), generation: Number(match[3]) }
  ]));
}

/**
 * Whether a font lays text out horizontally, vertically, or in a way this cannot tell.
 *
 * It is the font's own writing mode that matters, not how the page happens to be
 * rotated: a horizontal font under a rotated text matrix is still horizontal. A simple
 * (non-composite) font is always horizontal. A Type0 font's `/Encoding` decides it --
 * a predefined CMap name ends in `-H` or `-V`, and an embedded CMap stream carries
 * `/WMode`. Anything that does not say is reported as unknown rather than assumed,
 * because the fallback font is written through a horizontal encoding and putting it in
 * place of vertical text would lay that text out along the wrong axis.
 */
function writingModeOf(fontDictionary, structure) {
  if (!/\/Subtype\s*\/Type0\b/.test(fontDictionary)) return "horizontal";
  const named = fontDictionary.match(/\/Encoding\s*\/([^\s/<>[\]()]+)/);
  if (named) {
    if (/-V$/.test(named[1])) return "vertical";
    return /-H$/.test(named[1]) ? "horizontal" : "unknown";
  }
  const indirect = reference(fontDictionary, "Encoding");
  if (!indirect) return "unknown";
  try {
    // A CMap is always a stream, so it is never inside an Object Stream (PDF 7.5.7).
    const object = structure.object(indirect);
    // The name may itself be written as an indirect object, and says as much as a direct
    // one does: a predefined CMap's name ends in -H or -V.
    if (!object.dictionary && typeof object.rawValue === "string" && object.rawValue.startsWith("/")) {
      if (/-V$/.test(object.rawValue)) return "vertical";
      return /-H$/.test(object.rawValue) ? "horizontal" : "unknown";
    }
    const wmode = object.dictionary.match(/\/WMode\s+(\d+)/);
    if (!wmode) return "unknown";
    return wmode[1] === "1" ? "vertical" : "horizontal";
  } catch {
    return "unknown";
  }
}

async function loadFontMaps(resources, structure, security) {
  const result = new Map();
  const modes = new Map();
  const widths = new Map();
  // Why a font's widths could not be read, when they could not (see FONT_METRICS_REASONS).
  // Structure only, never content: it travels no further than the `unsafeReason` beside a
  // FALLBACK_FONT_METRICS_UNAVAILABLE refusal, so a caller can tell an indirect object
  // this could not resolve from a font whose widths the file never states at all.
  const widthReasons = new Map();
  // "serif" / "sans" / "unknown", from the font's own FontDescriptor -- see
  // font-classification.js. Read here because this is where every font a page's text runs
  // could be drawn in is already being resolved once; a fallback replacement (see
  // selectFallbackFont() in planFallbackReplacement()) looks this up by the source run's
  // font name exactly as it looks up fontModes and fontWidths.
  const classifications = new Map();
  // A font dictionary can itself be compressed (a common PDF-writer optimization);
  // its own /ToUnicode target, however, is always a stream, and streams are never
  // stored in an Object Stream (PDF spec 7.5.7), so that lookup stays on the
  // synchronous, unchanged structure.object().
  for (const [name, fontReference] of await fontReferences(resources, structure, security)) {
    const font = await structure.resolveObject(fontReference, security, decryptStreamBytes);
    const resolve = (target) => structure.resolveObject(target, security, decryptStreamBytes);
    modes.set(name, writingModeOf(font.dictionary, structure));
    classifications.set(name, await classifyFontResource(font.dictionary, resolve));
    // The widths a reader positions this font's text with, when they can be read exactly.
    // Only the TJ fallback rewrite needs them, and only when it has to keep following text
    // where it is; null here simply means that rewrite refuses (see loadFontWidths()).
    const { metrics, reason } = await describeFontWidths(font.dictionary, resolve);
    if (metrics) widths.set(name, metrics);
    else widthReasons.set(name, reason);
    const toUnicode = reference(font.dictionary, "ToUnicode");
    if (!toUnicode) continue;
    const cmapObject = structure.object(toUnicode);
    result.set(name, parseToUnicodeCMap(await decodeStream(cmapObject, "ToUnicode stream", security)));
  }
  return { maps: result, modes, widths, widthReasons, classifications };
}

/**
 * How each of this document's font resources states its glyph widths, and -- when they
 * cannot be read exactly -- which structure defeated it (see FONT_METRICS_REASONS in
 * font-metrics.js).
 *
 * Developer-facing and deliberately not part of the public API: index.js does not export
 * it, and nothing in the engine calls it. It exists so a real document that refuses a `TJ`
 * fallback replacement with FALLBACK_FONT_METRICS_UNAVAILABLE can be diagnosed from the
 * file itself -- see scripts/diagnose-font-metrics.js -- instead of guessed about.
 */
export async function diagnoseFontMetrics(editor) {
  await editor.listTextRuns();
  const structure = editor.document;
  const security = editor.security;
  const resolve = (target) => structure.resolveObject(target, security, decryptStreamBytes);
  const shapeOf = async (target) => {
    let object;
    try {
      object = await resolve(target);
    } catch (error) {
      return { reference: `${target.number} ${target.generation} R`, kind: "unresolved", detail: error.message };
    }
    const kind = object.data ? "stream" : object.dictionary ? "dictionary" : object.rawValue !== null ? "array-or-name" : "number";
    const text = object.dictionary || (object.rawValue ?? String(object.value));
    return { reference: `${target.number} ${target.generation} R`, kind, detail: text.length > 400 ? `${text.slice(0, 400)}...` : text };
  };
  /**
   * Where the cross-reference table puts an object: a normal indirect object at a byte
   * offset, an entry inside an Object Stream, or nothing at all. Read straight off the
   * table the resolver itself uses, so it describes the same lookup that succeeded or
   * failed -- not a second interpretation of the file.
   */
  const locationOf = (number) => {
    const entry = structure.entries.get(number);
    if (!entry) return { number, storage: "missing-from-xref" };
    if (entry.free) return { number, storage: "free" };
    // A compressed object's generation is 0 by definition (PDF 7.5.7): an Object Stream
    // holds no generation field, so there is none to report but that one.
    if (entry.compressed) {
      return { number, storage: "object-stream", streamNumber: entry.streamNumber, indexInStream: entry.indexInStream, generation: 0 };
    }
    return { number, storage: "regular", offset: entry.offset, generation: entry.generation ?? null };
  };
  /** The object number of the dictionary the descendant walk ended on, if it ended on one. */
  const descendantObjectNumberOf = (trace, descendant) => {
    if (!descendant) return null;
    const last = [...trace].reverse().find((step) => step.kind === "dictionary" && step.reference);
    return last ? Number(last.reference.split(" ")[0]) : null;
  };
  const report = [];
  const seen = new Set();
  for (const { object, resources } of await structure.pageContentObjects(security, decryptStreamBytes)) {
    if (seen.has(object.number)) continue;
    seen.add(object.number);
    for (const [name, fontReference] of await fontReferences(resources, structure, security)) {
      const font = await resolve(fontReference);
      const { metrics, reason, detail } = await describeFontWidths(font.dictionary, resolve);
      const related = [];
      // /DescendantFonts is deliberately not one of these keys: parseReferenceArray()'s
      // whole-array-text regex cannot tell an inline CIDFont dictionary's own array
      // element from a reference nested inside it (that mismatch is exactly what made
      // 22550.pdf's /F3 undiagnosable -- see resolveDescendantFont() in font-metrics.js).
      // `descendantTrace` below is /DescendantFonts's own, correct account of itself,
      // read the same way the measurement reads it, so this list does not need a second,
      // less careful reading of the same key.
      //
      // /W, /Widths and /FontDescriptor are skipped here for a Type0 wrapper for the same
      // reason: none of them is ever a top-level key of a Type0 font dictionary itself (a
      // simple font has /Widths and /FontDescriptor; a CIDFont has /W and /FontDescriptor),
      // so on a Type0 whose /DescendantFonts is now an inline dictionary, reference()'s
      // whole-text search would find that dictionary's own /W or /FontDescriptor and
      // misreport it as the wrapper's, duplicating (harmlessly, but confusingly) what the
      // "descendant /..." keys below already report correctly.
      const isType0 = /\/Subtype\s*\/Type0\b/.test(font.dictionary);
      for (const key of ["Encoding", "ToUnicode", ...(isType0 ? [] : ["W", "Widths", "FontDescriptor"])]) {
        for (const target of parseReferenceArray(font.dictionary, key)) related.push({ key, ...await shapeOf(target) });
      }
      // Reached the same way the measurement reaches it, including an indirect
      // /DescendantFonts array -- otherwise this would report "no descendant font" for a
      // font describeFontWidths() measures perfectly well. `descendantTrace` is that same
      // walk's own account of itself (see resolveDescendantFont() in font-metrics.js), so
      // a "descendant-font-unresolved" here names the hop that actually failed instead of
      // being re-derived by a second walk that could disagree with the first.
      const descendantTrace = [];
      const descendant = /\/Subtype\s*\/Type0\b/.test(font.dictionary)
        ? (await resolveDescendantFont(font.dictionary, resolve, descendantTrace)).dictionary ?? null
        : null;
      if (descendant) {
        for (const key of ["W", "DW", "CIDToGIDMap", "FontDescriptor"]) {
          for (const target of parseReferenceArray(descendant, key)) related.push({ key: `descendant /${key}`, ...await shapeOf(target) });
        }
      }
      report.push({
        contentStream: object.number,
        name,
        objectNumber: fontReference.number,
        // What the reference in /Resources /Font actually said, and where the xref puts
        // it: a font whose object cannot be found, or that turns out to live inside an
        // Object Stream, is the kind of thing a real document's refusal turns on.
        objectGeneration: fontReference.generation,
        location: locationOf(fontReference.number),
        dictionary: font.dictionary,
        descendant,
        // The CIDFont's own object number, when the walk reached one: the last reference
        // the trace resolved to a dictionary.
        descendantObjectNumber: descendantObjectNumberOf(descendantTrace, descendant),
        descendantTrace: descendantTrace.map((step) => ({
          ...step,
          ...(step.reference ? { location: locationOf(Number(step.reference.split(" ")[0])) } : {})
        })),
        writingMode: writingModeOf(font.dictionary, structure),
        codeBytes: metrics?.codeBytes ?? null,
        metrics,
        reason,
        detail,
        related
      });
    }
  }
  return report;
}

/**
 * Throws `code: "FALLBACK_FONT_ALREADY_IN_USE"` once `role` has written a replacement --
 * text already written holds glyph ids of that role's font, and another font's ids mean
 * different glyphs, so swapping it would silently turn text already written into the wrong
 * characters. Setting a role again before its first replacement is fine, exactly as
 * setFallbackFont() has always allowed for its one font. Split out from
 * setFallbackFontForRole() so setFallbackFonts() can check every role it is about to touch
 * before parsing any of them -- see there for why.
 */
function ensureFallbackRoleAvailable(editor, role) {
  if (editor.fallbackEmbeddings.has(role)) {
    throw searchError(
      "FALLBACK_FONT_ALREADY_IN_USE",
      `This editor has already written text with the "${role}" fallback font; that text holds glyph ids of that font, so it cannot be exchanged for another. Save and reopen to start again with a different font.`
    );
  }
}

/** Parses and fingerprints one fallback font, without touching the editor. */
async function parseFallbackFontForRole(fontBytes) {
  const fallback = parseFallbackFont(fontBytes);
  // Hashed once, here, so a later session can tell whether a font already embedded in the
  // document is this exact program rather than merely one of the same name and size.
  fallback.digest = await fingerprintFont(fallback.bytes);
  return fallback;
}

/**
 * Refuses `code: "FALLBACK_FONT_INVALID"` when the font that would end up registered for
 * "sans" and the one for "serif" are the same program (same SHA-256 digest) -- checked
 * across both `entries` (parsed fonts this call is about to register) and whatever is
 * already registered on `editor`, so registering "serif" separately with a digest a
 * previously-registered "sans" already has (or the reverse) is refused too, not just the
 * same-call case.
 *
 * Two roles sharing one program would collide in registerFallbackResource()'s page/Font
 * bookkeeping (`editor.fallbackPageResources`, keyed `pageResourcesObjectNumber ->
 * Map(fontDigest -> resourceName)` and shared across every role), which recognizes an
 * already-registered entry by digest alone -- while planFallbackReplacement() still gives
 * each role its own Type0/CIDFont/ToUnicode object numbers and its own glyph set
 * (`editor.fallbackEmbeddings`, keyed by role). The second role registered on a page the
 * first already touched would find the first role's page/Font entry already there (same
 * digest) and reuse its resource name and Type0 reference there, while separately building
 * its own, differently-numbered descendant font and ToUnicode CMap that nothing in the
 * saved file would ever be made to point to -- so glyphs the second role's replacement
 * added would be missing from the /W and ToUnicode the page actually reads through.
 * Rejected here, before either role is ever registered, rather than silently produced.
 */
function assertFallbackDigestsDistinct(editor, entries) {
  const digestOf = (role) => entries.find((entry) => entry[0] === role)?.[1]?.digest ?? editor.fallbackFonts.get(role)?.digest;
  const sans = digestOf("sans");
  const serif = digestOf("serif");
  if (sans && serif && sans === serif) {
    throw searchError(
      "FALLBACK_FONT_INVALID",
      "The \"sans\" and \"serif\" fallback fonts are byte-for-byte the same program; each role must be a distinct font. Two roles sharing one font program would collide in this document's fallback page/resource bookkeeping (see registerFallbackResource() in src/pdf-document.js) -- pass two different font programs, or setFallbackFont() alone if one font is really all that is needed."
    );
  }
}

/** Parses, fingerprints, and registers one fallback font under one role ("sans" or "serif"). */
async function setFallbackFontForRole(editor, role, fontBytes) {
  ensureFallbackRoleAvailable(editor, role);
  const fallback = await parseFallbackFontForRole(fontBytes);
  assertFallbackDigestsDistinct(editor, [[role, fallback]]);
  editor.fallbackFonts.set(role, fallback);
}

/**
 * Developer/test diagnostics only -- not part of the formal public API (see index.js) --
 * for confirming which fallback font a match would actually be written in, and why: the
 * source run's own font, how it classified, which role that selected, and whether the
 * corresponding fallback font is actually registered. Exists so a test can assert "this
 * used BIZ UD明朝" from the engine's own reasoning rather than by re-deriving it, and so a
 * real document's fallback font choice can be explained without guessing from the saved
 * file. Never throws for a refusal -- it reports what checkTextMatchReplacement() would
 * decide, without deciding anything itself.
 */
export async function diagnoseFallbackFontSelection(editor, matchId) {
  await editor.listTextRuns();
  const match = editor.matches.get(matchId);
  if (!match) return { code: "UNKNOWN_MATCH" };
  const pieces = scannedRuns(editor, match.span);
  if (pieces.some(({ run }) => !run)) return { code: "MATCH_STALE" };
  const sourceFontName = pieces[0].run.fontName;
  const classification = pieces[0].stream.fontClassifications?.get(sourceFontName) ?? "unknown";
  const availableRoles = [...editor.fallbackFonts.keys()];
  if (!availableRoles.length) return { sourceFontName, classification, selectedRole: null, availableRoles };
  const { role } = selectFallbackFont(editor, classification);
  return { sourceFontName, classification, selectedRole: role, availableRoles };
}

export class PdfTextEditor {
  constructor(input) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (latin1.decode(this.bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Input is not a PDF document");
    this.document = new PdfStructure(this.bytes);
    this.streams = null;
    this.pending = new Map();
    // Whole objects to append in the next incremental update, keyed by object number:
    // either a brand-new one or a new version of an existing one. `{ dictionary }` for a
    // plain object, `{ dictionary, data }` for a stream (`data` written verbatim, so the
    // dictionary must already describe it -- /Length, and any /Filter it is encoded
    // with). Empty for every ordinary edit; used by the font-embedding experiment under
    // src/experimental/, which has to add font objects and re-state a page's /Resources.
    this.pendingObjects = new Map();
    // Replacement *decoded* content-stream bytes, keyed by content stream object number.
    // Takes precedence over the per-run replacements in `pending` for that stream, for a
    // caller that must rewrite more of the stream than one operand (again: the font
    // experiment, which wraps a run in its own `Tf` switches). save() re-encodes these
    // exactly as it does a run-level edit.
    this.pendingStreams = new Map();
    // Fallback fonts set by setFallbackFont()/setFallbackFonts(), parsed once, keyed by
    // role ("sans" or "serif"); empty until either is called, which is what keeps an editor
    // that never sets one behaving exactly as v0.3.0 did. setFallbackFont() -- the single-
    // font, back-compat API -- always writes the "sans" role, which is also what
    // selectFallbackFont() falls back to for "unknown" and for "serif" text when no serif
    // font is registered; that is what makes a caller who only ever calls setFallbackFont()
    // behave exactly as before this existed, whatever a run's own font classifies as.
    this.fallbackFonts = new Map();
    // The object numbers of each embedded fallback font, allocated on first use and
    // reused, so one font is embedded however many runs are redrawn in it -- keyed by role,
    // the same as fallbackFonts.
    this.fallbackEmbeddings = new Map();
    // /Font resource names already given to a fallback font on a page, shared across every
    // role: pageResourcesObjectNumber -> Map(fontDigest -> resourceName). Global rather than
    // per-role so two different fallback fonts registered on the same page never collide on
    // the name given to either -- see registerFallbackResource().
    this.fallbackPageResources = new Map();
    // Content-stream rewrites made for the fallback font, kept per stream so several
    // replacements in one stream compose (see rebuildContentStream()).
    this.fallbackEdits = new Map();
    // What each run reads as after a fallback rewrite, keyed by run id. Search reports
    // these so it never hands back text the document no longer shows; the planner refuses
    // to edit them again, because the byte offsets it works from describe the run as it
    // was, not as it has been rewritten. Saving and reopening clears the whole question.
    this.fallbackRunTexts = new Map();
    // Matches handed out by the most recent searchText() call, keyed by the opaque id
    // that call returned. Cleared by the next searchText() so a long-lived editor (the
    // browser PoC re-searches on every keystroke) cannot accumulate them without bound.
    this.matches = new Map();
    // Makes a match id from one editor meaningless to another, so a stale id can never
    // silently address a same-shaped run in a different document.
    this.matchNamespace = Math.random().toString(36).slice(2, 10);
    this.matchCounter = 0;
    // Set once an encrypted PDF has been authenticated (see listTextRuns()); null for
    // an unencrypted PDF or one not yet authenticated. Read by replaceText()/save()
    // to enforce /P permissions and by decodeStream() to decrypt stream bytes.
    this.security = null;
  }

  /**
   * `password` is only consulted the first time this resolves (later calls, e.g.
   * from replaceText()/save(), reuse whatever was already authenticated). Defaults
   * to the empty string, so a caller can always try "no password" first -- most
   * PDFs that a normal reader opens without prompting use an empty user password.
   * A failed attempt leaves `this.streams` unset, so calling this again with a real
   * password retries cleanly.
   */
  async listTextRuns(password) {
    if (!this.streams) {
      // The xref table may live in an xref stream, which needs Flate decompression
      // (async) to read. Resolving it here, on first use, keeps the constructor
      // itself synchronous and free of I/O.
      await this.document.ensureXref();
      // The xref table itself is unaffected by encryption, so it resolves either
      // way. Content extraction only continues once (a) the encryption in use is
      // something this engine actually decrypts (Standard/V4/R4/AESV2 or
      // Standard/V5/R6/AESV3 -- anything else throws, non-recoverable, from
      // authenticateEncryptedPdf itself) and (b) the given password authenticates
      // against it (recoverable: a caller can retry with a different password).
      // See src/security/decrypt.js. authenticateEncryptedPdf() is async because
      // revision 6 authentication hashes via crypto.subtle (Algorithm 2.B).
      if (this.document.encryptReference) {
        const security = await authenticateEncryptedPdf(this.document, password ?? "");
        if (!security.authenticated) {
          const summary = summarizeEncryption(security.diagnosis);
          const error = new Error(`Password required to open this encrypted PDF${summary ? ` (${summary})` : ""}`);
          error.encryptionDiagnosis = security.diagnosis;
          error.passwordRequired = true;
          throw error;
        }
        this.security = security;
      }
      this.streams = [];
      const seen = new Set();
      for (const { object, resources } of await this.document.pageContentObjects(this.security, decryptStreamBytes)) {
        // One content stream can be shared by several pages, and /Contents may even
        // list it twice. Run ids are keyed by object number, so scanning it more than
        // once would hand out duplicate ids and append the object twice on save.
        if (seen.has(object.number)) continue;
        seen.add(object.number);
        const decoded = await decodeStream(object, "content stream", this.security);
        const runs = scanTextRuns(decoded, `content stream object ${object.number}`);
        if (runs.length) {
          const fonts = await loadFontMaps(resources, this.document, this.security);
          this.streams.push({
            object, decoded, runs, resources,
            fontMaps: fonts.maps, fontModes: fonts.modes, fontWidths: fonts.widths,
            fontWidthReasons: fonts.widthReasons, fontClassifications: fonts.classifications
          });
        }
      }
    }
    return this.streams.flatMap((stream) => stream.runs.map((run, runIndex) => ({
      id: `${stream.object.number}:${runIndex}`,
      objectNumber: stream.object.number,
      textObjectId: run.textObjectId,
      text: decodeWithCMap(run.value, stream.fontMaps.get(run.fontName)),
      fontName: run.fontName,
      bytes: run.value.slice()
    })));
  }

  async replaceText(id, replacement) {
    const runs = await this.listTextRuns();
    // /P's modify permission is checked every call, not just once at open time: it
    // is a property of the PDF, not of this session, so nothing here should ever
    // let a caller stage an edit that permission forbids -- decrypting the content
    // is a reading capability, not an editing one. See README for why owner
    // authentication does not bypass this (it recovers the same file key a user
    // login would, nothing more).
    if (this.security && this.security.modifyAllowed === false) {
      throw new Error("Document modification is not permitted: this PDF's /P permissions disallow content changes (modify permission denied)");
    }
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`Unknown text run: ${id}`);
    this.pending.set(id, encodeReplacement(this, run, replacement));
    return this;
  }

  /**
   * Finds `query` in the text a reader of this PDF actually sees, across the run
   * boundaries the PDF happens to have split that text on.
   *
   * This is the high-level, caller-facing search. A word is very often drawn as several
   * text-showing operands -- "令和6年度" as `[(令) 120 (和) -20 (6) 0 (年) 0 (度)] TJ`
   * is five of them, hence five runs -- so searching the runs of listTextRuns() one by
   * one finds single characters and nothing longer. Runs are joined here instead, but
   * only where the content stream itself says they are consecutive body text: never
   * across content streams, a `BT`/`ET`, a `Td`/`TD`/`Tm`/`T*`, a `'`/`"`, or a font
   * switch (see buildSegments() and scanTextRuns()). Naively concatenating runs would
   * match text drawn in two unrelated places on the page and then rewrite one of them.
   *
   * Returns one entry per occurrence, in document order, each `{ id, text, before,
   * after, runCount, fontName }`. `before`/`after` are up to CONTEXT_RADIUS code points
   * of surrounding text, for telling repeated hits apart. `id` is opaque: pass it back
   * to replaceTextMatch() and do not parse it -- its shape is not part of this API and
   * it is meaningless to any other editor instance. Ids stay valid until the next
   * searchText() call on this editor, which supersedes them.
   *
   * An empty `query` is rejected with `code: "EMPTY_QUERY"` rather than matching every
   * run: a search for nothing is a caller mistake, and answering it with "everything"
   * invites a replace-all against the whole document.
   *
   * `password` is forwarded to listTextRuns() for an encrypted PDF not yet authenticated.
   */
  async searchText(query, password) {
    if (typeof query !== "string") throw searchError("EMPTY_QUERY", "searchText() requires a string query");
    if (query === "") throw searchError("EMPTY_QUERY", "searchText() requires a non-empty query; an empty string matches nothing rather than every text run");
    await this.listTextRuns(password);
    const queryPoints = [...query];
    this.matches.clear();
    const results = [];
    for (const segment of buildSegments(internalRuns(this))) {
      let cursor = 0;
      for (;;) {
        const start = indexOfPoints(segment.points, queryPoints, cursor);
        if (start === -1) break;
        const end = start + queryPoints.length;
        // Every run the match overlaps, with the slice of that run the match covers.
        // charStart/charEnd are code-point offsets into the run's own text, so the
        // characters on either side of the match are known and can be kept (see
        // replaceTextMatch()); a match need not start or end on a run boundary.
        const span = segment.entries
          .filter((entry) => entry.start < end && entry.end > start)
          .map((entry) => ({
            runId: entry.run.id,
            objectNumber: entry.run.objectNumber,
            fontName: entry.run.fontName,
            // Snapshot of the run as it read when this match was found; the staleness
            // check in replaceTextMatch() compares against it.
            runText: entry.run.text,
            charStart: Math.max(0, start - entry.start),
            charEnd: Math.min(entry.end - entry.start, end - entry.start)
          }));
        const id = `${this.matchNamespace}-${this.matchCounter += 1}`;
        const text = segment.points.slice(start, end).join("");
        this.matches.set(id, { id, text, span });
        results.push({
          id,
          text,
          before: segment.points.slice(Math.max(0, start - CONTEXT_RADIUS), start).join(""),
          after: segment.points.slice(end, Math.min(segment.points.length, end + CONTEXT_RADIUS)).join(""),
          // Informational only -- how many text-showing operands this match is drawn
          // as. A caller never needs it to replace the match; the browser PoC shows it.
          runCount: span.length,
          fontName: span[0]?.fontName ?? null
        });
        cursor = end;
      }
    }
    return results;
  }

  /**
   * Supplies a font to fall back on when the document's own fonts cannot write a
   * replacement -- which is whenever it contains a character the document never used,
   * since a PDF's embedded fonts are normally subsetted to just the characters it needed.
   *
   * With one set, checkTextMatchReplacement() and replaceTextMatch() reach for it by
   * themselves: the document's own font is always tried first, and the fallback is used
   * only for text that font cannot express, so nothing that already worked starts
   * embedding a multi-megabyte font. Without one, both behave exactly as they did before
   * this existed. There is no default and nothing is downloaded: `fontBytes` is a
   * TrueType font the caller has loaded however it likes, and the engine makes no network
   * request of any kind.
   *
   * The font is embedded in full when it is first used, which adds its compressed size to
   * the saved file -- a few megabytes for a CJK font. It is embedded once per document
   * however many replacements use it.
   *
   * Throws `code: "FALLBACK_FONT_INVALID"` if the bytes are not a TrueType font, and
   * `code: "FALLBACK_FONT_ALREADY_IN_USE"` if this editor has already written something
   * with a fallback font. Text already replaced holds glyph ids of *that* font, and
   * another font's ids mean different glyphs, so swapping it would silently turn text
   * already written into the wrong characters. Setting a different font before the first
   * replacement is fine.
   *
   * This is sugar for `setFallbackFonts({ sans: fontBytes })`: it always registers the
   * "sans" role, which is what every fallback replacement uses when this is the only
   * fallback font call an editor ever makes -- so a caller that has not adopted
   * setFallbackFonts() sees exactly the v0.4.4 behaviour, regardless of the source text's
   * own font. See setFallbackFonts() for choosing a different font for serif source text.
   */
  async setFallbackFont(fontBytes) {
    await setFallbackFontForRole(this, "sans", fontBytes);
    return this;
  }

  /**
   * Supplies more than one fallback font, so that text drawn in a serif source font can be
   * redrawn in a serif-looking fallback and text drawn in a sans-serif source font in a
   * sans-serif-looking one -- reducing how visually different a replacement looks from the
   * document's own type, which setFallbackFont()'s single font cannot do for both at once.
   *
   * `fonts` is `{ sans?, serif? }`. Which role a given match actually uses is never up to
   * the caller: it is decided per match, from the source run's own font, by
   * planFallbackReplacement() in pdf-document.js (see font-classification.js for how a font
   * is read as "serif", "sans", or "unknown"). A "serif" source font uses the "serif"
   * fallback only when one has been supplied; "sans", "unknown", and "serif" with no serif
   * fallback registered all use "sans" -- exactly the font setFallbackFont() alone would
   * have used for everything, so a document this cannot confidently classify never behaves
   * worse than v0.4.4 did.
   *
   * **"sans" must be registered before "serif" can be used** -- either in this same call, or
   * by an earlier one (including a prior setFallbackFont(), which registers "sans"). Without
   * it, "serif" would have no font to fall back to for the "sans"/"unknown" text it is not
   * meant to draw, and would end up drawing everything in the serif font instead -- silently
   * contradicting the fallback this whole design exists to preserve. Rejected up front with
   * `code: "FALLBACK_FONT_INVALID"` rather than left to draw the wrong font later.
   *
   * Both fonts may be embedded in the same document, each once however many replacements
   * use it, and a page needing both gets both without either colliding on resource name.
   *
   * Each role may be set again with a different font as long as that role has not yet been
   * used to write a replacement (`code: "FALLBACK_FONT_ALREADY_IN_USE"` otherwise, naming
   * the role) -- the same rule setFallbackFont() has always applied to its one font, applied
   * per role now that there can be more than one.
   */
  async setFallbackFonts(fonts) {
    if (!fonts || typeof fonts !== "object") {
      throw searchError("FALLBACK_FONT_INVALID", "setFallbackFonts() takes an object of { sans?, serif? } font bytes");
    }
    const entries = Object.entries(fonts).filter(([, bytes]) => bytes !== undefined);
    const badRole = entries.find(([role]) => role !== "sans" && role !== "serif");
    if (badRole) {
      throw searchError("FALLBACK_FONT_INVALID", `setFallbackFonts() only accepts "sans" and "serif" roles, not "${badRole[0]}"`);
    }
    if (!entries.length) throw searchError("FALLBACK_FONT_INVALID", "setFallbackFonts() requires at least one of { sans, serif }");
    // "serif" must never be usable without "sans" registered -- see selectFallbackFont(),
    // which relies on this as an invariant rather than re-checking it on every match.
    const registersSans = entries.some(([role]) => role === "sans");
    if (!registersSans && !this.fallbackFonts.has("sans")) {
      throw searchError(
        "FALLBACK_FONT_INVALID",
        "setFallbackFonts() requires a \"sans\" font to be registered (in this call or an earlier one) before \"serif\" can be used: \"sans\"/\"unknown\" source text always falls back to \"sans\", so a document with no \"sans\" font would have nothing to fall back to."
      );
    }
    // All-or-nothing: every role this call touches is checked before any of them is parsed,
    // and none is registered until all have parsed successfully -- so a request naming both
    // roles never ends up with one applied and the other refused (an already-used role, or
    // invalid bytes for either, leaves this editor exactly as it was).
    for (const [role] of entries) ensureFallbackRoleAvailable(this, role);
    const parsed = [];
    for (const [role, bytes] of entries) parsed.push([role, await parseFallbackFontForRole(bytes)]);
    // "sans" and "serif" must be distinct programs -- see assertFallbackDigestsDistinct()
    // for what breaks otherwise. Checked after parsing (fingerprinting needs the parse) but
    // still before anything is registered, so this stays all-or-nothing too.
    assertFallbackDigestsDistinct(this, parsed);
    for (const [role, fallback] of parsed) this.fallbackFonts.set(role, fallback);
    return this;
  }

  /**
   * Whether replaceTextMatch() would accept `replacement` for this match, decided
   * without changing anything. Returns `{ allowed: true, mode }` or `{ allowed: false,
   * code, reason, unsafeReason? }` -- never throws for a refusal, since a caller asking
   * "may I?" is not making a mistake by asking.
   *
   * `mode` names how the replacement would be written: "single-run" (the match sits in
   * one operand, rewritten whole), "same-length" (each operand gets back the characters
   * it contributed), "delete", or "variable-length-safe" (the length changes and the
   * structure permits it -- see planTextMatchReplacement()).
   *
   * This exists so a caller never has to inspect run counts, `TJ` arrays or operators to
   * decide whether an edit is possible: that judgement needs the content stream, and
   * belongs here. It shares planTextMatchReplacement() with replaceTextMatch(), so its
   * verdict is the same verdict -- including the font encoding, which is attempted here
   * too rather than left to surface only at replacement time.
   */
  async checkTextMatchReplacement(matchId, replacement) {
    await this.listTextRuns();
    const plan = await planTextMatchReplacement(this, matchId, replacement);
    if (!plan.allowed) {
      const result = { allowed: false, mode: null, code: plan.code, reason: plan.reason };
      if (plan.unsafeReason) result.unsafeReason = plan.unsafeReason;
      // The characters no available font can write, so a caller can name them to a user
      // without reading the message or knowing anything about CMaps.
      if (plan.characters?.length) result.characters = plan.characters;
      // The two widths a "fallback-replacement-overflows-slot" unsafeReason was measured
      // from, so a caller diagnosing the refusal can see them without parsing `reason`.
      if (plan.diagnostics) result.diagnostics = plan.diagnostics;
      return result;
    }
    return { allowed: true, mode: plan.mode };
  }

  /**
   * Replaces one match from searchText(), across every run it spans, and stages the
   * result for save() -- so a caller never has to know that the match was split into
   * runs at all, nor call replaceText() once per piece.
   *
   * The verdict and the exact bytes both come from planTextMatchReplacement(), the same
   * decision checkTextMatchReplacement() reports; see it for what is allowed and why.
   * In short:
   *
   * - A match inside a single run is rewritten whole, at any length -- unchanged from
   *   v0.2.1, and unaffected by the multi-run rules below.
   * - A multi-run match of equal length is split back onto its original operands by how
   *   many characters each contributed; a deletion empties each operand's share. Both
   *   keep every operand boundary, so both work whatever sits between the operands.
   * - A multi-run match whose length changes is written only when the operands are
   *   joined by zero `TJ` adjustments or by nothing at all: then the whole replacement
   *   goes into the first operand and the rest are emptied, which the PDF draws exactly
   *   as the single-operand replacement above. Any other structure -- a non-zero
   *   adjustment, a `Tc`/`Tw`/`Tz`/`Tr`, colour or marked-content operator in between --
   *   is refused with `code: "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"` rather than
   *   re-spaced, re-flowed or estimated.
   *
   * Prefix and suffix around the match are always preserved. A match whose text has
   * changed since it was found is refused with `code: "MATCH_STALE"` rather than
   * rewriting whatever now sits there. Characters are counted in Unicode code points
   * (`[...text]`), so a surrogate pair counts once; grapheme clusters are not combined.
   *
   * Nothing is staged unless the whole replacement encodes: the updates are built and
   * encoded before any of them is committed, so a character the font cannot express
   * leaves the document untouched instead of half replaced.
   */
  async replaceTextMatch(matchId, replacement) {
    await this.listTextRuns();
    const plan = await planTextMatchReplacement(this, matchId, replacement);
    if (!plan.allowed) throw planError(plan);
    commitPlan(this, plan);
    return this;
  }

  /**
   * The lowest object number no object in this document uses, so a caller adding objects
   * can number them without colliding. Reads the trailer's /Size, which is defined as
   * one past the highest object number in the file.
   */
  async nextObjectNumber() {
    await this.listTextRuns();
    return this.document.size;
  }

  async save() {
    await this.listTextRuns();
    if (!this.pending.size && !this.pendingObjects.size && !this.pendingStreams.size) return this.bytes.slice();
    // Persisting any edit to an encrypted PDF would need to re-encrypt the new
    // content stream bytes (and, per spec, could touch /O, /U, or the trailer's
    // /ID) -- deliberately out of scope for this PR (see README). This is separate
    // from the /P permission check in replaceText(): a modify-allowed encrypted PDF
    // can still stage an edit there, but cannot be saved here, since it is
    // re-encryption support that is missing, not permission.
    if (this.security) {
      throw new Error("Saving edits to an encrypted PDF is not supported yet (re-encryption is out of scope for this PR); this PDF can be searched but not saved.");
    }
    const updates = [];
    for (const stream of this.streams) {
      // A whole-stream replacement supersedes the per-run edits for that stream: it was
      // produced from the same decoded bytes and already contains them.
      const whole = this.pendingStreams.get(stream.object.number);
      const replacements = whole ? [] : stream.runs.flatMap((_, runIndex) => {
        const bytes = this.pending.get(`${stream.object.number}:${runIndex}`);
        return bytes ? [{ runIndex, bytes }] : [];
      });
      if (!whole && !replacements.length) continue;
      let data = whole ?? replaceTextRuns(stream.decoded, replacements);
      // stream.decoded is already predictor-reversed (see decodeStreamBytes()); the
      // edited bytes are re-deflated as plain FlateDecode without reapplying a
      // predictor. replacementDictionary() drops any /DecodeParms accordingly.
      if (filters(stream.object.dictionary)[0] === "FlateDecode") data = await deflate(data);
      updates.push({ ...stream.object, dictionary: replacementDictionary(stream.object.dictionary, data.length), data });
    }
    // Objects staged whole (see this.pendingObjects). A stream object carries `data`; a
    // plain one is written as just its dictionary between `obj` and `endobj`.
    for (const [number, object] of this.pendingObjects) {
      updates.push({ number, generation: object.generation ?? 0, dictionary: object.dictionary, data: object.data ?? null });
    }
    const chunks = [this.bytes, encoder.encode(this.bytes.at(-1) === 10 ? "" : "\n")];
    const offsets = [];
    let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    for (const update of updates) {
      const head = update.data
        ? encoder.encode(`${update.number} ${update.generation} obj\n${update.dictionary}\nstream\n`)
        : encoder.encode(`${update.number} ${update.generation} obj\n${update.dictionary}\nendobj\n`);
      const tail = update.data ? encoder.encode("\nendstream\nendobj\n") : null;
      offsets.push({ number: update.number, generation: update.generation, offset });
      chunks.push(head);
      offset += head.length;
      if (update.data) {
        chunks.push(update.data, tail);
        offset += update.data.length + tail.length;
      }
    }
    const xrefOffset = offset;
    chunks.push(encoder.encode("xref\n"));
    offsets.sort((a, b) => a.number - b.number);
    for (const entry of offsets) {
      chunks.push(encoder.encode(`${entry.number} 1\n${String(entry.offset).padStart(10, "0")} ${String(entry.generation).padStart(5, "0")} n \n`));
    }
    chunks.push(encoder.encode(
      // /Size is one past the highest object number in the file, so appending objects
      // beyond the original count has to raise it or a reader will not resolve them.
      `trailer\n<< /Size ${Math.max(this.document.size, ...offsets.map((entry) => entry.number + 1))} /Root ${this.document.root.number} ${this.document.root.generation} R /Prev ${this.document.previousXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    ));
    return concat(chunks);
  }
}
