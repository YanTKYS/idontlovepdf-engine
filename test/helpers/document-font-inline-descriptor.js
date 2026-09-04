// A Type0/Identity-H font whose /DescendantFonts array holds its CIDFont dictionary written
// inline, and whose CIDFont dictionary's own /FontDescriptor is itself written inline -- the
// exact shape a real, published PDF (22550.pdf's /F3; see
// docs/serif-classification-diagnosis.md) writes both in. /FontBBox, /StemV and /FontFile2
// are indirect, matching that real document, so a fixture built on this exercises the same
// nested-reference reading /DescendantFonts already needed (v0.4.3) alongside the inline
// /FontDescriptor v0.5.1 adds -- rather than a simplified shape that would not actually
// reproduce the bug either fix exists for.
import { CMAP, W_ARRAY, encode, streamObject } from "./document-font.js";

/**
 * `flagsClause` is the literal text placed inside the inline FontDescriptor where `/Flags
 * ...` would go -- `"/Flags 34"` (serif), `"/Flags 4"` (sans, matching PDF Table 123's
 * Symbolic bit only), `"/Flags 999999 0 R"` (an indirect reference to an object nothing
 * defines, for a deliberately unresolvable /Flags), or `""` to omit /Flags entirely. The
 * six supporting objects (CIDSystemInfo's /Registry and /Ordering, /FontBBox, /StemV,
 * /FontFile2, /W) are always emitted in the same shape 22550.pdf's /F3 actually uses,
 * whether or not `flagsClause` ends up readable.
 */
export function inlineDescriptorFontObjects(startAt, { flagsClause, resourceName }) {
  const [type0, cmap, registry, ordering, fontBBox, stemV, fontFile2, widths] = Array.from({ length: 8 }, (_, index) => startAt + index);
  const cidFontDictionary = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CIDFont+Doc "
    + `/CIDSystemInfo << /Registry ${registry} 0 R /Ordering ${ordering} 0 R /Supplement 0 >> /CIDToGIDMap /Identity `
    + `/FontDescriptor << /Type /FontDescriptor /FontName /CIDFont+Doc ${flagsClause} `
    + `/FontBBox ${fontBBox} 0 R /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 `
    + `/StemV ${stemV} 0 R /FontFile2 ${fontFile2} 0 R >> `
    + `/W ${widths} 0 R >>`;
  const objects = [
    encode(`${type0} 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H /DescendantFonts [ ${cidFontDictionary} ] /ToUnicode ${cmap} 0 R >>\nendobj\n`),
    streamObject(cmap, CMAP),
    encode(`${registry} 0 obj\n(Adobe)\nendobj\n`),
    encode(`${ordering} 0 obj\n(Identity)\nendobj\n`),
    encode(`${fontBBox} 0 obj\n[0 -200 1000 800]\nendobj\n`),
    encode(`${stemV} 0 obj\n80\nendobj\n`),
    encode(`${fontFile2} 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n`),
    encode(`${widths} 0 obj\n[${W_ARRAY}]\nendobj\n`)
  ];
  return { objects, type0, resourceName, nextObject: startAt + objects.length };
}
