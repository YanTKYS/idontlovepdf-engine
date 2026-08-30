import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);
const latin1 = new TextDecoder("latin1");

function streamObject(number, content, { compressed = false, dictionary = "" } = {}) {
  const stream = compressed ? deflateSync(content) : encode(content);
  return new Uint8Array([
    ...encode(`${number} 0 obj\n<< /Length ${stream.length}${compressed ? " /Filter /FlateDecode" : ""}${dictionary ? ` ${dictionary}` : ""} >>\nstream\n`),
    ...stream,
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

const catalog = encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
const singlePage = [
  catalog,
  encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
  encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n")
];

test("skips inline image data instead of tokenising it as text", async () => {
  // The image data holds an unbalanced "(", which read as PDF syntax swallows the
  // rest of the stream and aborts the scan with "Malformed PDF literal string".
  const content = "BT (before) Tj ET\nq BI /W 4 /H 1 /BPC 8 /CS /G ID ( EI Q\nBT (after) Tj ET";
  const editor = new PdfTextEditor(buildPdf([...singlePage, streamObject(4, content)]));
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["before", "after"]);
});

test("edits a content stream shared by several pages exactly once", async () => {
  const source = buildPdf([
    catalog,
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    streamObject(4, "BT (Shared) Tj ET"),
    encode("5 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n")
  ]);

  const editor = new PdfTextEditor(source);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.id), ["4:0"]);

  await editor.replaceText("4:0", "Edited");
  const output = await editor.save();
  const appended = latin1.decode(output).slice(source.length);
  assert.equal(appended.match(/^4 0 obj$/gm).length, 1, "the shared object must be appended once");
  assert.equal(appended.match(/^4 1$/gm).length, 1, "its update xref must hold a single subsection");
  assert.equal((await new PdfTextEditor(output).listTextRuns())[0].text, "Edited");
});

test("reports a circular page tree instead of overflowing the stack", async () => {
  const editor = new PdfTextEditor(buildPdf([
    catalog,
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\n")
  ]));
  await assert.rejects(editor.listTextRuns(), /Circular \/Kids chain/);
});

test("lets a newer free xref entry delete an object an older section still lists", async () => {
  const base = buildPdf([...singlePage, streamObject(4, "BT (Gone) Tj ET")]);
  const previous = Number(latin1.decode(base).match(/startxref\n(\d+)/)[1]);
  const update = encode(
    `xref\n0 1\n0000000000 65535 f \n4 1\n0000000000 00001 f \ntrailer\n<< /Size 5 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${base.length}\n%%EOF\n`
  );

  assert.equal((await new PdfTextEditor(base).listTextRuns())[0].text, "Gone");
  await assert.rejects(
    new PdfTextEditor(new Uint8Array([...base, ...update])).listTextRuns(),
    /PDF object 4 is missing from the xref table/
  );
});

test("refuses a predictor-encoded stream rather than decoding it to mangled text", async () => {
  const stream = streamObject(4, "BT (Predicted) Tj ET", {
    compressed: true,
    dictionary: "/DecodeParms << /Predictor 12 /Columns 4 >>"
  });
  await assert.rejects(
    new PdfTextEditor(buildPdf([...singlePage, stream])).listTextRuns(),
    /Unsupported stream filter: FlateDecode with a \/Predictor/
  );
});
