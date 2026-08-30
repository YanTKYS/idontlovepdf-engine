import assert from "node:assert/strict";
import test from "node:test";

import { findMatches, matchFeasibility, planReplacement } from "../web/text-search.js";
import { PdfTextEditor } from "../src/index.js";

const run = (id, objectNumber, text, fontName = null) => ({ id, objectNumber, fontName, text, bytes: Uint8Array.of() });

test("finds a match fully contained in a single run", () => {
  const runs = [run("4:0", 4, "令和8年度")];
  const matches = findMatches(runs, "令和8年度");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, "令和8年度");
  assert.equal(matches[0].singleRun, true);
  assert.deepEqual(matches[0].runSpan.map((r) => r.runId), ["4:0"]);
});

test("finds a match spanning several runs from the same content stream", () => {
  const runs = [
    run("28:0", 28, "令"),
    run("28:1", 28, "和"),
    run("28:2", 28, "8"),
    run("28:3", 28, "年度")
  ];
  const matches = findMatches(runs, "令和8年度");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].singleRun, false);
  assert.deepEqual(matches[0].runSpan.map((r) => r.runId), ["28:0", "28:1", "28:2", "28:3"]);
  // Each run contributed exactly its own text to the match.
  assert.deepEqual(matches[0].runSpan.map((r) => [r.charStart, r.charEnd]), [[0, 1], [0, 1], [0, 1], [0, 2]]);
});

test("reports no matches for a string that is not present", () => {
  assert.deepEqual(findMatches([run("4:0", 4, "令和8年度")], "存在しない文字"), []);
});

test("treats an empty search string as no search rather than matching everything", () => {
  assert.deepEqual(findMatches([run("4:0", 4, "令和8年度")], ""), []);
});

test("does not match across a content stream boundary", () => {
  // Stream 4 ends with "令和", stream 9 starts with "8年度"; concatenating them naively
  // would produce a false match for "令和8年度".
  const runs = [
    run("4:0", 4, "令和"),
    run("9:0", 9, "8年度")
  ];
  assert.deepEqual(findMatches(runs, "令和8年度"), []);
  // The pieces are still found within their own stream.
  assert.equal(findMatches(runs, "令和").length, 1);
  assert.equal(findMatches(runs, "8年度").length, 1);
});

test("finds every occurrence of a repeated string", () => {
  const runs = [run("4:0", 4, "令和8年度、令和8年度、令和8年度")];
  const matches = findMatches(runs, "令和8年度");
  assert.equal(matches.length, 3);
  assert.equal(new Set(matches.map((m) => m.id)).size, 3, "match ids must be distinct");
});

test("builds readable context around a match", () => {
  const runs = [run("4:0", 4, "…前文… 令和8年度 事業実施計画 …後文…")];
  const [match] = findMatches(runs, "令和8年度");
  assert.ok(match.context.before.endsWith(" "));
  assert.ok(match.context.after.startsWith(" "));
});

test("marks a single-run match as unconditionally replaceable and a multi-run match as conditional", () => {
  const single = findMatches([run("4:0", 4, "令和8年度")], "令和8年度")[0];
  assert.deepEqual(matchFeasibility(single), { level: "ok", label: "○ 置換可能" });

  const multi = findMatches([run("28:0", 28, "令"), run("28:1", 28, "和")], "令和")[0];
  assert.equal(matchFeasibility(multi).level, "conditional");
  assert.match(matchFeasibility(multi).label, /2runに分割/);
});

test("plans a single-run replacement by rebuilding the whole run text, regardless of length", () => {
  const [match] = findMatches([run("4:0", 4, "Hello World")], "World");
  const plan = planReplacement(match, "there, everyone");
  assert.deepEqual(plan, { kind: "single-run", updates: [{ runId: "4:0", newText: "Hello there, everyone" }] });
});

test("plans a multi-run replacement only when the replacement keeps the original character count", () => {
  const runs = [run("28:0", 28, "令"), run("28:1", 28, "和"), run("28:2", 28, "8"), run("28:3", 28, "年度")];
  const [match] = findMatches(runs, "令和8年度");

  const ok = planReplacement(match, "令和9年度");
  assert.equal(ok.kind, "multi-run");
  assert.deepEqual(ok.updates, [
    { runId: "28:0", newText: "令" },
    { runId: "28:1", newText: "和" },
    { runId: "28:2", newText: "9" },
    { runId: "28:3", newText: "年度" }
  ]);

  const tooShort = planReplacement(match, "令和9年");
  assert.deepEqual(tooShort, { kind: "unsupported", reason: "length-mismatch" });
});

test("keeps the surrounding text of a partial single-run match intact", () => {
  const [match] = findMatches([run("4:0", 4, "prefix-MATCH-suffix")], "MATCH");
  const plan = planReplacement(match, "X");
  assert.deepEqual(plan.updates, [{ runId: "4:0", newText: "prefix-X-suffix" }]);
});

/* -------------------------------------- 実PDFでの検索→置換→save→reopen統合テスト */

const encode = (value) => new TextEncoder().encode(value);

function buildSingleStreamPdf(content) {
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
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `xref\n0 5\n0000000000 65535 f \n${table}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(source);
}

test("finds and replaces a query split across several runs, then reopens the saved PDF", async () => {
  // Mirrors the motivating example ("令和8年度" as five separate Tj operands), using
  // single-byte text so the fixture needs no font/ToUnicode CMap of its own; that
  // encoding path is already covered by test/cmap.test.js and pdf-text-editor.test.js.
  const content = "BT (Before) Tj (FY) Tj (20) Tj (26) Tj (-report) Tj (After) Tj ET";
  const editor = new PdfTextEditor(buildSingleStreamPdf(content));
  const runs = await editor.listTextRuns();

  const [match] = findMatches(runs, "FY2026-report");
  assert.equal(match.runSpan.length, 4);
  assert.equal(matchFeasibility(match).level, "conditional");

  const plan = planReplacement(match, "FY2027-report");
  assert.equal(plan.kind, "multi-run");

  for (const update of plan.updates) await editor.replaceText(update.runId, update.newText);
  const output = await editor.save();

  const reopened = new PdfTextEditor(output);
  const reopenedRuns = await reopened.listTextRuns();
  assert.ok(reopenedRuns.length > 0, "the saved PDF must reopen with editable runs");
  assert.equal(findMatches(reopenedRuns, "FY2027-report").length, 1);
  assert.deepEqual(findMatches(reopenedRuns, "FY2026-report"), []);
  // The runs outside the match must be untouched.
  assert.equal(reopenedRuns[0].text, "Before");
  assert.equal(reopenedRuns.at(-1).text, "After");
});

test("rejects a multi-run replacement whose length does not match, without touching the PDF", async () => {
  const content = "BT (FY) Tj (2026) Tj ET";
  const editor = new PdfTextEditor(buildSingleStreamPdf(content));
  const runs = await editor.listTextRuns();
  const [match] = findMatches(runs, "FY2026");
  const plan = planReplacement(match, "FiscalYear2026");
  assert.deepEqual(plan, { kind: "unsupported", reason: "length-mismatch" });
});
