/**
 * Embedding a caller-supplied font into a PDF, so text can be written in characters the
 * document's own fonts have no code for.
 *
 * The engine's normal path encodes replacement text through the CMap of the font the page
 * already uses, which means it can only write characters the document already contains --
 * a subsetted font's /ToUnicode lists exactly the characters that were used, so
 * 令和 -> 昭和 fails on 昭 in a document that never had one. Given a font, this module
 * produces the PDF objects needed to draw any character that font has, and the callers in
 * pdf-document.js switch to it for the replaced text and straight back afterwards.
 *
 * Everything here is about *encoding*: which glyph, how wide, what Unicode it maps back
 * to. Deciding whether switching fonts is safe for the page's layout is a separate
 * question, answered in pdf-document.js -- an embedded font's glyphs are not the widths
 * the original's were, so a replacement must not be written where anything downstream is
 * drawn from its end.
 */
import opentypeModule from "opentype.js";

import { deflate } from "./flate.js";
import { sha256Hex } from "./sha2.js";

const opentype = opentypeModule.default ?? opentypeModule;
const encoder = new TextEncoder();

/** PDF glyph space is 1000 units per em, whatever the font's own unitsPerEm is. */
const PDF_UNITS_PER_EM = 1000;

/**
 * A `beginbfchar` group may hold at most 100 entries -- the CMap specification says so,
 * and Adobe's ToUnicode note calls `101 beginbfchar` invalid outright. A document edited
 * repeatedly accumulates glyphs, so this is reached by ordinary use, not only by extremes.
 */
const MAX_BFCHAR_ENTRIES = 100;

/**
 * Marks a Type0 font as one this engine embedded, and says exactly which font program it
 * holds -- a SHA-256 of the bytes. Readers ignore keys they do not know; this one lets a
 * later session recognise its own work and add to it rather than embedding a second copy
 * of the same multi-megabyte font (see adoptExistingFallbackFont() in pdf-document.js).
 *
 * A digest rather than a name and a size: reusing an embedded program means writing new
 * text with glyph ids resolved against the font the caller supplied now, so the two must
 * be the same program byte for byte. Two builds of one family share a name and can share
 * a length while numbering their glyphs differently, and mistaking one for the other
 * would draw the wrong characters -- silently, and only in the text added last.
 */
export const FALLBACK_FONT_MARKER = "ILPFallbackFont";

/**
 * A SHA-256 of the font program, as lowercase hex.
 *
 * Via src/sha2.js rather than `crypto.subtle` directly: Web Crypto is unavailable to a
 * page served over plain HTTP, and embedding a fallback font must work there -- see the
 * note in that module.
 */
export async function fingerprintFont(bytes) {
  return sha256Hex(bytes);
}

const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, "0");

/** A ToUnicode destination: the character as UTF-16BE, which is what a bfchar holds. */
function utf16beHex(text) {
  let output = "";
  for (let index = 0; index < text.length; index += 1) output += hex4(text.charCodeAt(index));
  return output;
}

function fontError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Parses a font once, so an editor embedding it pays for the parse (and, later, the
 * compression) a single time however many replacements use it.
 *
 * Must be a TrueType (glyf-outline) font: PDF embeds those as /FontFile2, which is the
 * only font stream form this writes.
 */
export function parseFallbackFont(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let font;
  try {
    // opentype.js wants a standalone ArrayBuffer, not a view into a larger one.
    font = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  } catch (error) {
    throw fontError("FALLBACK_FONT_INVALID", `The fallback font could not be read: ${error.message}`);
  }
  if (font.outlinesFormat !== "truetype") {
    throw fontError("FALLBACK_FONT_INVALID", `The fallback font must have TrueType outlines to be embedded as /FontFile2; this one is ${font.outlinesFormat}`);
  }
  return {
    bytes: data,
    font,
    // Set by setFallbackFont(), which is async and so can hash the program once.
    digest: null,
    unitsPerEm: font.unitsPerEm,
    // A PDF name, so anything outside the printable ASCII a name may hold is dropped.
    postScriptName: (font.names.postScriptName?.en ?? "FallbackFont").replace(/[^\x21-\x7e]|[\s()<>[\]{}/%#]/g, "") || "FallbackFont",
    // Deflating the font is the slowest step in a save and the result never changes, so
    // it is computed once, on first use, and kept.
    compressed: null
  };
}

/**
 * Unicode -> glyph id, through the font's own cmap.
 *
 * Glyph 0 is .notdef, which is what opentype.js returns for a character the font does not
 * have. Reported as missing rather than drawn, so a replacement never silently becomes a
 * row of empty boxes. Iterating the string yields code points, so a character outside the
 * BMP is looked up once rather than as two halves of a surrogate pair.
 */
export function glyphsFor(fallback, text) {
  const glyphs = [];
  const missing = [];
  for (const character of text) {
    const glyph = fallback.font.charToGlyph(character);
    if (!glyph || !glyph.index) missing.push(character);
    else glyphs.push({ character, glyphId: glyph.index, advanceWidth: glyph.advanceWidth ?? fallback.unitsPerEm });
  }
  return missing.length ? { missing } : { glyphs };
}

/** Identity-H addresses glyphs directly: the string operand is 2-byte big-endian ids. */
export function identityEncode(glyphs) {
  const bytes = new Uint8Array(glyphs.length * 2);
  glyphs.forEach(({ glyphId }, index) => {
    bytes[index * 2] = (glyphId >> 8) & 0xff;
    bytes[index * 2 + 1] = glyphId & 0xff;
  });
  return bytes;
}

/**
 * The PDF objects an embedded TrueType font addressed by glyph id needs:
 *
 *   Type0 (Identity-H)  ->  CIDFontType2 descendant  ->  FontDescriptor  ->  FontFile2
 *                       \-> ToUnicode CMap
 *
 * `/CIDToGIDMap /Identity` makes the CID *be* the glyph id, which is what lets a string
 * operand hold glyph ids directly and keeps the mapping trivial to check. The whole font
 * file is embedded -- subsetting is deliberately out of scope, see the release notes --
 * so `/W` lists only the glyphs actually drawn and `/DW` covers the rest.
 *
 * `glyphs` is every glyph drawn through this font so far, keyed by glyph id, so the
 * widths and the ToUnicode CMap grow to cover each new replacement.
 */
export async function buildFallbackFontObjects(fallback, numbers, glyphs, { programAlreadyEmbedded = false } = {}) {
  const { font } = fallback;
  const scale = (value) => Math.round((value * PDF_UNITS_PER_EM) / fallback.unitsPerEm);
  const head = font.tables.head ?? {};
  const os2 = font.tables.os2 ?? {};
  const drawn = [...glyphs.entries()].sort((a, b) => a[0] - b[0]);

  const widths = drawn.map(([glyphId, { advanceWidth }]) => `${glyphId} [${scale(advanceWidth)}]`).join(" ");
  const bfchar = [];
  for (let start = 0; start < drawn.length; start += MAX_BFCHAR_ENTRIES) {
    const group = drawn.slice(start, start + MAX_BFCHAR_ENTRIES);
    bfchar.push(`${group.length} beginbfchar\n${group.map(([glyphId, { character }]) => `<${hex4(glyphId)}> <${utf16beHex(character)}>`).join("\n")}\nendbfchar`);
  }
  const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${bfchar.join("\n")}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const toUnicodeData = encoder.encode(toUnicode);
  const name = fallback.postScriptName;

  // Adding glyphs to a font this document already carries: only the widths and the
  // ToUnicode CMap change. Rewriting the font program too would append another copy of it
  // -- megabytes -- on every save.
  const descendant = [numbers.cidFont, {
    dictionary: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name}`
      + ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`
      + ` /FontDescriptor ${numbers.descriptor} 0 R /DW ${PDF_UNITS_PER_EM} /W [${widths}]`
      + ` /CIDToGIDMap /Identity >>`
  }];
  const unicodeMap = [numbers.toUnicode, {
    dictionary: `<< /Length ${toUnicodeData.length} >>`,
    data: toUnicodeData
  }];
  if (programAlreadyEmbedded) return new Map([descendant, unicodeMap]);

  fallback.compressed ??= await deflate(fallback.bytes);
  const fontData = fallback.compressed;

  return new Map([
    [numbers.type0, {
      dictionary: `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H`
        + ` /DescendantFonts [${numbers.cidFont} 0 R] /ToUnicode ${numbers.toUnicode} 0 R`
        + ` /${FALLBACK_FONT_MARKER} <${fallback.digest}> >>`
    }],
    descendant,
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
    unicodeMap
  ]);
}

/**
 * The glyphs a previously embedded copy of this font already carries, read back from its
 * ToUnicode CMap so a later session's widths and CMap cover them as well as its own.
 * `mappings` is what parseToUnicodeCMap() returns: a 4-hex-digit code -- which for
 * Identity-H is the glyph id -- to the text it stands for.
 */
export function glyphsFromToUnicode(fallback, mappings) {
  const glyphs = new Map();
  for (const [code, character] of mappings) {
    const glyphId = Number.parseInt(code, 16);
    if (!Number.isInteger(glyphId) || !glyphId) continue;
    const glyph = fallback.font.glyphs.get(glyphId);
    glyphs.set(glyphId, { character, glyphId, advanceWidth: glyph?.advanceWidth ?? fallback.unitsPerEm });
  }
  return glyphs;
}

/** A /Font resource name the given font dictionary does not already use. */
export function freeResourceName(fontDictionary) {
  const taken = new Set([...fontDictionary.matchAll(/\/([^\s/<>{}[\]()]+)/g)].map((match) => match[1]));
  for (let suffix = 0; ; suffix += 1) {
    const name = suffix ? `ILPFallback${suffix}` : "ILPFallback";
    if (!taken.has(name)) return name;
  }
}
