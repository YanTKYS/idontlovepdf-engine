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
    ["load: Encrypted PDFs are not supported", "暗号化PDF"],
    ["load: Encrypted PDFs are not supported (Standard / AES-128 / R4)", "暗号化PDF（Standard / AES-128 / R4）"],
    ["load: Encrypted PDFs are not supported (Standard以外のSecurity Handler: Adobe.PubSec)", "暗号化PDF（Standard以外のSecurity Handler: Adobe.PubSec）"],
    ["extract: Password required to open this encrypted PDF (Standard / AES-128 / R4)", "暗号化PDF（パスワードが必要）（Standard / AES-128 / R4）"],
    ["writeback: Document modification is not permitted: this PDF's /P permissions disallow content changes (modify permission denied)", "暗号化PDF（文書変更が許可されていません／P permission）"],
    ["save: Saving edits to an encrypted PDF is not supported yet (re-encryption is out of scope for this PR); this PDF can be searched but not saved.", "暗号化PDF（再暗号化保存は未対応）"],
    ["extract: Unsupported stream filter: ASCII85Decode", "unsupported filter（未対応の圧縮・符号化）"],
    ["extract: PDF object 12 is missing from the xref table", "objectがxrefに存在しない（破損の可能性）"],
    ["extract: Object stream index is out of range: object 254 references index 3 in object stream 9, which holds 2 object(s)", "object stream解析失敗（/ObjStm・xref streamのtype 2 entry）"],
    ["extract: Object stream object number mismatch: xref expected object 254, object stream 9 index 3 contains object 260", "object stream解析失敗（/ObjStm・xref streamのtype 2 entry）"],
    ["extract: Malformed object stream /N: 0", "object stream解析失敗（/ObjStm・xref streamのtype 2 entry）"],
    ["extract: Cross-reference stream has an invalid /W", "xref stream解析失敗（/W・/Index・stream長など）"],
    ["extract: Cross-reference stream length does not match /W and /Index", "xref stream解析失敗（/W・/Index・stream長など）"],
    ["extract: no editable text-showing operands found", "本文runなし"],
    ["writeback: The existing PDF font has no ToUnicode code for \"沖\"", "CMap逆引き失敗（既存fontにその文字のglyphがない可能性）"],
    ["reopen: saved PDF contains no editable text runs", "再読込失敗（保存結果から本文runを取り出せない）"],
    ["extract: Malformed PDF literal string", "content stream解析失敗（文字列トークンまたはdictionary/arrayが壊れている）"],
    ["extract: Malformed PDF dictionary in content stream (content stream object 45, byte offset 12)", "content stream解析失敗（文字列トークンまたはdictionary/arrayが壊れている）"],
    ["extract: Circular /Kids chain in the PDF page tree", "PDF構造が循環している（破損の可能性）"],
    ["extract: content stream object 45: Unsupported /Predictor value: 99", "Predictor未対応または不正（値・row長・bit depthなど）"],
    ["extract: content stream object 45: Unsupported TIFF Predictor BitsPerComponent: 4", "Predictor未対応または不正（値・row長・bit depthなど）"],
    ["extract: content stream object 45: PNG predictor row length does not match the stream length", "Predictor未対応または不正（値・row長・bit depthなど）"],
    // The high-level search/replace API's refusals (src/pdf-document.js). Each carries a
    // stable `error.code` too; this only checks that the PoC can still name the cause.
    ["replace: This match is drawn as 5 separate text runs, so a replacement of 3 characters cannot be written over 5 without moving text relative to the PDF's own spacing. Use an equal-length replacement, or an empty one to delete.", "複数runにまたがる一致で置換前後の文字数が異なるため置換不可（MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED）"],
    ["replace: This match spans 2 fonts; replacing it would have to encode its characters through more than one font, which is not supported", "複数fontにまたがる一致のため置換不可（MULTI_RUN_FONT_CHANGE_UNSUPPORTED）"],
    ["replace: This match is stale: the text it was found in has changed since searchText() returned it (run 4:2). Search again and replace the new match.", "検索結果が古くなっている（対象の文字列が変化したため置換を中止）"],
    ["replace: Unknown search match: abc-1 (match ids come from this editor's most recent searchText() call and are superseded by the next one)", "match IDが無効（検索をやり直してください）"],
    ["extract: searchText() requires a non-empty query; an empty string matches nothing rather than every text run", "検索文字列が空"]
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
    error: null,
    encryption: null
  });
  assert.match(parsed.results[1].error, /^load: /);
  assert.equal(parsed.results[1].encryption, null);
});

test("attaches a short encryption summary to the assessment record when extract fails on an encrypted PDF", async () => {
  // Reuses classicEncryptedPdf()'s shape inline: Catalog/Pages/Page/Contents plus an
  // Encrypt object referenced from the trailer.
  const header = encode("%PDF-1.6\n");
  const objects = [
    { number: 1, text: "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" },
    { number: 2, text: "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" },
    { number: 3, text: "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" },
    { number: 5, text: "5 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P -1 >>\nendobj\n" }
  ];
  const chunks = [header];
  const offsets = new Map();
  let pos = header.length;
  for (const object of objects) {
    offsets.set(object.number, pos);
    const bytes = encode(object.text);
    chunks.push(bytes);
    pos += bytes.length;
  }
  offsets.set(4, pos);
  const content = encode("BT (unreachable) Tj ET");
  const streamHead = encode(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  chunks.push(streamHead, content, encode("\nendstream\nendobj\n"));
  pos += streamHead.length + content.length + "\nendstream\nendobj\n".length;

  const xrefOffset = pos;
  const table = [1, 2, 3, 4, 5]
    .map((number) => `${number} 1\n${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`)
    .join("");
  chunks.push(encode(
    `xref\n0 1\n0000000000 65535 f \n${table}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ));
  const pdf = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));

  const { record } = await assessPdfBytes("encrypted.pdf", pdf);
  assert.equal(record.load, true);
  assert.equal(record.extract, false);
  // V2 has no /CF (RC4 is the base algorithm itself, not a named crypt filter), so
  // the short CFM-code `method` is null; V2 is also out of this PR's authentication
  // scope (Standard/V4/R4/AESV2 only -- see src/security/decrypt.js), so
  // authenticated/authType stay false/null regardless of password. modifyAllowed is
  // still readable straight from /P, independent of authentication.
  const expected = { filter: "Standard", V: 2, R: 3, method: null, authenticated: false, authType: null, modifyAllowed: true };
  assert.deepEqual(record.encryption, expected);

  const parsed = JSON.parse(toAssessmentJson([record]));
  assert.deepEqual(parsed.results[0].encryption, expected);
});
