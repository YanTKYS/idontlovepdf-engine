/**
 * EXPERIMENT -- not part of the engine's public API, not exported from src/index.js, and
 * not included in dist/idontlovepdf-engine.js. See docs/experiments/font-embedding-poc.md.
 *
 * The question this answers: the engine writes replacement text through the CMap of the
 * font the PDF already uses, so a character that font has no code for cannot be written
 * at all (`FONT_ENCODING_UNSUPPORTED`). 令和 -> 平成 works; 令和 -> 昭和 does not, because
 * the document never used 昭. For a general-purpose editor that is a hard limit: you can
 * only ever type characters the document already contains.
 *
 * This module tests whether embedding a Japanese font into the PDF and switching to it
 * for the replaced run lifts that limit, while keeping the engine's existing approach:
 * the page's own content stream is edited and the result is written as an incremental
 * update. No overlay, no annotation, no white box, no rasterisation.
 *
 * Deliberately narrow (see the PoC brief): one whole run drawn by a plain `Tj`, replaced
 * by the same number of characters, and only where nothing is drawn from that run's own
 * end position. Anything else is refused rather than approximated -- widths are read from
 * the font but nothing is re-laid-out, and no subsetting is attempted.
 *
 * That last condition is the one that is easy to miss. Re-stating the original `Tf` after
 * the replacement restores the *font*, not the text position: showing a string advances
 * the position by its glyphs' widths, and the embedded font's glyphs are not the widths
 * the original font's were. So text drawn afterwards from that position would move, even
 * though the character count is unchanged. See followedBy in scanTextRuns().
 */
import opentypeModule from "opentype.js";

import { encodeHex, encodeLiteral } from "../content-stream.js";
import { deflate } from "../flate.js";
import { reference } from "../pdf-structure.js";

const opentype = opentypeModule.default ?? opentypeModule;
const encoder = new TextEncoder();

/** PDF glyph space is 1000 units per em whatever the font's own unitsPerEm is. */
const PDF_UNITS_PER_EM = 1000;

function experimentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, "0");

/** A ToUnicode destination: the character as UTF-16BE, which is what a bfchar holds. */
function utf16beHex(text) {
  let output = "";
  for (let index = 0; index < text.length; index += 1) output += hex4(text.charCodeAt(index));
  return output;
}

/**
 * Parses a fallback font once, so a caller embedding it into several documents pays for
 * the parse once. `bytes` must be a TrueType (glyf-outline) font: PDF embeds those as
 * /FontFile2, which is the only font stream form this experiment writes.
 */
export function loadFallbackFont(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // opentype.js wants a standalone ArrayBuffer, not a view into a larger one.
  const font = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (font.outlinesFormat !== "truetype") {
    throw experimentError("FALLBACK_FONT_NOT_TRUETYPE", `The fallback font must have TrueType outlines for /FontFile2 embedding; this one is ${font.outlinesFormat}`);
  }
  return {
    bytes: data,
    font,
    // Deflating 4.5 MB is the slowest step here, and the result never changes: the whole
    // font is embedded, so the compressed bytes are the same for every document.
    compressed: null,
    unitsPerEm: font.unitsPerEm,
    postScriptName: (font.names.postScriptName?.en ?? "FallbackFont").replace(/[^\x21-\x7e]|[\s()<>\[\]{}/%#]/g, "")
  };
}

/**
 * Unicode -> glyph id, through the font's own cmap. Glyph 0 is .notdef, which is what
 * opentype.js returns for a character the font does not have -- never a usable glyph, so
 * it is reported as a miss rather than silently drawn as a box.
 */
function glyphIdsFor(fallback, text) {
  const ids = [];
  for (const character of text) {
    const glyph = fallback.font.charToGlyph(character);
    if (!glyph || !glyph.index) return { missing: character };
    ids.push({ character, glyphId: glyph.index, advanceWidth: glyph.advanceWidth ?? fallback.unitsPerEm });
  }
  return { ids };
}

/** Identity-H addresses glyphs directly: the string operand is 2-byte big-endian ids. */
function identityBytes(ids) {
  const bytes = new Uint8Array(ids.length * 2);
  ids.forEach(({ glyphId }, index) => {
    bytes[index * 2] = (glyphId >> 8) & 0xff;
    bytes[index * 2 + 1] = glyphId & 0xff;
  });
  return bytes;
}

/* ------------------------------------------------------------------ PDF font objects */

/**
 * The font objects a PDF needs for an embedded TrueType font addressed by glyph id:
 *
 *   Type0 (Identity-H)  ->  CIDFontType2 descendant  ->  FontDescriptor  ->  FontFile2
 *                       \-> ToUnicode CMap
 *
 * /CIDToGIDMap /Identity makes the CID *be* the glyph id, which is what lets the string
 * operand hold glyph ids directly and keeps the mapping trivial to verify. The whole font
 * file is embedded -- no subsetting, per the PoC brief -- so /W is written only for the
 * glyphs actually drawn, with /DW covering everything else.
 */
async function buildFontObjects(fallback, numbers, glyphs) {
  const { font } = fallback;
  const scale = (value) => Math.round((value * PDF_UNITS_PER_EM) / fallback.unitsPerEm);
  const head = font.tables.head ?? {};
  const os2 = font.tables.os2 ?? {};

  const widths = [...glyphs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([glyphId, { advanceWidth }]) => `${glyphId} [${scale(advanceWidth)}]`)
    .join(" ");

  const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${glyphs.size} beginbfchar
${[...glyphs.entries()].sort((a, b) => a[0] - b[0])
    .map(([glyphId, { character }]) => `<${hex4(glyphId)}> <${utf16beHex(character)}>`)
    .join("\n")}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  fallback.compressed ??= await deflate(fallback.bytes);
  const fontData = fallback.compressed;
  const toUnicodeData = encoder.encode(toUnicode);
  const name = fallback.postScriptName;

  return new Map([
    [numbers.type0, {
      dictionary: `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H`
        + ` /DescendantFonts [${numbers.cidFont} 0 R] /ToUnicode ${numbers.toUnicode} 0 R >>`
    }],
    [numbers.cidFont, {
      dictionary: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name}`
        + ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`
        + ` /FontDescriptor ${numbers.descriptor} 0 R /DW ${PDF_UNITS_PER_EM} /W [${widths}]`
        + ` /CIDToGIDMap /Identity >>`
    }],
    [numbers.descriptor, {
      dictionary: `<< /Type /FontDescriptor /FontName /${name} /Flags 4`
        + ` /FontBBox [${scale(head.xMin ?? 0)} ${scale(head.yMin ?? 0)} ${scale(head.xMax ?? 0)} ${scale(head.yMax ?? 0)}]`
        + ` /ItalicAngle 0 /Ascent ${scale(font.ascender)} /Descent ${scale(font.descender)}`
        + ` /CapHeight ${scale(os2.sCapHeight ?? font.ascender)} /StemV 80`
        + ` /FontFile2 ${numbers.fontFile} 0 R >>`
    }],
    [numbers.fontFile, {
      dictionary: `<< /Length ${fontData.length} /Length1 ${fallback.bytes.length} /Filter /FlateDecode >>`,
      data: fontData
    }],
    [numbers.toUnicode, {
      dictionary: `<< /Length ${toUnicodeData.length} >>`,
      data: toUnicodeData
    }]
  ]);
}

/* ------------------------------------------------------------------- page resources */

/** A /Font resource name this document does not already use. */
function freeResourceName(fontDictionary) {
  const taken = new Set([...fontDictionary.matchAll(/\/([^\s/<>{}[\]()]+)/g)].map((match) => match[1]));
  for (let suffix = 0; ; suffix += 1) {
    const name = suffix ? `ILPFallback${suffix}` : "ILPFallback";
    if (!taken.has(name)) return name;
  }
}

/**
 * Adds the embedded font to the page's `/Resources /Font`, leaving every other resource
 * exactly as it was. Returns the resource name and the object to re-state, which is
 * whichever object actually holds the /Font dictionary: the resources object itself when
 * /Font is written inline, or the separate object it points at.
 */
function addFontResource(editor, resources, type0Number) {
  if (resources?.number === undefined) {
    throw experimentError("RESOURCES_NOT_ADDRESSABLE", "This page's /Resources are not an addressable object, so a font cannot be added to them");
  }
  const indirect = reference(resources.dictionary, "Font");
  if (indirect) {
    const fontObject = editor.document.object(indirect);
    const name = freeResourceName(fontObject.dictionary);
    const updated = fontObject.dictionary.replace(/>>\s*$/, `/${name} ${type0Number} 0 R >>`);
    return { name, number: fontObject.number, generation: fontObject.generation, dictionary: updated };
  }
  const inline = resources.dictionary.match(/\/Font\s*<<([\s\S]*?)>>/);
  if (inline) {
    const name = freeResourceName(inline[1]);
    const dictionary = resources.dictionary.replace(inline[0], `/Font << ${inline[1].trim()} /${name} ${type0Number} 0 R >>`);
    return { name, number: resources.number, generation: resources.generation, dictionary };
  }
  // A page with no /Font at all: give it one rather than refusing.
  const name = "ILPFallback";
  const dictionary = resources.dictionary.replace(/>>\s*$/, `/Font << /${name} ${type0Number} 0 R >> >>`);
  return { name, number: resources.number, generation: resources.generation, dictionary };
}

/* ----------------------------------------------------------------- content stream */

/** Applies disjoint byte-range replacements to a decoded content stream. */
function applyByteEdits(decoded, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const chunks = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) throw experimentError("OVERLAPPING_EDITS", "Two edits to this content stream overlap");
    chunks.push(decoded.subarray(cursor, edit.start), edit.bytes);
    cursor = edit.end;
  }
  chunks.push(decoded.subarray(cursor));
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/**
 * The replacement for one `<operand> Tj` region: switch to the embedded font at the size
 * the run was already drawn at, show the replacement, then switch straight back. Whatever
 * follows in the stream therefore runs under exactly the font state it had before, so no
 * later text is affected -- the reason the restore is emitted even when nothing follows.
 *
 * Only `Tf` is touched. The text matrix, character/word spacing, horizontal scale,
 * render mode, rise and colour are all left to the surrounding stream.
 */
function fontSwitchedOperator(fallbackName, originalFontName, fontSize, glyphBytes, operator) {
  const size = Number.isFinite(fontSize) ? fontSize : 12;
  return encoder.encode(
    `/${fallbackName} ${size} Tf ${new TextDecoder("latin1").decode(encodeHex(glyphBytes))} ${operator} /${originalFontName} ${size} Tf`
  );
}

/* ------------------------------------------------------------------------ the API */

/** Where this experiment's per-editor state lives, created on first use. */
function experimentState(editor) {
  if (!editor.__fontEmbeddingExperiment) {
    editor.__fontEmbeddingExperiment = { fonts: new Map(), streamEdits: new Map() };
  }
  return editor.__fontEmbeddingExperiment;
}

function nextNumbers(editor, count) {
  const used = [editor.document.size, ...[...editor.pendingObjects.keys()].map((number) => number + 1)];
  const start = Math.max(...used);
  return Array.from({ length: count }, (_, index) => start + index);
}

/**
 * Where the text position after a run is set by something other than that run's own
 * advance, so replacing it with glyphs of different widths cannot move anything else.
 * Every other case -- including a stream that ends inside an open text object, which a
 * later stream of the same page may continue from -- is refused.
 */
const POSITION_SAFE_AFTER = new Set(["end-of-text-object", "repositioned"]);

/**
 * The PoC's own preconditions, checked before anything is written. Deliberately narrow:
 * this experiment is isolating font embedding, so anything that would also need layout
 * work is refused rather than attempted.
 */
function fallbackPlan(editor, match, replacement) {
  if (match.span.length !== 1) {
    return experimentError("FALLBACK_MULTI_RUN_UNSUPPORTED", `This experiment replaces a match that sits in one text run; this one spans ${match.span.length}`);
  }
  const [entry] = match.span;
  const runText = [...entry.runText];
  if (entry.charStart !== 0 || entry.charEnd !== runText.length) {
    return experimentError("FALLBACK_PARTIAL_RUN_UNSUPPORTED", "This experiment replaces a whole text run; this match covers only part of one");
  }
  if ([...replacement].length !== runText.length) {
    return experimentError("FALLBACK_LENGTH_CHANGE_UNSUPPORTED", `This experiment keeps the character count; ${[...replacement].length} was given for ${runText.length}`);
  }
  const [objectNumber, runIndex] = entry.runId.split(":").map(Number);
  const stream = editor.streams.find((candidate) => candidate.object.number === objectNumber);
  const run = stream?.runs[runIndex];
  if (!run) return experimentError("FALLBACK_RUN_NOT_FOUND", `Text run ${entry.runId} is no longer present`);
  if (!run.fontName) {
    return experimentError("FALLBACK_NO_ORIGINAL_FONT", "This run has no /Tf font to restore afterwards, so the embedded font could not be switched away from again");
  }
  // Only a plain `Tj`. The rewrite replaces the operand and the operator together, which
  // for a `TJ` would drop the string out of its array and leave `[` unclosed; `'` and `"`
  // carry a line move (and `"` two spacing operands) that this simple switch does not
  // account for. Widening this is for a real implementation, not for isolating embedding.
  if (run.operator !== "Tj") {
    return experimentError("FALLBACK_OPERATOR_UNSUPPORTED", `This experiment replaces text drawn by Tj; this run is drawn by ${run.operator}`);
  }
  // Restoring the font does not restore the text position, and the embedded font's glyphs
  // are not the widths the original's were -- so anything drawn from where this run ends
  // would move. Only replace a run nothing is drawn after.
  if (!POSITION_SAFE_AFTER.has(run.followedBy)) {
    return experimentError(
      "FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE",
      `Text is drawn from where this run ends (${run.followedBy}), so replacing it with glyphs of different widths would move that text. Only a run followed by ET or an explicit Td/TD/Tm/T* is replaced here.`
    );
  }
  if (editor.pending.has(entry.runId)) {
    return experimentError("FALLBACK_RUN_ALREADY_EDITED", `Text run ${entry.runId} already has an edit staged through the ordinary API`);
  }
  return { stream, run, entry };
}

/**
 * Reports whether this match can be replaced with `replacement`, using the embedded
 * fallback font only where the document's own font cannot express the text.
 *
 * Mirrors PdfTextEditor#checkTextMatchReplacement(): the existing path is tried first and
 * reported unchanged, so a replacement the document can already write never drags a
 * multi-megabyte font into the file. Only a FONT_ENCODING_UNSUPPORTED refusal is retried
 * against the fallback font; every other refusal stands as it is.
 */
export async function checkTextMatchReplacementWithFallback(editor, matchId, replacement, { font }) {
  const existing = await editor.checkTextMatchReplacement(matchId, replacement);
  if (existing.allowed) return { ...existing, usesFallbackFont: false };
  if (existing.code !== "FONT_ENCODING_UNSUPPORTED") return { ...existing, usesFallbackFont: false };

  const match = editor.matches.get(matchId);
  const plan = fallbackPlan(editor, match, replacement);
  if (plan instanceof Error) {
    return { allowed: false, mode: null, code: plan.code, reason: plan.message, usesFallbackFont: false };
  }
  const { missing } = glyphIdsFor(font, replacement);
  if (missing !== undefined) {
    return {
      allowed: false,
      mode: null,
      code: "FALLBACK_FONT_MISSING_GLYPH",
      reason: `The fallback font has no glyph for ${JSON.stringify(missing)}`,
      usesFallbackFont: false
    };
  }
  return { allowed: true, mode: "fallback-font-whole-run", usesFallbackFont: true };
}

/**
 * Replaces one match, embedding `font` and switching to it for that run when -- and only
 * when -- the document's own font cannot express the replacement.
 *
 * Everything is staged for PdfTextEditor#save(), which appends it as an incremental
 * update: the original bytes are never rewritten. The embedded font objects are created
 * once per editor and reused, so replacing several runs does not embed the font twice.
 */
export async function replaceTextMatchWithFallbackFont(editor, matchId, replacement, { font }) {
  const verdict = await checkTextMatchReplacementWithFallback(editor, matchId, replacement, { font });
  if (!verdict.allowed) {
    const error = new Error(verdict.reason);
    error.code = verdict.code;
    throw error;
  }
  if (!verdict.usesFallbackFont) {
    // The document's own font can write this: nothing is embedded.
    await editor.replaceTextMatch(matchId, replacement);
    return { usedFallbackFont: false, mode: verdict.mode };
  }

  const state = experimentState(editor);
  const match = editor.matches.get(matchId);
  const { stream, run } = fallbackPlan(editor, match, replacement);
  const { ids } = glyphIdsFor(font, replacement);

  let embedded = state.fonts.get(font);
  if (!embedded) {
    const [type0, cidFont, descriptor, fontFile, toUnicode] = nextNumbers(editor, 5);
    const numbers = { type0, cidFont, descriptor, fontFile, toUnicode };
    const resource = addFontResource(editor, stream.resources, type0);
    embedded = { numbers, resource, glyphs: new Map() };
    state.fonts.set(font, embedded);
    editor.pendingObjects.set(resource.number, { generation: resource.generation, dictionary: resource.dictionary });
  }
  for (const id of ids) embedded.glyphs.set(id.glyphId, id);

  // Rebuilt on every call so the /W array and the ToUnicode CMap cover every glyph drawn
  // so far, not just this replacement's.
  for (const [number, object] of await buildFontObjects(font, embedded.numbers, embedded.glyphs)) {
    editor.pendingObjects.set(number, object);
  }

  const edits = state.streamEdits.get(stream.object.number) ?? [];
  edits.push({
    start: run.start,
    end: run.operatorEnd,
    bytes: fontSwitchedOperator(embedded.resource.name, run.fontName, run.fontSize, identityBytes(ids), run.operator)
  });
  state.streamEdits.set(stream.object.number, edits);

  // Run-level edits staged elsewhere on this same stream are applied alongside, so the
  // whole-stream replacement never silently drops them.
  const runEdits = stream.runs.flatMap((candidate, index) => {
    const bytes = editor.pending.get(`${stream.object.number}:${index}`);
    if (!bytes) return [];
    return [{ start: candidate.start, end: candidate.end, bytes: candidate.syntax === "hex" ? encodeHex(bytes) : encodeLiteral(bytes) }];
  });
  editor.pendingStreams.set(stream.object.number, applyByteEdits(stream.decoded, [...edits, ...runEdits]));

  return {
    usedFallbackFont: true,
    mode: verdict.mode,
    resourceName: embedded.resource.name,
    glyphIds: ids.map((id) => id.glyphId),
    fontObjectNumbers: { ...embedded.numbers }
  };
}
