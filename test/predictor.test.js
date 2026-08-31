import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { parseDecodeParms, reversePredictor } from "../src/predictor.js";
import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

/*
 * Fixture builders below are an independent PNG/TIFF *encoder*, deliberately not
 * sharing any code with src/predictor.js's decoder. Round-tripping through two
 * independently written implementations is a stronger check than hand-computing a
 * handful of expected bytes: a mistake in the decoder's arithmetic would need to
 * exactly match a mistake in the encoder's to still agree, which is unlikely.
 */

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

/** Encodes `rows` (each a Uint8Array of equal length) into a PNG-predictor stream body. */
function encodePngRows(rows, filterTypes, bytesPerPixel) {
  const rowBytes = rows[0].length;
  const out = [];
  let previous = new Uint8Array(rowBytes);
  rows.forEach((raw, rowIndex) => {
    const filterType = filterTypes[rowIndex];
    out.push(filterType);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? raw[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let value;
      if (filterType === 0) value = raw[index];
      else if (filterType === 1) value = raw[index] - left;
      else if (filterType === 2) value = raw[index] - up;
      else if (filterType === 3) value = raw[index] - Math.floor((left + up) / 2);
      else if (filterType === 4) value = raw[index] - paethPredictor(left, up, upLeft);
      else throw new Error(`fixture bug: unknown filter type ${filterType}`);
      out.push(value & 0xff);
    }
    previous = raw;
  });
  return Uint8Array.from(out);
}

/** Encodes `rows` into a TIFF-predictor-2 stream body (8-bit samples only). */
function encodeTiffRows(rows, colors) {
  const rowBytes = rows[0].length;
  const out = [];
  for (const row of rows) {
    const encoded = Uint8Array.from(row);
    for (let index = rowBytes - 1; index >= colors; index -= 1) {
      encoded[index] = (encoded[index] - encoded[index - colors]) & 0xff;
    }
    out.push(...encoded);
  }
  return Uint8Array.from(out);
}

function flatten(rows) {
  return Uint8Array.from(rows.flatMap((row) => [...row]));
}

function decodeParmsDict(params) {
  const parts = Object.entries(params).map(([key, value]) => `/${key} ${value}`).join(" ");
  return `<< /Filter /FlateDecode /DecodeParms << ${parts} >> >>`;
}

/* ---------------------------------------------------------- 1: Predictor 1 (no-op) */

test("Predictor 1 returns the inflated bytes unchanged", () => {
  const data = Uint8Array.of(1, 2, 3, 4, 5, 250);
  assert.deepEqual(reversePredictor(data, decodeParmsDict({ Predictor: 1 }), "test"), data);
});

/* ---------------------------------------------------------------- 2-6: PNG filters */

test("PNG None (filter type 0) round-trips unchanged data", () => {
  const rows = [Uint8Array.of(10, 20, 30, 40), Uint8Array.of(1, 2, 3, 4)];
  const encoded = encodePngRows(rows, [0, 0], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 10, Columns: 4 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("PNG Sub (filter type 1) reconstructs from the left neighbour", () => {
  const rows = [Uint8Array.of(200, 210, 220, 230)];
  const encoded = encodePngRows(rows, [1], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 11, Columns: 4 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("PNG Up (filter type 2) uses the previous row across several rows", () => {
  const rows = [
    Uint8Array.of(10, 20, 30, 40),
    Uint8Array.of(15, 25, 35, 45),
    Uint8Array.of(255, 0, 128, 64)
  ];
  const encoded = encodePngRows(rows, [0, 2, 2], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 12, Columns: 4 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("PNG Average (filter type 3) matches the standard (left+up)/2 computation", () => {
  const rows = [Uint8Array.of(100, 150, 200), Uint8Array.of(50, 60, 70)];
  const encoded = encodePngRows(rows, [0, 3], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 13, Columns: 3 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("PNG Paeth (filter type 4) matches the standard Paeth predictor", () => {
  const rows = [
    Uint8Array.of(30, 60, 90, 120),
    Uint8Array.of(31, 59, 91, 119)
  ];
  const encoded = encodePngRows(rows, [0, 4], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 14, Columns: 4 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

/* -------------------------------------------------------------------- 7: Predictor 15 */

test("Predictor 15 reads each row's own filter type instead of assuming one for the whole stream", () => {
  const rows = [
    Uint8Array.of(10, 20, 30, 40), // row 1: None
    Uint8Array.of(15, 25, 35, 45), // row 2: Sub
    Uint8Array.of(10, 10, 10, 10), // row 3: Up
    Uint8Array.of(5, 6, 7, 8) // row 4: Paeth
  ];
  const encoded = encodePngRows(rows, [0, 1, 2, 4], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 15, Columns: 4 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("Predictor 10-14 read the same per-row filter byte as 15, per the PDF spec", () => {
  // The numeric /Predictor value (10-15) is documentation, not an instruction to use
  // one filter for the whole stream — every row still carries its own filter-type
  // byte. A stream declared /Predictor 12 (Up) whose rows actually mix filters must
  // still decode correctly.
  const rows = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6), Uint8Array.of(7, 8, 9)];
  const encoded = encodePngRows(rows, [1, 3, 4], 1); // Sub, Average, Paeth
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 12, Columns: 3 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

/* ------------------------------------------------------------------- 8: Colors > 1 */

test("PNG predictor uses the full bytes-per-pixel for Colors > 1, not a hardcoded 1", () => {
  // 2 RGB pixels per row (bytesPerPixel = 3): a decoder that used bytesPerPixel = 1
  // would look at the wrong preceding byte and produce the wrong colors.
  const rows = [
    Uint8Array.of(255, 0, 0, 0, 255, 0), // red, green
    Uint8Array.of(0, 0, 255, 255, 255, 0) // blue, yellow
  ];
  const encoded = encodePngRows(rows, [1, 4], 3);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 15, Columns: 2, Colors: 3, BitsPerComponent: 8 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

/* --------------------------------------------------- 9-11: /DecodeParms defaults */

test("omitted /Columns defaults to 1", () => {
  assert.equal(parseDecodeParms(decodeParmsDict({ Predictor: 12 })).columns, 1);
  const rows = [Uint8Array.of(5), Uint8Array.of(9)];
  const encoded = encodePngRows(rows, [0, 2], 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 12 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("omitted /Colors defaults to 1", () => {
  assert.equal(parseDecodeParms(decodeParmsDict({ Predictor: 15, Columns: 4 })).colors, 1);
});

test("omitted /BitsPerComponent defaults to 8", () => {
  assert.equal(parseDecodeParms(decodeParmsDict({ Predictor: 15, Columns: 4 })).bitsPerComponent, 8);
});

/* --------------------------------------------------------------- 12: malformed row */

test("rejects a stream whose length does not divide into whole predictor rows", () => {
  assert.throws(
    () => reversePredictor(Uint8Array.of(1, 2, 3, 4, 5, 6, 7), decodeParmsDict({ Predictor: 12, Columns: 4 }), "test"),
    /row length does not match the stream length/
  );
});

/* ----------------------------------------------------------- 13: unknown PNG filter */

test("rejects an unrecognised PNG filter type byte", () => {
  const malformed = Uint8Array.of(5, 1, 2, 3, 4); // filter type 5 does not exist
  assert.throws(
    () => reversePredictor(malformed, decodeParmsDict({ Predictor: 15, Columns: 4 }), "test"),
    /Unknown PNG predictor filter type: 5/
  );
});

/* ------------------------------------------------------------------- 14: TIFF Predictor */

test("TIFF Predictor 2 (8-bit) reconstructs samples from the same color component", () => {
  const rows = [Uint8Array.of(10, 200, 20, 55, 130, 70)];
  const encoded = encodeTiffRows(rows, 1);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 2, Columns: 6 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("TIFF Predictor 2 with Colors > 1 references the previous sample of the same component, not the immediately preceding byte", () => {
  const rows = [
    Uint8Array.of(10, 20, 30, 15, 25, 35), // 2 RGB pixels
    Uint8Array.of(1, 2, 3, 4, 5, 6)
  ];
  const encoded = encodeTiffRows(rows, 3);
  const decoded = reversePredictor(encoded, decodeParmsDict({ Predictor: 2, Columns: 2, Colors: 3 }), "test");
  assert.deepEqual(decoded, flatten(rows));
});

test("rejects TIFF Predictor bit depths other than 8", () => {
  for (const bits of [1, 2, 4, 16]) {
    assert.throws(
      () => reversePredictor(Uint8Array.of(1, 2, 3, 4), decodeParmsDict({ Predictor: 2, Columns: 4, BitsPerComponent: bits }), "test"),
      new RegExp(`Unsupported TIFF Predictor BitsPerComponent: ${bits}`)
    );
  }
});

/* --------------------------------------------------------------- other malformed input */

test("rejects an unrecognised /Predictor value", () => {
  assert.throws(
    () => reversePredictor(Uint8Array.of(1, 2, 3), decodeParmsDict({ Predictor: 99, Columns: 3 }), "test"),
    /Unsupported \/Predictor value: 99/
  );
});

test("rejects non-positive /Columns, /Colors, and /BitsPerComponent", () => {
  assert.throws(() => reversePredictor(Uint8Array.of(1), decodeParmsDict({ Predictor: 12, Columns: 0 }), "t"), /invalid \/Columns/);
  assert.throws(() => reversePredictor(Uint8Array.of(1), decodeParmsDict({ Predictor: 12, Columns: 4, Colors: -1 }), "t"), /invalid \/Colors/);
  assert.throws(() => reversePredictor(Uint8Array.of(1), decodeParmsDict({ Predictor: 12, Columns: 4, BitsPerComponent: 0 }), "t"), /invalid \/BitsPerComponent/);
});

test("rejects a /Columns x /Colors x /BitsPerComponent combination that is too large", () => {
  assert.throws(
    () => reversePredictor(Uint8Array.of(1), decodeParmsDict({ Predictor: 12, Columns: 100_000_000, Colors: 100 }), "t"),
    /too large/
  );
});

test("prefixes errors with the caller-supplied stream context", () => {
  assert.throws(
    () => reversePredictor(Uint8Array.of(1, 2, 3), decodeParmsDict({ Predictor: 99 }), "content stream object 45"),
    (error) => error.message === "content stream object 45: Unsupported /Predictor value: 99"
  );
});

/* --------------------------------------------------------- /DecodeParms array form */

test("accepts the single-element array form /DecodeParms [ << ... >> ]", () => {
  const parsed = parseDecodeParms("<< /Filter [ /FlateDecode ] /DecodeParms [ << /Predictor 12 /Columns 4 >> ] >>");
  assert.equal(parsed.predictor, 12);
  assert.equal(parsed.columns, 4);
});

/* ------------------------------------------------------------- 15-17: through PdfTextEditor */

function pngPredictorStream(number, rawContent, { columns = 200, filterType = 2 } = {}) {
  // Pads the real content out to a multiple of `columns` bytes (PNG predictor rows
  // must be a fixed width), decodes back to the original length via /Length on the
  // *content* stream rather than depending on the padding being invisible: PDF content
  // stream syntax tolerates trailing whitespace, so padding with spaces is safe here.
  const raw = encode(rawContent);
  const rowBytes = columns;
  const paddedLength = Math.ceil(raw.length / rowBytes) * rowBytes;
  const padded = new Uint8Array(paddedLength).fill(0x20); // space
  padded.set(raw);
  const rows = [];
  for (let offset = 0; offset < padded.length; offset += rowBytes) rows.push(padded.subarray(offset, offset + rowBytes));
  const encoded = encodePngRows(rows, rows.map(() => filterType), 1);
  const compressed = deflateSync(encoded);
  return new Uint8Array([
    ...encode(`${number} 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns ${columns} >> >>\nstream\n`),
    ...compressed,
    ...encode("\nendstream\nendobj\n")
  ]);
}

function buildPdf(objects) {
  const chunks = [encode("%PDF-1.4\n")];
  const offsets = [];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  const xref = offset;
  const table = offsets.map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(encode(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  ));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

test("extracts text runs from a Predictor-encoded page content stream", async () => {
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    pngPredictorStream(4, "BT (Predictor content) Tj ET")
  ]);
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Predictor content"]);
});

test("decodes a Predictor-encoded ToUnicode CMap stream", async () => {
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 beginbfchar\n<0001> <65E5>\nendbfchar\nendcmap\nend end";
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /FJP 5 0 R >> >> /Contents 4 0 R >>\nendobj\n"),
    encode("4 0 obj\n<< /Length 26 >>\nstream\nBT /FJP 12 Tf <0001> Tj ET\nendstream\nendobj\n"),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    pngPredictorStream(6, cmap, { columns: 40 })
  ]);
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "日");
});

test("replaces text in a Predictor-encoded content stream, then saves and reopens", async () => {
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    pngPredictorStream(4, "BT (Before predictor edit) Tj ET")
  ]);
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  await editor.replaceText(run.id, "After predictor edit");
  const output = await editor.save();
  const reopened = new PdfTextEditor(output);
  assert.deepEqual((await reopened.listTextRuns()).map((r) => r.text), ["After predictor edit"]);
});

test("reads Catalog/Pages/Page/Contents through a Predictor-encoded xref stream", async () => {
  const bigEndian = (value, width) => {
    const bytes = [];
    for (let index = width - 1; index >= 0; index -= 1) bytes.push((value >>> (index * 8)) & 0xff);
    return bytes;
  };
  const header = encode("%PDF-1.5\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode("BT (Via predictor xref stream) Tj ET") }
  ];
  const chunks = [header];
  const offsets = new Map();
  let pos = header.length;
  for (const object of objects) {
    offsets.set(object.number, pos);
    if (object.streamBytes) {
      let piece = encode(`${object.number} 0 obj\n<< /Length ${object.streamBytes.length} >>\nstream\n`);
      chunks.push(piece); pos += piece.length;
      chunks.push(object.streamBytes); pos += object.streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece); pos += piece.length;
    } else {
      const piece = encode(`${object.number} 0 obj\n${object.dictionary}\nendobj\n`);
      chunks.push(piece); pos += piece.length;
    }
  }
  const w = [1, 4, 2];
  const rows = [
    Uint8Array.of(0, ...bigEndian(0, w[1]), ...bigEndian(65535, w[2])),
    ...objects.map((object) => Uint8Array.of(1, ...bigEndian(offsets.get(object.number), w[1]), ...bigEndian(0, w[2])))
  ];
  const rowBytes = w[0] + w[1] + w[2];
  const pngEncoded = encodePngRows(rows, rows.map(() => 2), 1); // Up filter throughout
  const compressed = deflateSync(pngEncoded);
  const dict = `<< /Type /XRef /Size 5 /W [${w.join(" ")}] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${rowBytes} >> /Length ${compressed.length} >>`;
  const xrefOffset = pos;
  let piece = encode(`5 0 obj\n${dict}\nstream\n`);
  chunks.push(piece); pos += piece.length;
  chunks.push(compressed); pos += compressed.length;
  piece = encode("\nendstream\nendobj\n");
  chunks.push(piece); pos += piece.length;
  piece = encode(`startxref\n${xrefOffset}\n%%EOF\n`);
  chunks.push(piece); pos += piece.length;

  const pdf = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Via predictor xref stream"]);
});
