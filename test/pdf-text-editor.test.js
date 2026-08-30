import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

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
  const offsets = [0];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  const xref = offset;
  chunks.push(encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

function makePdf(content, { compressed = false, pageDictionary = "", extraObjects = [] } = {}) {
  const objects = [
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R ${pageDictionary} >>\nendobj\n`),
    streamObject(4, content, { compressed }),
    ...extraObjects
  ];
  return buildPdf(objects);
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

test("numbers each BT ... ET block with its own textObjectId, shared by runs within it", async () => {
  const editor = new PdfTextEditor(makePdf("BT (First) Tj (block) Tj ET BT (Second block) Tj ET"));
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map(({ text, textObjectId }) => ({ text, textObjectId })), [
    { text: "First", textObjectId: 0 },
    { text: "block", textObjectId: 0 },
    { text: "Second block", textObjectId: 1 }
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

test("uses xref offsets and stream Length when operator text contains PDF boundary keywords", async () => {
  const editor = new PdfTextEditor(makePdf("BT (endobj stream endstream) Tj ET"));
  assert.equal((await editor.listTextRuns())[0].text, "endobj stream endstream");
  await editor.replaceText("4:0", "still valid");
  assert.equal((await new PdfTextEditor(await editor.save()).listTextRuns())[0].text, "still valid");
});

test("does not scan a non-page stream containing text operators", async () => {
  const decoy = streamObject(5, "BT (metadata-lookalike) Tj ET");
  const editor = new PdfTextEditor(makePdf("BT (page body) Tj ET", { extraObjects: [decoy] }));
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["page body"]);
});

test("decodes and replaces Japanese text through the existing font ToUnicode CMap", async () => {
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n2 beginbfchar\n<0001> <65E5>\n<0002> <672C>\nendbfchar\n1 beginbfrange\n<0003> <0004> <8A9E>\nendbfrange\nendcmap\nend end`;
  const font = encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n");
  const editor = new PdfTextEditor(makePdf("BT /FJP 12 Tf <00010002> Tj ET", {
    pageDictionary: "/Resources << /Font << /FJP 5 0 R >> >>",
    extraObjects: [font, streamObject(6, cmap)]
  }));
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "日本");
  assert.equal(run.fontName, "FJP");
  await editor.replaceText(run.id, "語日");
  const [updated] = await new PdfTextEditor(await editor.save()).listTextRuns();
  assert.equal(updated.text, "語日");
  assert.deepEqual([...updated.bytes], [0, 3, 0, 1]);
});
