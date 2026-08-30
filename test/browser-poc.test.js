import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSESSMENT_FIELDS,
  assessPdfBytes,
  classifyError,
  describeRun,
  editedFileName,
  errorDetail,
  formatHex,
  stageFromError,
  stageStatuses,
  statusText,
  summarize,
  toAssessmentJson
} from "../web/poc-core.js";

const encode = (value) => new TextEncoder().encode(value);

function pdfWithContent(content) {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${encode(content).length} >>\nstream\n${content}\nendstream\nendobj\n`
  ];
  let source = "%PDF-1.4\n";
  const offsets = [];
  for (const object of objects) {
    offsets.push(encode(source).length);
    source += object;
  }
  const xref = encode(source).length;
  source += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(source);
}

const minimalPdf = (text = "Browser") => pdfWithContent(`BT (${text}) Tj ET`);

test("assesses browser-loaded bytes through the same stages as the Node CLI", async () => {
  const { record, output } = await assessPdfBytes("sample.pdf", minimalPdf());
  assert.deepEqual(
    [record.file, record.load, record.extract, record.writeback, record.writebackMode, record.save, record.reopen],
    ["sample.pdf", true, true, true, "same-bytes", true, true]
  );
  assert.equal(record.runCount, 1);
  assert.equal(record.readerDisplay, null);
  assert.equal(record.error, null);
  assert.ok(output instanceof Uint8Array && output.length > 0);
});

test("reports the failing stage without throwing and leaves later stages unattempted", async () => {
  const broken = await assessPdfBytes("broken.pdf", encode("not a PDF"));
  assert.equal(broken.output, null);
  assert.match(broken.record.error, /^load: Input is not a PDF/);
  assert.equal(stageFromError(broken.record.error), "load");
  assert.deepEqual(stageStatuses(broken.record), {
    load: false, extract: null, writeback: null, save: null, reopen: null
  });

  const noText = await assessPdfBytes("blank.pdf", pdfWithContent("0 0 m 100 100 l S"));
  assert.equal(stageFromError(noText.record.error), "extract");
  assert.deepEqual(stageStatuses(noText.record), {
    load: true, extract: false, writeback: null, save: null, reopen: null
  });
  assert.equal(classifyError(noText.record.error), "本文runなし");
});

test("classifies known engine errors into readable causes and keeps the raw message", () => {
  const cases = [
    ["extract: Cross-reference streams are not supported by this prototype", "xref stream未対応"],
    ["load: Encrypted PDFs are not supported", "暗号化PDF"],
    ["extract: Unsupported stream filter: ASCII85Decode", "unsupported filter（未対応の圧縮・符号化）"],
    ["extract: PDF object 12 is missing from the xref table", "object stream未対応の可能性（xrefに実体がない）"],
    ["extract: no editable text-showing operands found", "本文runなし"],
    ["writeback: The existing PDF font has no ToUnicode code for \"沖\"", "CMap逆引き失敗（既存fontにその文字のglyphがない可能性）"],
    ["reopen: saved PDF contains no editable text runs", "再読込失敗（保存結果から本文runを取り出せない）"],
    ["extract: Malformed PDF literal string", "content stream解析失敗（文字列トークンが壊れている）"],
    ["extract: Circular /Kids chain in the PDF page tree", "PDF構造が循環している（破損の可能性）"],
    ["extract: Unsupported stream filter: FlateDecode with a /Predictor", "unsupported filter（未対応の圧縮・符号化）"],
    ["replace: 複数run（4run）にまたがる一致のため、置換後の文字数（3）が元の一致の文字数（4）と異なる自動置換には対応していません。", "複数runにまたがるため現在の方式では置換不可"]
  ];
  for (const [message, label] of cases) assert.equal(classifyError(message), label);
  assert.equal(classifyError("save: something entirely new"), "その他のエラー（原文を参照）");
  assert.equal(classifyError(null), null);
  assert.equal(errorDetail("extract: no editable text-showing operands found"), "no editable text-showing operands found");
});

test("formats status text with characters, not colour alone", () => {
  assert.deepEqual(statusText(true), { mark: "○", label: "成功", state: "ok" });
  assert.deepEqual(statusText(false), { mark: "×", label: "失敗", state: "ng" });
  assert.deepEqual(statusText(null), { mark: "-", label: "未実施", state: "skip" });
});

test("names edited downloads after the original file", () => {
  assert.equal(editedFileName("word01.pdf"), "word01.edited.pdf");
  assert.equal(editedFileName("UPPER.PDF"), "UPPER.edited.pdf");
  assert.equal(editedFileName("no-extension"), "no-extension.edited.pdf");
  assert.equal(editedFileName(""), "document.edited.pdf");
});

test("summarises run bytes and marks runs that did not decode", () => {
  assert.equal(formatHex([0x00, 0x01, 0xff]), "00 01 ff");
  assert.equal(formatHex([1, 2, 3, 4], 2), "01 02 … (全4バイト)");
  assert.equal(formatHex([]), "(空)");

  const ok = describeRun({ id: "4:0", objectNumber: 4, fontName: "F1", text: "令和8年度", bytes: Uint8Array.of(0, 1, 0, 2) });
  assert.equal(ok.charCount, 5);
  assert.equal(ok.byteCount, 4);
  assert.equal(ok.decodable, true);

  const broken = describeRun({ id: "4:1", objectNumber: 4, fontName: null, text: "A�", bytes: Uint8Array.of(65, 200) });
  assert.equal(broken.decodable, false);
  assert.equal(broken.fontName, null);

  const control = describeRun({ id: "4:2", objectNumber: 4, fontName: "F1", text: "ab", bytes: Uint8Array.of(97, 1, 98) });
  assert.equal(control.display, "a·b");

  // An empty PDF string `()` really is empty; it did not fail to decode.
  const empty = describeRun({ id: "4:3", objectNumber: 4, fontName: "F1", text: "", bytes: Uint8Array.of() });
  assert.equal(empty.display, "(空文字列)");
  assert.equal(empty.decodable, true);
});

test("builds assessment.json with the required fields and manual readerDisplay", async () => {
  const ok = await assessPdfBytes("good.pdf", minimalPdf());
  const bad = await assessPdfBytes("bad.pdf", encode("not a PDF"));
  const records = [ok.record, bad.record];

  assert.deepEqual(summarize(records), { load: 1, extract: 1, writeback: 1, save: 1, reopen: 1 });

  const parsed = JSON.parse(toAssessmentJson(records));
  assert.equal(parsed.total, 2);
  assert.equal(parsed.writebackMode, "same-bytes");
  for (const result of parsed.results) {
    assert.deepEqual(Object.keys(result), ASSESSMENT_FIELDS);
    assert.equal(result.readerDisplay, null);
    assert.equal(result.writebackMode, "same-bytes");
  }
  assert.deepEqual(parsed.results[0], {
    file: "good.pdf",
    load: true,
    extract: true,
    writeback: true,
    writebackMode: "same-bytes",
    save: true,
    reopen: true,
    runCount: 1,
    readerDisplay: null,
    error: null
  });
  assert.match(parsed.results[1].error, /^load: /);
});
