import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

function makePdf(content, { compressed = false } = {}) {
  const stream = compressed ? deflateSync(content) : encode(content);
  const objects = [
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    new Uint8Array([
      ...encode(`4 0 obj\n<< /Length ${stream.length}${compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n`),
      ...stream,
      ...encode("\nendstream\nendobj\n")
    ])
  ];
  const chunks = [encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  const xref = offset;
  chunks.push(encode(`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

test("lists literal and hexadecimal text-showing operands", async () => {
  const editor = new PdfTextEditor(makePdf("BT /F1 12 Tf (Hello) Tj [<2057> -20 (orld)] TJ ET"));
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map(({ id, text }) => ({ id, text })), [
    { id: "4:0", text: "Hello" },
    { id: "4:1", text: " W" },
    { id: "4:2", text: "orld" }
  ]);
});

test("writes an incremental update and can reopen its result", async () => {
  const editor = new PdfTextEditor(makePdf("BT (Old\\(text\\)) Tj ET"));
  await editor.replaceText("4:0", "New text");
  const output = await editor.save();
  const reopened = new PdfTextEditor(output);
  assert.equal((await reopened.listTextRuns())[0].text, "New text");
  assert.match(new TextDecoder("latin1").decode(output), /\/Prev \d+/);
});

test("edits FlateDecode streams without an external service", async () => {
  const editor = new PdfTextEditor(makePdf("BT (Offline) Tj ET", { compressed: true }));
  assert.equal((await editor.listTextRuns())[0].text, "Offline");
  await editor.replaceText("4:0", "Local");
  const reopened = new PdfTextEditor(await editor.save());
  assert.equal((await reopened.listTextRuns())[0].text, "Local");
});

test("rejects unsupported Unicode string replacement and unknown run IDs", async () => {
  const editor = new PdfTextEditor(makePdf("BT (Hello) Tj ET"));
  await assert.rejects(editor.replaceText("4:0", "日本語"), /single-byte/);
  await assert.rejects(editor.replaceText("99:0", "nope"), /Unknown text run/);
});
