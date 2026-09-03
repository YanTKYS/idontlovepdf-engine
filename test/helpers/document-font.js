// The document's own font, as the fallback-font fixtures state it, and the plumbing that
// writes a one-page PDF around it.
//
// A subset, as a real PDF's embedded font is: it knows 令和8年度 and a few more characters
// and NOTHING else -- in particular none of しょうわ, which is what sends a replacement
// down the fallback path.
//
// The widths are deliberately not all 1000. "Japanese is full-width so the widths must
// match" is exactly the assumption these versions are not allowed to make: 8 is 500, 申
// and 請 are 900, で and す are 850, so any rewrite that does not actually do the
// arithmetic moves the page. 令 and 和 are both full-width (1000): the real fallback font
// (BIZ UDGothic) draws every common kanji and hiragana it has at exactly that width, so
// giving 令和 a narrower combined width than that would make the "safe to place" fixtures
// below fail for a reason with nothing to do with what they test -- the fallback font's
// own widths, not the arithmetic that keeps following text in place (see v0.4.4's
// overflow-safety check in planTextArrayRewrite(), src/pdf-document.js).
export const encode = (value) => new TextEncoder().encode(value);

export const FONT = new Map([
  ["令", { code: "0001", width: 1000 }],
  ["和", { code: "0002", width: 1000 }],
  ["8", { code: "0003", width: 500 }],
  ["年", { code: "0004", width: 1000 }],
  ["度", { code: "0005", width: 1000 }],
  ["平", { code: "0006", width: 1000 }],
  ["成", { code: "0007", width: 1000 }],
  ["申", { code: "0008", width: 900 }],
  ["請", { code: "0009", width: 900 }],
  ["で", { code: "000a", width: 850 }],
  ["す", { code: "000b", width: 850 }],
  // A 2-byte code that happens to be 0x0020. Word spacing does NOT reach it -- Tw applies
  // to the single-byte code 32 only -- which the arithmetic has to get right.
  [" ", { code: "0020", width: 300 }]
]);

/** The hex string operand that draws `text` in the font above. */
export const glyphs = (text) => `<${[...text].map((character) => FONT.get(character).code).join("")}>`;

export const CMAP = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
  + `${FONT.size} beginbfchar\n`
  + [...FONT].map(([character, { code }]) => `<${code}> <${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`).join("\n")
  + "\nendbfchar\nendcmap\nend end";

/** The body of the font's `/W`: the numbers a reader positions its text with. */
export const W_ARRAY = [...FONT.values()].map(({ code, width }) => `${Number.parseInt(code, 16)} [${width}]`).join(" ");

export function streamObject(number, content) {
  const stream = encode(content);
  return new Uint8Array([
    ...encode(`${number} 0 obj\n<< /Length ${stream.length} >>\nstream\n`),
    ...stream,
    ...encode("\nendstream\nendobj\n")
  ]);
}

/** A minimal, valid PDF around `objects`, numbered 1..n in the order given. */
export function buildPdf(objects) {
  const chunks = [encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  chunks.push(encode(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + `${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  ));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}
