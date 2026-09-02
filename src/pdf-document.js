import { encodeHex, encodeLiteral, replaceTextRuns, scanTextRuns } from "./content-stream.js";
import { buildFallbackFontObjects, freeResourceName, glyphsFor, identityEncode, parseFallbackFont } from "./fallback-font.js";
import { decodeWithCMap, encodeWithCMap, parseToUnicodeCMap } from "./cmap.js";
import { summarizeEncryption } from "./encryption.js";
import { deflate, decodeStreamBytes, filters } from "./flate.js";
import { PdfStructure, reference } from "./pdf-structure.js";
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

function refusal(code, reason, unsafeReason) {
  return unsafeReason ? { allowed: false, code, reason, unsafeReason } : { allowed: false, code, reason };
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
 * Registers the fallback font in one page's `/Resources /Font`, leaving every other
 * resource as it was, and returns the resource name to use on that page. The font objects
 * themselves are shared: a second page gets its own name and its own resources entry, but
 * points at the same Type0 object, so the font file is never embedded twice.
 */
function registerFallbackResource(editor, embedded, resources) {
  if (resources?.number === undefined) {
    return refusal("FALLBACK_LAYOUT_UNSUPPORTED", "This page's /Resources are not an addressable object, so the fallback font cannot be added to them");
  }
  const existing = embedded.resources.get(resources.number);
  if (existing) return { name: existing };

  const indirect = reference(resources.dictionary, "Font");
  const holder = indirect ? editor.document.object(indirect) : resources;
  const inline = indirect ? null : resources.dictionary.match(/\/Font\s*<<([\s\S]*?)>>/);
  let name;
  let dictionary;
  if (indirect) {
    name = freeResourceName(holder.dictionary);
    dictionary = holder.dictionary.replace(/>>\s*$/, `/${name} ${embedded.numbers.type0} 0 R >>`);
  } else if (inline) {
    name = freeResourceName(inline[1]);
    dictionary = resources.dictionary.replace(inline[0], `/Font << ${inline[1].trim()} /${name} ${embedded.numbers.type0} 0 R >>`);
  } else {
    // A page with no /Font at all: give it one rather than refusing.
    name = "ILPFallback";
    dictionary = resources.dictionary.replace(/>>\s*$/, `/Font << /${name} ${embedded.numbers.type0} 0 R >> >>`);
  }
  embedded.resources.set(resources.number, name);
  return { name, object: { number: holder.number, generation: holder.generation, dictionary } };
}

/**
 * Plans a replacement written through the fallback font, for a match the document's own
 * font cannot express.
 *
 * The rewrite is the same shape whatever the match spans, because the pieces are simply
 * drawn one after another and each `Tj` continues where the last left off (verified
 * against pdf.js: splitting a `Tj` and re-stating the same font between the pieces draws
 * the identical page, under `Tc`/`Tw`/`Tz`/`Ts` alike). The match's first run becomes
 *
 *     <prefix> Tj  /Fallback size Tf  <replacement> Tj  /Original size Tf
 *
 * any run wholly inside the match is emptied, and the last run keeps its suffix. So the
 * replacement is drawn where the match began, the text after it flows on from the
 * replacement's own width -- which is what editing text should do -- and no width, matrix
 * or spacing arithmetic is involved anywhere.
 *
 * What has to hold, and is refused otherwise:
 *
 * - every run of the match is drawn by a plain `Tj`. A `TJ` operand lives inside an array
 *   and `'`/`"` carry a line move, neither of which this rewrite accounts for.
 * - the runs share one font and one size, so there is a single font to restore.
 * - the runs are adjacent (the v0.3.0 rule: no state change and no net `TJ` displacement
 *   between them), so emptying the ones inside the match moves nothing.
 * - nothing is drawn from where the match's last run ends. The replacement's width is not
 *   the original's, so anything continuing from there would move. An `ET`, a `BT`, or an
 *   explicit `Td`/`TD`/`Tm`/`T*` all settle it; a following `Tj` does not.
 */
async function planFallbackReplacement(editor, match, replacement) {
  const fallback = editor.fallbackFont;
  const pieces = scannedRuns(editor, match.span);
  if (pieces.some(({ run }) => !run)) return refusal("MATCH_STALE", "This match no longer describes the document");

  const operator = pieces.find(({ run }) => run.operator !== "Tj");
  if (operator) {
    return refusal("FALLBACK_OPERATOR_UNSUPPORTED", `The fallback font is written with Tj; this match is drawn by ${operator.run.operator}`);
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
  if (match.span.length > 1) {
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

  const last = pieces.at(-1).run;
  if (!POSITION_SAFE_AFTER.has(last.followedBy)) {
    return refusal(
      "FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE",
      `Text is drawn from where this match ends (${last.followedBy}), and the fallback font's characters are not the widths the document's own font used, so that text would move. Only a match followed by ET or an explicit Td/TD/Tm/T* is redrawn in another font.`
    );
  }

  const { glyphs, missing } = glyphsFor(fallback, replacement);
  if (missing) {
    return { ...refusal("FALLBACK_FONT_MISSING_GLYPH", `The fallback font has no glyph for ${missing.map((character) => JSON.stringify(character)).join(", ")}`), characters: missing };
  }

  // A working copy of what has been embedded so far. Planning must not touch the
  // editor's own record: checkTextMatchReplacement() runs this too, and if it marked a
  // page as already carrying the font, the replaceTextMatch() that followed would skip
  // adding it -- writing a content stream that names a font the page's /Resources never
  // got. Object numbers are carried over, so replacing ten runs still embeds one font.
  const base = editor.fallbackEmbedding;
  const start = Math.max(editor.document.size, ...[...editor.pendingObjects.keys()].map((number) => number + 1));
  const embedded = {
    numbers: base?.numbers ?? { type0: start, cidFont: start + 1, descriptor: start + 2, fontFile: start + 3, toUnicode: start + 4 },
    resources: new Map(base?.resources),
    glyphs: new Map(base?.glyphs)
  };

  const objects = new Map();
  const resourceNames = new Map();
  for (const { stream } of pieces) {
    const registered = registerFallbackResource(editor, embedded, stream.resources);
    if (registered.allowed === false) return registered;
    resourceNames.set(stream.object.number, registered.name);
    if (registered.object) objects.set(registered.object.number, registered.object);
  }

  for (const glyph of glyphs) embedded.glyphs.set(glyph.glyphId, glyph);

  // Encode every piece before anything is staged, so a prefix or suffix the original font
  // cannot write fails here rather than half-way through.
  const edits = [];
  try {
    pieces.forEach(({ stream, run, entry }, index) => {
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

  for (const [number, object] of await buildFallbackFontObjects(fallback, embedded.numbers, embedded.glyphs)) {
    objects.set(number, object);
  }
  return { allowed: true, mode, updates: [], fallback: { embedding: embedded, objects, edits } };
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
    if (!editor.fallbackFont) {
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
  editor.fallbackEmbedding = plan.fallback.embedding;
  for (const [number, object] of plan.fallback.objects) editor.pendingObjects.set(number, object);
  editor.fallbackEdits = edits;
  for (const [objectNumber, bytes] of rebuilt) editor.pendingStreams.set(objectNumber, bytes);
  for (const edit of plan.fallback.edits) {
    if (edit.runId !== undefined) editor.fallbackRunTexts.set(edit.runId, edit.runText);
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
  const rewritten = new Set(fallbackEdits.map((edit) => `${edit.start}:${edit.end}`));
  const runEdits = stream.runs.flatMap((run, index) => {
    const bytes = editor.pending.get(`${objectNumber}:${index}`);
    if (!bytes || rewritten.has(`${run.start}:${run.end}`)) return [];
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
    const wmode = structure.object(indirect).dictionary.match(/\/WMode\s+(\d+)/);
    if (!wmode) return "unknown";
    return wmode[1] === "1" ? "vertical" : "horizontal";
  } catch {
    return "unknown";
  }
}

async function loadFontMaps(resources, structure, security) {
  const result = new Map();
  const modes = new Map();
  // A font dictionary can itself be compressed (a common PDF-writer optimization);
  // its own /ToUnicode target, however, is always a stream, and streams are never
  // stored in an Object Stream (PDF spec 7.5.7), so that lookup stays on the
  // synchronous, unchanged structure.object().
  for (const [name, fontReference] of await fontReferences(resources, structure, security)) {
    const font = await structure.resolveObject(fontReference, security, decryptStreamBytes);
    modes.set(name, writingModeOf(font.dictionary, structure));
    const toUnicode = reference(font.dictionary, "ToUnicode");
    if (!toUnicode) continue;
    const cmapObject = structure.object(toUnicode);
    result.set(name, parseToUnicodeCMap(await decodeStream(cmapObject, "ToUnicode stream", security)));
  }
  return { maps: result, modes };
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
    // The fallback font set by setFallbackFont(), parsed once; null until then, which is
    // what keeps an editor that never sets one behaving exactly as v0.3.0 did.
    this.fallbackFont = null;
    // The object numbers and per-page resource names of the embedded font, allocated on
    // first use and reused, so one font is embedded however many runs are redrawn in it.
    this.fallbackEmbedding = null;
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
          this.streams.push({ object, decoded, runs, resources, fontMaps: fonts.maps, fontModes: fonts.modes });
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
   */
  async setFallbackFont(fontBytes) {
    if (this.fallbackEmbedding) {
      throw searchError("FALLBACK_FONT_ALREADY_IN_USE", "This editor has already written text with a fallback font; that text holds glyph ids of that font, so it cannot be exchanged for another. Save and reopen to start again with a different font.");
    }
    this.fallbackFont = parseFallbackFont(fontBytes);
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
