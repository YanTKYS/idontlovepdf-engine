// Whether a real, published PDF can actually be edited end to end -- not just diagnosed.
//
//   node scripts/verify-real-pdf-edit.js <file.pdf> --font <sans-fallback-font.ttf> \
//     [--serif-font <serif-fallback-font.ttf>] \
//     [--search 令和] [--fallback しょ] [--regression 平成] [--unsafe しょうわ] [--out /tmp/edited.pdf]
//
// diagnose-font-metrics.js (v0.4.2) answers "why can this document's font not be measured".
// This answers the actual Go/No-Go question for v0.4.3: given a real PDF whose /F3 needed
// the inline-/DescendantFonts-dictionary fix, does
//
//   listTextRuns() -> searchText() -> setFallbackFont()/setFallbackFonts()
//   -> checkTextMatchReplacement() -> replaceTextMatch() -> save() -> reopen -> searchText()
//
// actually succeed, end to end, through the public API -- the same sequence a real caller
// (idontlovepdf) drives? Nothing here is fixture-only: it is the identical engine surface
// exercised over the identical bytes a real document ships.
//
// v0.4.4 adds a second, opposite question over the same match: does a replacement that
// would overrun the text after it (--unsafe, default しょうわ -- the exact real-world case
// that showed up as しょうわ drawn over the following 8 in 22550.pdf under v0.4.3) get
// refused before anything is written, rather than producing an edited file with characters
// drawn on top of each other? See docs/release-notes.md's v0.4.4 entry for the arithmetic.
//
// v0.5.1 adds --serif-font: when given, both fallback roles are registered via
// setFallbackFonts({ sans, serif }) (v0.5.0), and diagnoseFallbackFontSelection() is printed
// for the match before anything is replaced, so this answers not just "did the fallback
// replacement succeed" but "did it pick the fallback font this document's own FontDescriptor
// actually calls for" -- see docs/serif-classification-diagnosis.md for why that answer was
// wrong for 22550.pdf under v0.5.0. Without --serif-font, behaviour is unchanged from v0.4.4:
// a single setFallbackFont() call, routing every fallback replacement through it regardless
// of classification.
//
// It reads the given PDF, edits an in-memory copy, and (optionally, via --out) writes the
// edited copy to disk for an independent tool (qpdf, pdfminer.six, a browser) to open in a
// later CI step. It never fetches anything itself, and the source PDF this is pointed at is
// never committed to this repository -- see docs/descendant-font-diagnosis.md and
// .github/workflows/diagnose-real-pdf.yml.
import { readFileSync, writeFileSync } from "node:fs";

import { PdfTextEditor } from "../src/index.js";
import { diagnoseFallbackFontSelection } from "../src/pdf-document.js";

const args = process.argv.slice(2);
const file = args.find((argument) => !argument.startsWith("--"));
const optionOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

if (!file) {
  console.error("usage: node scripts/verify-real-pdf-edit.js <file.pdf> --font <sans-fallback-font.ttf> [--serif-font <serif-fallback-font.ttf>] [--search 令和] [--fallback しょ] [--regression 平成] [--unsafe しょうわ] [--out <edited.pdf>]");
  process.exit(2);
}

const fontPath = optionOf("font", null);
if (!fontPath) {
  console.error("--font <sans-fallback-font.ttf> is required (the fallback font used to write text the document's own font cannot).");
  process.exit(2);
}
const serifFontPath = optionOf("serif-font", null);

const searchQuery = optionOf("search", "令和");
const fallbackReplacement = optionOf("fallback", "しょ");
const regressionReplacement = optionOf("regression", "平成");
const unsafeReplacement = optionOf("unsafe", "しょうわ");
const outPath = optionOf("out", null);

const originalBytes = new Uint8Array(readFileSync(file));
const fontBytes = new Uint8Array(readFileSync(fontPath));
const serifFontBytes = serifFontPath ? new Uint8Array(readFileSync(serifFontPath)) : null;

/** setFallbackFonts({sans, serif}) when a serif font was given (v0.5.0+), else the v0.4.x single-font setFallbackFont(). */
async function registerFallbackFonts(editor) {
  if (serifFontBytes) await editor.setFallbackFonts({ sans: fontBytes, serif: serifFontBytes });
  else await editor.setFallbackFont(fontBytes);
}

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

heading(serifFontBytes ? "setFallbackFonts({ sans, serif })" : "setFallbackFont()");
await registerFallbackFonts(editor);
console.log(`fallback font(s) loaded (sans: ${fontBytes.length} bytes${serifFontBytes ? `, serif: ${serifFontBytes.length} bytes` : ""})`);

if (serifFontBytes) {
  heading("diagnoseFallbackFontSelection() -- why this match picked the fallback font it did (v0.5.1)");
  const diagnosis = await diagnoseFallbackFontSelection(editor, target.id);
  console.log(JSON.stringify(diagnosis, (key, value) => (key === "text" ? (value ? `${value.length} chars` : value) : value), 2));
  if (diagnosis.classification === "unknown") {
    console.log(`note: classification is "unknown" (reason: ${diagnosis.reason}) -- this document's own FontDescriptor does not state Serif/Sans plainly enough to read, so the sans role is used, exactly as v0.4.4 always did`);
  }
}

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
console.log(`saved: ${saved.length} bytes (original was ${originalBytes.length}, +${saved.length - originalBytes.length} bytes)`);
const isIncrementalUpdate = saved.length >= originalBytes.length
  && saved.subarray(0, originalBytes.length).every((byte, index) => byte === originalBytes[index]);
console.log(`incremental update (original bytes preserved as a prefix): ${isIncrementalUpdate}`);
if (!isIncrementalUpdate) fail("the saved file's head is not byte-identical to the original -- this should be an incremental update");

if (serifFontBytes) {
  // Which of the two fallback fonts actually got embedded -- the real-world symptom this
  // whole diagnosis exists for (see docs/serif-classification-diagnosis.md): a serif-looking
  // document ending up with BIZ UDゴシック embedded instead of BIZ UD明朝.
  const savedText = new TextDecoder("latin1").decode(saved);
  const embeddedMincho = /\/BaseFont\s*\/BIZUDMincho-Regular/.test(savedText);
  const embeddedGothic = /\/BaseFont\s*\/BIZUDGothic-Regular/.test(savedText);
  console.log(`embedded fallback font BaseFont: ${embeddedMincho ? "BIZUDMincho-Regular" : embeddedGothic ? "BIZUDGothic-Regular" : "(neither found)"}`);
}

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

heading(`checkTextMatchReplacement(${JSON.stringify(unsafeReplacement)}) on the same match, original bytes -- must be refused, not written (v0.4.4)`);
const unsafeEditor = new PdfTextEditor(originalBytes);
await unsafeEditor.listTextRuns();
const [unsafeTarget] = await unsafeEditor.searchText(searchQuery);
await registerFallbackFonts(unsafeEditor);
const unsafeCheck = await unsafeEditor.checkTextMatchReplacement(unsafeTarget.id, unsafeReplacement);
console.log(JSON.stringify(unsafeCheck));
if (unsafeCheck.allowed) {
  fail(`checkTextMatchReplacement(${JSON.stringify(unsafeReplacement)}) was allowed -- this is exactly the overlap this version exists to refuse (see docs/release-notes.md's v0.4.4 entry)`);
} else if (unsafeCheck.code !== "FALLBACK_LAYOUT_UNSUPPORTED" || unsafeCheck.unsafeReason !== "fallback-replacement-overflows-slot") {
  console.log(`note: refused as expected, but for a different reason than the overflow check (code=${unsafeCheck.code}, unsafeReason=${unsafeCheck.unsafeReason ?? "(none)"}) -- this document's structure may not exercise the overflow path for this text`);
} else {
  console.log(`refused as expected: replacementAdvance=${unsafeCheck.diagnostics?.replacementAdvance} availableAdvance=${unsafeCheck.diagnostics?.availableAdvance}`);
}
await unsafeEditor.replaceTextMatch(unsafeTarget.id, unsafeReplacement).then(
  () => fail(`replaceTextMatch(${JSON.stringify(unsafeReplacement)}) did not throw, even though checkTextMatchReplacement() refused it`),
  (error) => console.log(`replaceTextMatch() rejected as expected: ${error.code} (${error.unsafeReason ?? error.message})`)
);
const unsafeSaved = await unsafeEditor.save();
const unsafeUntouched = unsafeSaved.length === originalBytes.length && unsafeSaved.every((byte, index) => byte === originalBytes[index]);
console.log(`document unchanged after the refused replacement: ${unsafeUntouched}`);
if (!unsafeUntouched) fail(`save() after the refused ${JSON.stringify(unsafeReplacement)} replacement did not return the original bytes unchanged`);

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
  unsafeCheck,
  unsafeReplacementUntouchedDocument: unsafeUntouched,
  regressionCheck,
  incrementalUpdate: isIncrementalUpdate
};
console.log(JSON.stringify(summary, null, 2));

if (failed) {
  console.error("\nFAIL: see the FAIL lines above");
  process.exit(1);
}
console.log("\nOK: the fallback replacement and the regression replacement both succeeded end to end");
