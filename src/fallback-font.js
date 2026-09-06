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
import { buildSparseSubsetFont, planFontSubsetSupport } from "./font-subset.js";
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

/**
 * A glyph's advance in PDF glyph space -- exactly the number written into the `/W` array
 * by buildFallbackFontObjects() below, and therefore exactly the number a reader will
 * position the text with. Shared with the TJ fallback arithmetic in pdf-document.js, which
 * has to predict that width before the font objects are built: computing it a second way
 * there would let the rounding drift apart from what is actually embedded.
 */
export function glyphSpaceWidth(fallback, advanceWidth) {
  return Math.round(((advanceWidth ?? fallback.unitsPerEm) * PDF_UNITS_PER_EM) / fallback.unitsPerEm);
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
  // Whether buildFallbackFontObjects() can embed only the glyphs actually used (see
  // src/font-subset.js) rather than the whole program -- decided once, from the font's own
  // table structure, so a font this subsetter cannot handle falls back to full-font
  // embedding consistently for the document's whole life rather than depending on which
  // glyphs a particular edit happens to need. `subset.supported` may later be downgraded to
  // false at runtime (see buildFallbackFontObjects()) if building an actual subset fails
  // for a reason this upfront structural check could not see; `subsetNamePrefix` is fixed
  // here and does not change with that later downgrade, so the BaseFont this font is given
  // stays the same whether or not embedding ends up falling back to the full program (see
  // buildFallbackFontObjects() for why that inconsistency is an acceptable, cosmetic one).
  const subset = planFontSubsetSupport(data);
  return {
    bytes: data,
    font,
    // Set by setFallbackFont(), which is async and so can hash the program once.
    digest: null,
    unitsPerEm: font.unitsPerEm,
    // A PDF name, so anything outside the printable ASCII a name may hold is dropped.
    postScriptName: (font.names.postScriptName?.en ?? "FallbackFont").replace(/[^\x21-\x7e]|[\s()<>[\]{}/%#]/g, "") || "FallbackFont",
    // Deflating the font is the slowest step in a save and the result never changes, so
    // it is computed once, on first use, and kept. Full-font embedding only -- a subset's
    // bytes change as glyphs are added, so they are never cached across calls.
    compressed: null,
    subset,
    subsetNamePrefixEnabled: subset.supported
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
 * operand hold glyph ids directly and keeps the mapping trivial to check. When the font
 * supports it (fallback.subset.supported -- see planFontSubsetSupport()), `/FontFile2` is a
 * *sparse* subset (src/font-subset.js): every glyph id keeps the meaning it always had, so
 * `/CIDToGIDMap /Identity` staying exactly as it was is not a coincidence but the reason
 * this subsetting scheme was chosen -- see the module doc comment on src/font-subset.js.
 * When it does not (CFF/CFF2 outlines, a variable font, or a structure this subsetter
 * cannot read), the whole font file is embedded instead, exactly as every version through
 * v0.5.1 always did. Either way `/W` lists only the glyphs actually drawn and `/DW` covers
 * the rest -- a subset embeds more than `/W` mentions (composite components; see
 * expandGlyphSet() in font-subset.js), but never fewer.
 *
 * `glyphs` is every glyph drawn through this font so far, keyed by glyph id, so the
 * widths, the ToUnicode CMap, and (when subsetting) the embedded program itself grow to
 * cover each new replacement -- see adoptExistingFallbackFont() in pdf-document.js for
 * where an existing document's own already-drawn glyphs are read back into this same map
 * before a new replacement's glyphs are added to it, which is what makes a second save
 * extend a first save's subset rather than replace it.
 *
 * A subset is rebuilt from the *entire* current `glyphs` map on every call, however small
 * the change -- there is no "did the set actually grow" check. That costs a parse and a
 * deflate of a few hundred KB on every fallback replacement (see docs/font-subsetting-poc.md
 * for measurements), which is cheap next to what it buys: the embedded program is always
 * provably a superset of every glyph id any content stream in the document currently
 * references, with no bookkeeping anywhere about which glyphs a previous call already
 * embedded that could fall out of sync with what was actually written.
 *
 * `serif` decides one bit of the FontDescriptor this writes: /Flags's Serif bit (PDF
 * 32000-1:2008, 9.8.2, Table 123, bit 2 = value 2), which is what lets
 * font-classification.js read this very font back the same way it classified it going in.
 * Without this, a document that embedded BIZ UD明朝 for a serif source font would, on
 * reopen, classify BIZ UD明朝's own FontDescriptor as "sans" (no Serif bit) -- so editing
 * further text drawn in the fallback font itself (searching its own replaced text and
 * replacing again) would silently switch to BIZ UDゴシック instead of reusing BIZ UD明朝.
 * Nothing else about the descriptor depends on `serif`, and the symbolic bit (4) is set
 * either way: both fallback fonts are still embedded as ordinary symbolic TrueType
 * programs, not as fonts standing in for the document's own standard encoding.
 */
const FALLBACK_FLAGS_SYMBOLIC = 4;
const FALLBACK_FLAGS_SERIF = 2;

/**
 * A subset-font tag in the PDF-conventional `ABCDEF+PostScriptName` shape (PDF 32000-1:2008,
 * 9.6.4): six uppercase letters, deterministic from the *source* font's digest so it stays
 * the same across every save this session and every later session that reopens the same
 * document with the same font -- readers are not required to treat two different tags on
 * the same underlying program as anything in particular, but keeping it stable avoids
 * relying on that. It is derived from `fallback.subsetNamePrefixEnabled`, decided once at
 * parse time, not from whether *this particular* call actually manages to build a subset --
 * see the note on that field in parseFallbackFont() for why a later, rare runtime fallback
 * to full-font embedding deliberately does not change it.
 */
function subsetTag(digestHex) {
  const bytes = digestHex.match(/.{2}/g).slice(0, 6).map((pair) => Number.parseInt(pair, 16));
  return bytes.map((byte) => String.fromCharCode(65 + (byte % 26))).join("");
}

export async function buildFallbackFontObjects(fallback, numbers, glyphs, { programAlreadyEmbedded = false, serif = false } = {}) {
  const { font } = fallback;
  const scale = (value) => Math.round((value * PDF_UNITS_PER_EM) / fallback.unitsPerEm);
  const head = font.tables.head ?? {};
  const os2 = font.tables.os2 ?? {};
  const drawn = [...glyphs.entries()].sort((a, b) => a[0] - b[0]);

  const widths = drawn.map(([glyphId, { advanceWidth }]) => `${glyphId} [${glyphSpaceWidth(fallback, advanceWidth)}]`).join(" ");
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
  const name = fallback.subsetNamePrefixEnabled ? `${subsetTag(fallback.digest)}+${fallback.postScriptName}` : fallback.postScriptName;

  // Adding glyphs to a font this document already carries: the widths and the ToUnicode
  // CMap always change (this is what grows to cover each new replacement); the font
  // program itself is rewritten too, whenever it is a subset (see the function doc comment
  // above), or the first time otherwise.
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

  let embeddingMode = "full-font";
  let fontBytes = fallback.bytes;
  let subsetDiagnostics = null;
  if (fallback.subset.supported) {
    try {
      const built = buildSparseSubsetFont(fallback.bytes, [...glyphs.keys()]);
      fontBytes = built.bytes;
      embeddingMode = "subset";
      subsetDiagnostics = { requestedGlyphs: glyphs.size, includedGlyphs: built.includedGlyphs.size, subsetBytes: built.bytes.length, fullFontBytes: fallback.bytes.length };
    } catch (error) {
      // Never embed a subset that could not be proven correct (composite resolution,
      // checksum construction, an out-of-range glyph id): fall back to the whole font, as
      // if this font had never supported subsetting, for the rest of this fallback font's
      // life -- consistent full-font embedding from here on, not a mix depending on which
      // call happened to fail. `subsetNamePrefixEnabled` (the BaseFont naming) is left
      // exactly as it was: it was already written into the Type0 object, potentially in an
      // earlier call this same session, and cannot un-write itself there -- see the
      // function's doc comment on subsetTag().
      fallback.subset = { supported: false, reason: `subset generation failed at runtime: ${error.message}` };
    }
  }
  fallback.lastEmbedding = { mode: embeddingMode, subset: subsetDiagnostics, reason: fallback.subset.reason };

  // Rewritten whenever the embedded program itself needs to change: always for a subset
  // (it grows with `glyphs`, see above), or the first time for a full font -- once a full
  // font is embedded it already contains every glyph the font has, so no later call ever
  // has anything to add to it. `programAlreadyEmbedded` is true both when this session
  // built it earlier and when a previous session did (see adoptExistingFallbackFont() in
  // pdf-document.js); either way "first time" means the FontFile2 object this fallback font
  // uses does not exist yet at all.
  const mustRewriteFontFile = embeddingMode === "subset" || !programAlreadyEmbedded;
  if (!mustRewriteFontFile) return new Map([descendant, unicodeMap]);

  const fontData = embeddingMode === "full-font" ? (fallback.compressed ??= await deflate(fontBytes)) : await deflate(fontBytes);

  const type0Entry = [numbers.type0, {
    dictionary: `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H`
      + ` /DescendantFonts [${numbers.cidFont} 0 R] /ToUnicode ${numbers.toUnicode} 0 R`
      + ` /${FALLBACK_FONT_MARKER} <${fallback.digest}> >>`
  }];

  const objects = new Map([
    descendant,
    [numbers.descriptor, {
      dictionary: `<< /Type /FontDescriptor /FontName /${name} /Flags ${FALLBACK_FLAGS_SYMBOLIC | (serif ? FALLBACK_FLAGS_SERIF : 0)}`
        + ` /FontBBox [${scale(head.xMin ?? 0)} ${scale(head.yMin ?? 0)} ${scale(head.xMax ?? 0)} ${scale(head.yMax ?? 0)}]`
        + ` /ItalicAngle 0 /Ascent ${scale(font.ascender)} /Descent ${scale(font.descender)}`
        + ` /CapHeight ${scale(os2.sCapHeight ?? font.ascender)} /StemV 80`
        + ` /FontFile2 ${numbers.fontFile} 0 R >>`
    }],
    [numbers.fontFile, {
      dictionary: `<< /Length ${fontData.length} /Length1 ${fontBytes.length} /Filter /FlateDecode >>`,
      data: fontData
    }],
    unicodeMap
  ]);
  // Type0 itself never changes once created (BaseFont, Encoding, the ToUnicode reference,
  // and the source-font-digest marker are all fixed at first embed) -- only added the one
  // time the object does not exist yet.
  if (!programAlreadyEmbedded) objects.set(type0Entry[0], type0Entry[1]);
  return objects;
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

/**
 * A /Font resource name the given font dictionary does not already use. `reserved` is
 * additional names to avoid beyond what `fontDictionary` itself holds -- names another
 * fallback font already claimed on this same page in this same save, which the page's own
 * (not yet rewritten) /Font dictionary text cannot yet know about. See registerFallbackResource()
 * in pdf-document.js, which is what lets two different fallback fonts share one page without
 * colliding on the name given to either.
 */
export function freeResourceName(fontDictionary, reserved = []) {
  const taken = new Set([...fontDictionary.matchAll(/\/([^\s/<>{}[\]()]+)/g)].map((match) => match[1]));
  for (const name of reserved) taken.add(name);
  for (let suffix = 0; ; suffix += 1) {
    const name = suffix ? `ILPFallback${suffix}` : "ILPFallback";
    if (!taken.has(name)) return name;
  }
}
