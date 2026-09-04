// Diagnosis and regression coverage for why 22550.pdf's /F3 (a real, published PDF; see
// docs/serif-classification-diagnosis.md) classified as "unknown" -- and so fell back to
// BIZ UDゴシック instead of BIZ UD明朝 -- under v0.5.0, and what v0.5.1 changes.
//
// Two layers:
//
// - Unit-level, directly against classifyFontResourceDetailed() (src/font-classification.js)
//   with hand-written dictionary text: every developer-facing reason in
//   CLASSIFICATION_REASONS, reached with no PdfTextEditor, no resolve() calls beyond what
//   each specific case needs, and (crucially) no fallback-font dependency -- these never
//   skip. This is where the actual bug reproduces: 22550.pdf's /F3 writes its
//   /DescendantFonts CIDFont dictionary inline (v0.4.3) *and* that CIDFont dictionary's own
//   /FontDescriptor inline too -- a nesting v0.5.0's classifyFontResource() could not read at
//   all, landing on "unknown" regardless of what /Flags actually said.
//
// - Document-level, through PdfTextEditor's public API, reproducing the same inline-
//   FontDescriptor shape end to end (search -> classify -> setFallbackFonts -> check ->
//   replace -> save -> reopen -> search) -- these need the real BIZ UD fonts fetched by
//   `npm run test:font` and skip together, exactly like test/fallback-font-classification.js.
//
// The existing baseline this must not regress -- indirect FontDescriptor with the Serif bit
// set/not set, and no FontDescriptor at all -- is already covered by
// test/fallback-font-classification.test.js and is not duplicated here.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import { diagnoseFallbackFontSelection } from "../src/pdf-document.js";
import { CLASSIFICATION_REASONS, classifyFontResource, classifyFontResourceDetailed } from "../src/font-classification.js";
import { TEST_FONT, TEST_FONT_SERIF, readTestFont, readTestFontSerif } from "../scripts/fetch-test-font.js";
import { CMAP, W_ARRAY, buildPdf, encode, glyphs, streamObject } from "./helpers/document-font.js";
import { inlineDescriptorFontObjects } from "./helpers/document-font-inline-descriptor.js";

const sansBytes = readTestFont();
const serifBytes = readTestFontSerif();
const skip = sansBytes && serifBytes
  ? false
  : `${TEST_FONT.name} and/or ${TEST_FONT_SERIF.name} are not present -- run \`npm run test:font\` to fetch them`;

const latin1 = new TextDecoder("latin1");

/* ------------------------------------------------------ unit-level: reason by reason */

test("CLASSIFICATION_REASONS lists exactly the developer-facing reasons this module reports", () => {
  assert.deepEqual([...CLASSIFICATION_REASONS], [
    "font-descriptor-missing",
    "font-descriptor-unresolved",
    "flags-missing",
    "flags-unresolved",
    "flags-invalid",
    "flags-zero",
    "serif-flag-set",
    "serif-flag-not-set"
  ]);
});

test("no /FontDescriptor at all: font-descriptor-missing", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo >>";
  const resolve = async () => { throw new Error("nothing to resolve -- there is no reference in this dictionary"); };
  assert.deepEqual(await classifyFontResourceDetailed(dictionary, resolve), {
    classification: "unknown",
    reason: "font-descriptor-missing",
    fontDescriptor: { form: null, object: null, text: null },
    flags: { value: null, serifBit: null }
  });
  assert.equal(await classifyFontResource(dictionary, resolve), "unknown");
});

test("an indirect /FontDescriptor whose object cannot be resolved: font-descriptor-unresolved", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo /FontDescriptor 9 0 R >>";
  const resolve = async () => { throw new Error("object 9 does not exist"); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "unknown");
  assert.equal(detail.reason, "font-descriptor-unresolved");
  assert.deepEqual(detail.fontDescriptor, { form: null, object: null, text: null });
});

test("an inline /FontDescriptor stating no /Flags at all: flags-missing", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo "
    + "/FontDescriptor << /Type /FontDescriptor /FontName /Foo >> >>";
  const resolve = async () => { throw new Error("nothing to resolve -- /FontDescriptor is inline and /Flags is absent"); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "unknown");
  assert.equal(detail.reason, "flags-missing");
  assert.equal(detail.fontDescriptor.form, "inline");
  assert.equal(detail.fontDescriptor.object, null);
});

test("an indirect /Flags whose object cannot be resolved: flags-unresolved", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo "
    + "/FontDescriptor << /Type /FontDescriptor /Flags 9 0 R >> >>";
  const resolve = async () => { throw new Error("object 9 does not exist"); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "unknown");
  assert.equal(detail.reason, "flags-unresolved");
  assert.equal(detail.fontDescriptor.form, "inline");
});

test("/Flags present but not a valid number token: flags-invalid", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo "
    + "/FontDescriptor << /Type /FontDescriptor /Flags /NotANumber >> >>";
  const resolve = async () => { throw new Error("/NotANumber is not a reference"); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "unknown");
  assert.equal(detail.reason, "flags-invalid");
});

test("/Flags 0: flags-zero", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo "
    + "/FontDescriptor << /Type /FontDescriptor /Flags 0 >> >>";
  const resolve = async () => { throw new Error("0 is a direct value, not a reference"); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "unknown");
  assert.equal(detail.reason, "flags-zero");
  assert.deepEqual(detail.flags, { value: 0, serifBit: false });
});

test("/Flags with the Serif bit set, direct value, inline FontDescriptor: serif-flag-set", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo "
    + "/FontDescriptor << /Type /FontDescriptor /Flags 34 >> >>";
  const resolve = async () => { throw new Error("34 is a direct value, not a reference"); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "serif");
  assert.equal(detail.reason, "serif-flag-set");
  assert.equal(detail.fontDescriptor.form, "inline");
  assert.deepEqual(detail.flags, { value: 34, serifBit: true });
});

test("/Flags without the Serif bit, indirect FontDescriptor and indirect /Flags: serif-flag-not-set", async () => {
  const dictionary = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo /FontDescriptor 9 0 R >>";
  const resolve = async (target) => {
    if (target.number === 9) return { dictionary: "<< /Type /FontDescriptor /Flags 10 0 R >>" };
    if (target.number === 10) return { value: 32 };
    throw new Error(`unexpected reference ${target.number} 0 R`);
  };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "sans");
  assert.equal(detail.reason, "serif-flag-not-set");
  assert.equal(detail.fontDescriptor.form, "indirect");
  assert.equal(detail.fontDescriptor.object, "9 0 R");
  assert.deepEqual(detail.flags, { value: 32, serifBit: false });
});

/* -------------------------------------------------- unit-level: 22550.pdf's exact shape */

test("Type0 whose inline /DescendantFonts CIDFont dictionary's own /FontDescriptor is also inline (22550.pdf's /F3 shape): serif-flag-set", async () => {
  // No resolve() call should be needed at all: every reference this dictionary contains
  // (/Registry, /Ordering, /FontBBox, /StemV, /FontFile2, /W) is nested *inside* the inline
  // CIDFont dictionary and the inline FontDescriptor, and none of them is /Flags itself.
  const dictionary = "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H "
    + "/DescendantFonts [ << /Type /Font /Subtype /CIDFontType2 /BaseFont /CIDFont+F3 "
    + "/CIDSystemInfo << /Registry 7 0 R /Ordering 8 0 R /Supplement 0 >> /CIDToGIDMap /Identity "
    + "/FontDescriptor << /Type /FontDescriptor /FontName /CIDFont+F3 /Flags 34 "
    + "/FontBBox 9 0 R /StemV 10 0 R /FontFile2 11 0 R >> /W 12 0 R >> ] /ToUnicode 6 0 R >>";
  const resolve = async (target) => { throw new Error(`classification must not need to resolve ${target.number} 0 R -- everything it needs is inline`); };
  const detail = await classifyFontResourceDetailed(dictionary, resolve);
  assert.equal(detail.classification, "serif");
  assert.equal(detail.reason, "serif-flag-set");
  assert.equal(detail.fontDescriptor.form, "inline");
  assert.equal(detail.fontDescriptor.object, null);
  assert.deepEqual(detail.flags, { value: 34, serifBit: true });
});

/* --------------------------------------------------- document-level: full editor lifecycle */

const body = (operators) => `BT /F3 36 Tf 24 60 Td ${operators} ET`;
const TJ = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);

function makeInlineDescriptorPdf(content, flagsClause) {
  const font = inlineDescriptorFontObjects(5, { flagsClause, resourceName: "F3" });
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /F3 ${font.type0} 0 R >> >> >>\nendobj\n`),
    streamObject(4, content),
    ...font.objects
  ]);
}

const fontFile2Count = (pdf) => (latin1.decode(pdf).match(/\/FontFile2/g) ?? []).length;

test("22550.pdf's real structure (inline /DescendantFonts + inline /FontDescriptor, Serif bit set) classifies serif and selects BIZ UD明朝", { skip }, async () => {
  const pdf = makeInlineDescriptorPdf(TJ, "/Flags 34");
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });

  const [match] = await editor.searchText("令和");
  assert.ok(match, "the fixture must contain 令和");

  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "serif");
  assert.equal(diagnosis.reason, "serif-flag-set");
  assert.equal(diagnosis.fontDescriptor.form, "inline");
  assert.equal(diagnosis.selectedRole, "serif");

  // 令和 -> しょ: the fallback-font path this whole diagnosis exists for.
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょ"), { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();

  const reopened = new PdfTextEditor(saved);
  assert.equal((await reopened.searchText("しょ")).length, 1, "the replacement must be searchable after reopening");
  assert.deepEqual(await reopened.searchText("令和"), []);
  assert.equal((await reopened.searchText("8年度")).length, 1, "the text after the match must still be there, undisturbed");

  assert.equal(fontFile2Count(saved), 2, "one /FontFile2 from the fixture's own source font, one from the embedded fallback");
  const text = latin1.decode(saved);
  assert.match(text, /\/BaseFont\s*\/BIZUDMincho-Regular/, "BIZ UD明朝 must be the embedded fallback font's BaseFont");
  assert.ok(!text.includes("BIZUDGothic"), "BIZ UDゴシック must not have been embedded for a document that classifies serif");
});

test("同じ箇所で 令和 -> 平成 は引き続き元 font 経路で成功し、fallback font を埋め込まない (regression)", { skip }, async () => {
  const pdf = makeInlineDescriptorPdf(TJ, "/Flags 34");
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [match] = await editor.searchText("令和");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "平成"), { allowed: true, mode: "single-run" });
  await editor.replaceTextMatch(match.id, "平成");
  const saved = await editor.save();

  assert.equal(fontFile2Count(saved), 1, "only the fixture's own source font -- no fallback font embedded for an own-font replacement");
  assert.ok(!latin1.decode(saved).includes("BIZUDMincho") && !latin1.decode(saved).includes("BIZUDGothic"));

  const reopened = new PdfTextEditor(saved);
  assert.equal((await reopened.searchText("平成")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
});

test("令和 -> しょうわ is re-judged from BIZ UD明朝's own glyph widths, not assumed -- allowed only if it truly does not overlap what follows", { skip }, async () => {
  const pdf = makeInlineDescriptorPdf(TJ, "/Flags 34");
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [match] = await editor.searchText("令和");
  const check = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  if (check.allowed) {
    await editor.replaceTextMatch(match.id, "しょうわ");
    const saved = await editor.save();
    const reopened = new PdfTextEditor(saved);
    assert.equal((await reopened.searchText("しょうわ")).length, 1);
    assert.equal((await reopened.searchText("8年度")).length, 1, "the following text must still be found intact if the replacement was allowed at all");
  } else {
    // Fail closed, exactly as v0.4.4 established: nothing may be written.
    await assert.rejects(() => editor.replaceTextMatch(match.id, "しょうわ"));
    assert.deepEqual(await editor.save(), pdf, "a refused replacement must leave the document byte-for-byte unchanged");
  }
});

test("a source font this cannot classify (dangling indirect /Flags) still falls back to BIZ UDゴシック, not a refusal", { skip }, async () => {
  const pdf = makeInlineDescriptorPdf(TJ, "/Flags 999999 0 R");
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [match] = await editor.searchText("令和");

  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "unknown");
  assert.equal(diagnosis.reason, "flags-unresolved");
  assert.equal(diagnosis.selectedRole, "sans", "unclassifiable must still fall back to the current-compatible sans role, never fail closed by itself");

  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょ"), { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();
  assert.match(latin1.decode(saved), /\/BaseFont\s*\/BIZUDGothic-Regular/);
  assert.ok(!latin1.decode(saved).includes("BIZUDMincho"));
});

test("save -> reopen: BIZ UD明朝 written for an inline-FontDescriptor source document still classifies serif and is reused, not re-embedded", { skip }, async () => {
  const pdf = makeInlineDescriptorPdf(TJ, "/Flags 34");
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [firstMatch] = await editor.searchText("令和");
  await editor.replaceTextMatch(firstMatch.id, "しょ");
  const saved = await editor.save();

  const reopened = new PdfTextEditor(saved);
  await reopened.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [match] = await reopened.searchText("しょ");
  assert.ok(match, "the reopened document must still contain しょ, drawn in the embedded BIZ UD明朝");

  const diagnosis = await diagnoseFallbackFontSelection(reopened, match.id);
  assert.equal(diagnosis.classification, "serif", "BIZ UD明朝's own (indirect) FontDescriptor must still classify serif after reopening");
  assert.equal(diagnosis.selectedRole, "serif");

  // A second edit, in the fallback font already embedded, checked from that font's own
  // glyph widths rather than assumed -- "めいじ" (3 glyphs) is only tried because it is a
  // plausible same-length-ish replacement for "しょ", not because either width is known
  // ahead of time; whichever way checkTextMatchReplacement() decides, that decision (not a
  // guess made here) is what gets exercised below.
  const secondCheck = await reopened.checkTextMatchReplacement(match.id, "めいじ");
  if (secondCheck.allowed) {
    await reopened.replaceTextMatch(match.id, "めいじ");
    const twice = await reopened.save();
    const fontFile2CountAfter = (latin1.decode(twice).match(/\/BaseFont\s*\/BIZUDMincho-Regular/g) ?? []).length;
    assert.equal(fontFile2CountAfter, 1, "BIZ UD明朝 must be embedded exactly once, reused rather than re-embedded on the second edit");
    assert.ok(!latin1.decode(twice).includes("BIZUDGothic"), "BIZ UDゴシック must never have been embedded across either edit");
  } else {
    await assert.rejects(() => reopened.replaceTextMatch(match.id, "めいじ"));
    assert.deepEqual(await reopened.save(), saved, "a refused second edit must leave the once-reopened document unchanged");
  }
});
