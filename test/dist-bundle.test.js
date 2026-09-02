// Exercises the *built* dist/idontlovepdf-engine.js bundle -- not src/index.js -- to
// prove that bundling with esbuild has not broken the engine's main PDF-structure
// paths (classic xref, cross-reference streams, Object Streams, and ToUnicode
// Japanese text). Run `npm run build` first (the "pretest" npm script does this
// automatically for `npm test`).
//
// This intentionally reuses only a small, self-contained set of PDF-building helpers
// (not every corner case already covered against src/ in test/xref-stream.test.js,
// test/object-stream-resolve.test.js, etc.) -- the goal here is "bundling didn't break
// the main paths", not re-running the full src/ test suite a second time through dist/.
import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { ENGINE_VERSION, PdfTextEditor } from "../dist/idontlovepdf-engine.js";

const encode = (value) => new TextEncoder().encode(value);

function concatChunks(chunks) {
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

function bigEndian(value, width) {
  const bytes = [];
  for (let index = width - 1; index >= 0; index -= 1) bytes.push((value >>> (index * 8)) & 0xff);
  return bytes;
}

test("dist/idontlovepdf-engine.js exports the formal public API", () => {
  assert.equal(typeof PdfTextEditor, "function");
  assert.equal(typeof ENGINE_VERSION, "string");
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+/);
});

/* -------------------------------------------------------------- classic xref PDF */

function streamObject(number, content) {
  const stream = encode(content);
  return concatChunks([
    encode(`${number} 0 obj\n<< /Length ${stream.length} >>\nstream\n`),
    stream,
    encode("\nendstream\nendobj\n")
  ]);
}

function classicPdf(objects) {
  const chunks = [encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  const xref = offset;
  chunks.push(encode(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    `${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  ));
  return concatChunks(chunks);
}

test("processes a normal (classic xref) PDF through the bundle: list, replace, save, reopen", async () => {
  const pdf = classicPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    streamObject(4, "BT (Hello bundle) Tj ET")
  ]);
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "Hello bundle");
  await editor.replaceText(run.id, "Replaced via bundle");
  const output = await editor.save();
  const reopened = new PdfTextEditor(output);
  assert.equal((await reopened.listTextRuns())[0].text, "Replaced via bundle");
});

/* -------------------------------------------------------------- xref stream PDF */

function xrefStreamPdf(content) {
  const header = encode("%PDF-1.5\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode(content) }
  ];
  const chunks = [header];
  const offsets = new Map();
  let pos = header.length;
  for (const object of objects) {
    offsets.set(object.number, pos);
    let piece;
    if (object.streamBytes) {
      piece = encode(`${object.number} 0 obj\n<< /Length ${object.streamBytes.length} >>\nstream\n`);
      chunks.push(piece); pos += piece.length;
      chunks.push(object.streamBytes); pos += object.streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece); pos += piece.length;
    } else {
      piece = encode(`${object.number} 0 obj\n${object.dictionary}\nendobj\n`);
      chunks.push(piece); pos += piece.length;
    }
  }

  const w = [1, 4, 2];
  const entries = [
    { type: 0, field2: 0, field3: 65535 },
    ...objects.map((object) => ({ type: 1, field2: offsets.get(object.number), field3: 0 })),
    { type: 1, field2: pos, field3: 0 }
  ];
  const raw = [];
  for (const entry of entries) raw.push(...bigEndian(entry.type, w[0]), ...bigEndian(entry.field2, w[1]), ...bigEndian(entry.field3, w[2]));
  const data = Uint8Array.from(raw);

  const xrefOffset = pos;
  const dict = `<< /Type /XRef /Size ${entries.length} /W [${w.join(" ")}] /Root 1 0 R /Length ${data.length} >>`;
  const piece = encode(`5 0 obj\n${dict}\nstream\n`);
  chunks.push(piece); pos += piece.length;
  chunks.push(data); pos += data.length;
  chunks.push(encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concatChunks(chunks);
}

test("processes a cross-reference stream (/Type /XRef) PDF through the bundle", async () => {
  const pdf = xrefStreamPdf("BT (Hello xref stream) Tj ET");
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Hello xref stream"]);
});

/* -------------------------------------------------------------- Object Stream PDF */

function objStmPdf(content) {
  const header = encode("%PDF-1.6\n");
  const chunks = [header];
  const offsets = new Map();
  let pos = header.length;

  function place(number, dictionary, streamBytes) {
    offsets.set(number, pos);
    let piece;
    if (streamBytes) {
      piece = encode(`${number} 0 obj\n<< ${dictionary} /Length ${streamBytes.length} >>\nstream\n`);
      chunks.push(piece); pos += piece.length;
      chunks.push(streamBytes); pos += streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece); pos += piece.length;
    } else {
      piece = encode(`${number} 0 obj\n${dictionary}\nendobj\n`);
      chunks.push(piece); pos += piece.length;
    }
  }

  // Objects 1 (Catalog), 2 (Pages), 3 (Page) live packed inside Object Stream 5;
  // Contents (4) stays an ordinary indirect object, as a real Object Stream writer
  // would (PDF spec 7.5.7: stream objects are never compressed into an ObjStm).
  const compressed = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" }
  ];
  place(4, "", encode(content));

  let cursor = 0;
  const bodyOffsets = compressed.map((object) => {
    const offset = cursor;
    cursor += encode(object.dictionary).length;
    return offset;
  });
  const objStmHeader = compressed.map((object, index) => `${object.number} ${bodyOffsets[index]}`).join("\n") + "\n";
  const decoded = encode(objStmHeader + compressed.map((object) => object.dictionary).join(""));
  const firstOffset = encode(objStmHeader).length;
  const objStmData = deflateSync(decoded);
  place(5, `/Type /ObjStm /N ${compressed.length} /First ${firstOffset} /Filter /FlateDecode`, objStmData);

  const w = [1, 4, 2];
  const compressedByNumber = new Map(compressed.map((object, index) => [object.number, index]));
  const usedNumbers = [0, 1, 2, 3, 4, 5];
  const rows = usedNumbers.map((number) => {
    if (number === 0) return Uint8Array.of(0, ...bigEndian(0, w[1]), ...bigEndian(65535, w[2]));
    if (compressedByNumber.has(number)) return Uint8Array.of(2, ...bigEndian(5, w[1]), ...bigEndian(compressedByNumber.get(number), w[2]));
    return Uint8Array.of(1, ...bigEndian(offsets.get(number), w[1]), ...bigEndian(0, w[2]));
  });
  const xrefStmNumber = 6;
  rows.push(Uint8Array.of(1, ...bigEndian(pos, w[1]), ...bigEndian(0, w[2])));
  const indexPairs = [...usedNumbers, xrefStmNumber].map((number) => [number, 1]);
  const data = deflateSync(concatChunks(rows));

  const xrefOffset = pos;
  const dict = `<< /Type /XRef /Size ${xrefStmNumber + 1} /W [${w.join(" ")}] /Index [${indexPairs.flat().join(" ")}]` +
    ` /Root 1 0 R /Filter /FlateDecode /Length ${data.length} >>`;
  chunks.push(concatChunks([
    encode(`${xrefStmNumber} 0 obj\n${dict}\nstream\n`),
    data,
    encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
  ]));
  return concatChunks(chunks);
}

test("processes an Object Stream (/ObjStm) PDF through the bundle", async () => {
  const pdf = objStmPdf("BT (Hello object stream) Tj ET");
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Hello object stream"]);
});

/* -------------------------------------------------------------- ToUnicode Japanese PDF */

function japanesePdf() {
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "2 beginbfchar\n<0001> <65E5>\n<0002> <672C>\nendbfchar\n" +
    "1 beginbfrange\n<0003> <0004> <8A9E>\nendbfrange\nendcmap\nend end";
  return classicPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, "BT /FJP 12 Tf <00010002> Tj ET"),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, cmap)
  ]);
}

test("decodes Japanese text through an existing font's ToUnicode CMap via the bundle", async () => {
  const editor = new PdfTextEditor(japanesePdf());
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "日本");
  assert.equal(run.fontName, "FJP");
  await editor.replaceText(run.id, "語日");
  const [updated] = await new PdfTextEditor(await editor.save()).listTextRuns();
  assert.equal(updated.text, "語日");
});

/* ------------------------------------- multi-run search/replace through the bundle */

/**
 * "令和6年度" drawn the way the problem was reported: one `TJ` array holding five
 * separate string operands with spacing adjustments between them, so the word exists
 * in the PDF only as five text runs. Its font's /ToUnicode CMap also carries "7", so
 * the year can be replaced without embedding anything.
 */
function splitRunJapanesePdf() {
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "6 beginbfchar\n<0001> <4EE4>\n<0002> <548C>\n<0003> <0036>\n<0004> <5E74>\n<0005> <5EA6>\n<0006> <0037>\nendbfchar\n" +
    "endcmap\nend end";
  return classicPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, "BT /FJP 12 Tf 72 700 Td [<0001> 120 <0002> -20 <0003> 0 <0004> 0 <0005>] TJ ET"),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, cmap)
  ]);
}

test("searches and replaces text split across several runs through the bundle, then reopens it", async () => {
  const editor = new PdfTextEditor(splitRunJapanesePdf());

  // The word is five runs, so run-level search could only ever find one character of it.
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["令", "和", "6", "年", "度"]);

  const matches = await editor.searchText("令和6年度");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, "令和6年度");
  assert.equal(matches[0].runCount, 5);

  await editor.replaceTextMatch(matches[0].id, "令和7年度");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["令", "和", "7", "年", "度"]);
  assert.deepEqual(await reopened.searchText("令和6年度"), []);
  assert.equal((await reopened.searchText("令和7年度")).length, 1);
});

test("keeps the bundle's search from joining text across a BT ... ET boundary", async () => {
  const pdf = classicPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    streamObject(4, "BT 72 700 Td (Housing address) Tj ET BT 72 100 Td (John Smith) Tj ET")
  ]);
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual(await editor.searchText("address John"), []);
  assert.equal((await editor.searchText("Housing address")).length, 1);
});

/* ---------------------------- variable-length multi-run replacement via the bundle */

/**
 * "実績報告書" as five operands of one TJ array with every adjustment an explicit zero
 * -- the structure v0.3.0 can safely replace with a different number of characters. The
 * font's CMap also carries the characters the replacement needs.
 */
function zeroAdjustmentJapanesePdf() {
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "8 beginbfchar\n<0001> <5B9F>\n<0002> <7E3E>\n<0003> <5831>\n<0004> <544A>\n<0005> <66F8>\n" +
    "<0006> <4E8B>\n<0007> <696D>\n<0008> <5EA6>\nendbfchar\nendcmap\nend end";
  return classicPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, "BT /FJP 12 Tf 72 700 Td [<0001> 0 <0002> 0 <0003> 0 <0004> 0 <0005>] TJ ET"),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, cmap)
  ]);
}

test("checks and performs a variable-length multi-run replacement through the bundle, then reopens it", async () => {
  const editor = new PdfTextEditor(zeroAdjustmentJapanesePdf());
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["実", "績", "報", "告", "書"]);

  const [match] = await editor.searchText("実績報告書");
  assert.equal(match.runCount, 5);
  // Shorter than the match, across five operands: refused by v0.2.1, allowed here.
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "報告書"), { allowed: true, mode: "variable-length-safe" });

  await editor.replaceTextMatch(match.id, "報告書");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["報告書", "", "", "", ""]);
  assert.deepEqual(await reopened.searchText("実績報告書"), []);
  assert.equal((await reopened.searchText("報告書")).length, 1);

  // And it can be lengthened again from there, through the same API.
  const [again] = await reopened.searchText("報告書");
  await reopened.replaceTextMatch(again.id, "事業報告書");
  assert.equal((await new PdfTextEditor(await reopened.save()).searchText("事業報告書")).length, 1);
});

test("refuses a variable-length replacement across a non-zero TJ adjustment through the bundle", async () => {
  const pdf = classicPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    streamObject(4, "BT 72 700 Td [(RE) 120 (PORT)] TJ ET")
  ]);
  const editor = new PdfTextEditor(pdf);
  const [match] = await editor.searchText("REPORT");
  const check = await editor.checkTextMatchReplacement(match.id, "SUMMARY");
  assert.equal(check.allowed, false);
  assert.equal(check.code, "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED");
  assert.equal(check.unsafeReason, "non-zero-tj-adjustment");
  await assert.rejects(editor.replaceTextMatch(match.id, "SUMMARY"), /MULTI_RUN|cannot be written over/);
});
