// Whether a real, published PDF can actually be edited end to end -- not just diagnosed.
//
//   node scripts/verify-real-pdf-edit.js <file.pdf> --font <fallback-font.ttf> \
//     [--search 令和] [--fallback しょ] [--regression 平成] [--out /tmp/edited.pdf]
//
// diagnose-font-metrics.js (v0.4.2) answers "why can this document's font not be measured".
// This answers the actual Go/No-Go question for v0.4.3: given a real PDF whose /F3 needed
// the inline-/DescendantFonts-dictionary fix, does
//
//   listTextRuns() -> searchText() -> setFallbackFont() -> checkTextMatchReplacement()
//   -> replaceTextMatch() -> save() -> reopen -> searchText()
//
// actually succeed, end to end, through the public API -- the same sequence a real caller
// (idontlovepdf) drives? Nothing here is fixture-only: it is the identical engine surface
// exercised over the identical bytes a real document ships.
//
// It reads the given PDF, edits an in-memory copy, and (optionally, via --out) writes the
// edited copy to disk for an independent tool (qpdf, pdfminer.six, a browser) to open in a
// later CI step. It never fetches anything itself, and the source PDF this is pointed at is
// never committed to this repository -- see docs/descendant-font-diagnosis.md and
// .github/workflows/diagnose-real-pdf.yml.
import { readFileSync, writeFileSync } from "node:fs";

import { PdfTextEditor } from "../src/index.js";

const args = process.argv.slice(2);
const file = args.find((argument) => !argument.startsWith("--"));
const optionOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

if (!file) {
  console.error("usage: node scripts/verify-real-pdf-edit.js <file.pdf> --font <fallback-font.ttf> [--search 令和] [--fallback しょ] [--regression 平成] [--out <edited.pdf>]");
  process.exit(2);
}

const fontPath = optionOf("font", null);
if (!fontPath) {
  console.error("--font <fallback-font.ttf> is required (the fallback font used to write text the document's own font cannot).");
  process.exit(2);
}

const searchQuery = optionOf("search", "令和");
const fallbackReplacement = optionOf("fallback", "しょ");
const regressionReplacement = optionOf("regression", "平成");
const outPath = optionOf("out", null);

const originalBytes = new Uint8Array(readFileSync(file));
const fontBytes = new Uint8Array(readFileSync(fontPath));

let failed = false;
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  failed = true;
};
const heading = (title) => console.log(`\n== ${title} ==`);

heading(`loading ${file} (${originalBytes.length} bytes)`);
const editor = new PdfTextEditor(originalBytes);
const runs = await editor.listTextRuns();
console.log(`listTextRuns(): ${runs.length} text run(s) across the document`);

heading(`searchText(${JSON.stringify(searchQuery)})`);
const matches = await editor.searchText(searchQuery);
console.log(`${matches.length} match(es)`);
if (!matches.length) {
  fail(`no match for ${JSON.stringify(searchQuery)} -- nothing to edit`);
  console.log(JSON.stringify({ ok: false, reason: "no-match" }));
  process.exit(1);
}
const target = matches[0];
console.log(`editing the first match: id=${target.id} text=${JSON.stringify(target.text)} before=${JSON.stringify(target.before)} after=${JSON.stringify(target.after)} font=${target.fontName}`);

heading("setFallbackFont()");
await editor.setFallbackFont(fontBytes);
console.log(`fallback font loaded (${fontBytes.length} bytes)`);

heading(`checkTextMatchReplacement(${JSON.stringify(fallbackReplacement)}) -- the fallback replacement this exists to prove`);
const fallbackCheck = await editor.checkTextMatchReplacement(target.id, fallbackReplacement);
console.log(JSON.stringify(fallbackCheck));
if (!fallbackCheck.allowed) {
  fail(`checkTextMatchReplacement(${JSON.stringify(fallbackReplacement)}) refused: ${fallbackCheck.code} (${fallbackCheck.unsafeReason ?? fallbackCheck.reason ?? "no detail"})`);
  console.log(JSON.stringify({ ok: false, reason: "fallback-refused", check: fallbackCheck }));
  process.exit(1);
}
if (fallbackCheck.mode !== "fallback-font") {
  console.log(`note: mode is ${fallbackCheck.mode}, not "fallback-font" -- the document's own font may already contain every character of the replacement`);
}

heading(`replaceTextMatch(${JSON.stringify(fallbackReplacement)}) -> save()`);
await editor.replaceTextMatch(target.id, fallbackReplacement);
const saved = await editor.save();
console.log(`saved: ${saved.length} bytes (original was ${originalBytes.length})`);
const isIncrementalUpdate = saved.length >= originalBytes.length
  && saved.subarray(0, originalBytes.length).every((byte, index) => byte === originalBytes[index]);
console.log(`incremental update (original bytes preserved as a prefix): ${isIncrementalUpdate}`);
if (!isIncrementalUpdate) fail("the saved file's head is not byte-identical to the original -- this should be an incremental update");

if (outPath) {
  writeFileSync(outPath, saved);
  console.log(`wrote edited PDF to ${outPath} (not committed, not uploaded as a CI artifact)`);
}

heading("reopen the saved bytes with a new PdfTextEditor");
const reopened = new PdfTextEditor(saved);
await reopened.listTextRuns();

heading(`searchText(${JSON.stringify(fallbackReplacement)}) on the reopened document`);
const foundReplacement = await reopened.searchText(fallbackReplacement);
console.log(`${foundReplacement.length} match(es)`);
if (!foundReplacement.length) fail(`${JSON.stringify(fallbackReplacement)} was not found after reopening the saved PDF`);

heading(`searchText(${JSON.stringify(searchQuery)}) on the reopened document`);
const remaining = await reopened.searchText(searchQuery);
console.log(`${remaining.length} match(es) (before the edit: ${matches.length})`);
if (remaining.length !== matches.length - 1) {
  fail(`expected ${matches.length - 1} remaining match(es) of ${JSON.stringify(searchQuery)}, found ${remaining.length}`);
}

heading(`regression: the same match, 令和-style replacement -> ${JSON.stringify(regressionReplacement)} (independent editor instance, original bytes)`);
const regressionEditor = new PdfTextEditor(originalBytes);
await regressionEditor.listTextRuns();
const [regressionTarget] = await regressionEditor.searchText(searchQuery);
const regressionCheck = await regressionEditor.checkTextMatchReplacement(regressionTarget.id, regressionReplacement);
console.log(JSON.stringify(regressionCheck));
if (!regressionCheck.allowed) {
  fail(`checkTextMatchReplacement(${JSON.stringify(regressionReplacement)}) refused: ${regressionCheck.code} (${regressionCheck.unsafeReason ?? regressionCheck.reason ?? "no detail"})`);
} else {
  await regressionEditor.replaceTextMatch(regressionTarget.id, regressionReplacement);
  const regressionSaved = await regressionEditor.save();
  const regressionReopened = new PdfTextEditor(regressionSaved);
  await regressionReopened.listTextRuns();
  const foundRegression = await regressionReopened.searchText(regressionReplacement);
  console.log(`reopened and found ${JSON.stringify(regressionReplacement)}: ${foundRegression.length} match(es)`);
  if (!foundRegression.length) fail(`${JSON.stringify(regressionReplacement)} was not found after reopening (regression check)`);
}

heading("summary");
const summary = {
  ok: !failed,
  originalBytes: originalBytes.length,
  savedBytes: saved.length,
  runs: runs.length,
  matchesBefore: matches.length,
  matchesAfterFallbackEdit: remaining.length,
  fallbackCheck,
  regressionCheck,
  incrementalUpdate: isIncrementalUpdate
};
console.log(JSON.stringify(summary, null, 2));

if (failed) {
  console.error("\nFAIL: see the FAIL lines above");
  process.exit(1);
}
console.log("\nOK: the fallback replacement and the regression replacement both succeeded end to end");
