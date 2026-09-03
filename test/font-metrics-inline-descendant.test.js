// The shape v0.4.3 exists for: `/DescendantFonts [ << ...CIDFont dictionary... >> ]`, where
// the array's one element (PDF 9.7.6.2 makes it exactly one) is a dictionary written right
// there instead of a reference to one. This is not a synthetic corner case -- it is what
// 22550.pdf (a real, published PDF; see docs/descendant-font-diagnosis.md) writes for its
// /F3, and v0.4.2 misread it: parseReferenceArray() searched the *entire* array text with a
// reference-matching regex, so every indirect reference nested inside the inline CIDFont
// dictionary (/Ordering, /Registry, /FontBBox, /StemV, /FontFile2, /W) was counted as if it
// were an element of the array itself, and the font was refused as descendant-font-unresolved
// with six "elements" instead of measured with its one real one.
//
// v0.4.3 reads the array's top-level elements with topLevelArrayElements() (see
// pdf-dictionary-text.js), which walks the array one whole value at a time -- so a reference
// nested three levels inside the one element's own dictionary is never mistaken for a second
// element next to it.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import { diagnoseFontMetrics } from "../src/pdf-document.js";
import { TEST_FONT, readTestFont } from "../scripts/fetch-test-font.js";
import { fontTable, simulate } from "./helpers/text-advance.js";
import { CMAP, W_ARRAY, buildPdf, encode, glyphs, streamObject } from "./helpers/document-font.js";

const fontBytes = readTestFont();
const skip = fontBytes ? false : `${TEST_FONT.name} is not present -- run \`npm run test:font\` to fetch it`;

const latin1 = new TextDecoder("latin1");
const body = (operators) => `BT /F3 36 Tf 24 60 Td ${operators} ET`;
const TJ = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);

/**
 * The one CIDFont dictionary the array holds, written inline -- with several indirect
 * references nested inside it (/Registry, /Ordering, /FontBBox, /StemV, /FontFile2, /W),
 * exactly the shape 22550.pdf's /F3 writes it in. Each is a knob so the malformed fixtures
 * further down can change exactly one thing.
 */
// buildPdf() below numbers objects by their position in the array it is given (see its own
// docstring), not by whatever "N 0 obj" text a fixture happens to write -- so these must
// name the objects that actually land at objects 7-12: the base fixture is always six
// objects (Catalog, Pages, Page, content stream, /F3, /ToUnicode stream), and these are
// appended right after.
function inlineCidFontDictionary({
  subtype = "/CIDFontType2",
  widths = "/W 12 0 R",
  cidToGidMap = "/CIDToGIDMap /Identity",
  extra = ""
} = {}) {
  return "<< /Type /Font /Subtype " + subtype + " /BaseFont /CIDFont+F3 "
    + "/CIDSystemInfo << /Registry 7 0 R /Ordering 8 0 R /Supplement 0 >> "
    + cidToGidMap + " "
    + "/FontDescriptor << /Type /FontDescriptor /FontName /CIDFont+F3 /Flags 4 "
    + "/FontBBox 9 0 R /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 "
    + "/StemV 10 0 R /FontFile2 11 0 R >> "
    + widths + extra + " >>";
}

const NESTED_REFERENCE_OBJECTS = [
  "7 0 obj\n(Adobe)\nendobj\n",
  "8 0 obj\n(Identity)\nendobj\n",
  "9 0 obj\n[0 -200 1000 800]\nendobj\n",
  "10 0 obj\n80\nendobj\n",
  // A dummy /FontFile2 stream: nothing in width measurement ever reads it, so its content
  // does not matter, only that it exists as one more reference nested inside the inline
  // dictionary that must not be counted as an array element.
  "11 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n",
  `12 0 obj\n[${W_ARRAY}]\nendobj\n`
];

/**
 * A minimal PDF whose `/F3` writes `/DescendantFonts` as `[ <descendantFonts> ]` --
 * `descendantFonts` is the whole array's text between the brackets, so both the safe inline
 * dictionary and the malformed shapes (two elements, a reference beside a dictionary, an
 * empty array, ...) can be built from the same fixture.
 */
function makeInlinePdf({
  content = TJ,
  descendantFonts = inlineCidFontDictionary(),
  extraObjects = NESTED_REFERENCE_OBJECTS
} = {}) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /F3 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode(`5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H /DescendantFonts [ ${descendantFonts} ] /ToUnicode 6 0 R >>\nendobj\n`),
    streamObject(6, CMAP),
    ...extraObjects.map(encode)
  ]);
}

const streamTextOf = async (pdf) => {
  const editor = new PdfTextEditor(pdf);
  await editor.listTextRuns();
  return latin1.decode(editor.streams[0].decoded);
};

/** Replaces `query` with `replacement` and reports where everything ended up drawn. */
async function replaceAndMeasure(pdf, query, replacement, expectedMode) {
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText(query);
  assert.ok(match, `the fixture must contain ${query}`);
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, replacement), { allowed: true, mode: expectedMode });
  await editor.replaceTextMatch(match.id, replacement);
  const saved = await editor.save();
  return {
    saved,
    reopened: new PdfTextEditor(saved),
    before: simulate(await streamTextOf(pdf), fontTable(pdf)),
    after: simulate(await streamTextOf(saved), fontTable(saved)),
    stream: await streamTextOf(saved)
  };
}

/* ------------------------------------------------------------------ the safe structure */

test("measures a CID font whose /DescendantFonts array element is an inline dictionary", { skip }, async () => {
  const pdf = makeInlinePdf();
  const text = latin1.decode(pdf);
  assert.match(text, /\/DescendantFonts \[ << \/Type \/Font \/Subtype \/CIDFontType2/, "the fixture must write the CIDFont dictionary inline, not as a reference");
  assert.doesNotMatch(text, /\/DescendantFonts \[\s*\d+\s+\d+\s+R/, "the fixture must not accidentally be a reference array");

  const { saved, reopened, before, after, stream } = await replaceAndMeasure(pdf, "令和", "しょ", "fallback-font");

  // Same arithmetic as the indirect-/W fixture: 令和 is 1000 + 950, しょ is 1000 + 1000.
  assert.match(stream, /\/F3 36 Tf \[50 -50 <000300040005>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F3" && glyph.code >= 0x0003).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before), "every glyph after the match must be drawn where it was -- checked against the independent text-advance simulator, not the engine's own arithmetic");

  // save -> reopen -> search, both directions.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ", "8年度"]);
  assert.equal((await reopened.searchText("しょ")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
  assert.equal((await reopened.searchText("8年度")).length, 1);
  assert.deepEqual(saved.subarray(0, pdf.length), pdf, "the original file must still be the head of the saved incremental update");
});

test("同じ箇所で 令和 -> 平成 も従来どおり成功する (regression against the ordinary, non-fallback path)", { skip }, async () => {
  const editor = new PdfTextEditor(makeInlinePdf());
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "平成"), { allowed: true, mode: "single-run" });
  await editor.replaceTextMatch(match.id, "平成");
  const saved = await editor.save();
  const reopened = new PdfTextEditor(saved);
  assert.equal((await reopened.searchText("平成")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
});

test("does not mistake a reference nested inside the inline dictionary for a second array element", { skip }, async () => {
  const editor = new PdfTextEditor(makeInlinePdf());
  const [font] = await diagnoseFontMetrics(editor);

  assert.equal(font.codeBytes, 2, "the widths must be readable");
  assert.match(font.descendant ?? "", /\/Subtype \/CIDFontType2/);
  assert.match(font.descendant ?? "", /\/W 12 0 R/);

  const entryStep = font.descendantTrace[0];
  assert.equal(entryStep.step, "descendant-fonts-entry");
  assert.equal(entryStep.form, "direct-array");
  assert.equal(entryStep.accepted, true, "the array's one inline-dictionary element must be accepted, not counted as several");
  // The six references nested inside the inline dictionary (/Registry, /Ordering,
  // /FontBBox, /StemV, /FontFile2, /W) must never appear here: this field names the
  // array's own top-level elements, and there are none that are references at all.
  assert.deepEqual(entryStep.references, []);

  const inlineStep = font.descendantTrace.find((step) => step.step === "inline-dictionary");
  assert.ok(inlineStep, "the walk must record that it ended on a dictionary written right in the array");
  for (const nested of ["7 0 R", "8 0 R", "9 0 R", "10 0 R", "11 0 R", "12 0 R"]) {
    assert.ok(inlineStep.text.includes(nested), `the recorded dictionary text must still contain ${nested} as part of its own value, just not as an array element`);
  }
  // No object number: the CIDFont here is not an object of its own.
  assert.equal(font.descendantObjectNumber, null);

  const width = font.related.find((item) => item.key === "descendant /W");
  assert.ok(width, "the /W object nested inside the inline dictionary must still be resolved");
  assert.equal(width.reference, "12 0 R");
});

/* --------------------------------------------------------------------- and the unsafe ones */

test("refuses a direct array holding the inline dictionary twice", { skip }, async () => {
  const pdf = makeInlinePdf({ descendantFonts: `${inlineCidFontDictionary()} ${inlineCidFontDictionary()}` });
  const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
  assert.equal(font.reason, "descendant-font-unresolved");
  assert.equal(font.metrics, null);
  assert.equal(font.descendantObjectNumber, null);
  const entryStep = font.descendantTrace.at(-1);
  assert.equal(entryStep.step, "descendant-fonts-entry");
  assert.equal(entryStep.accepted, false);
});

test("refuses an array mixing a reference and an inline dictionary", { skip }, async () => {
  const pdf = makeInlinePdf({
    descendantFonts: `13 0 R ${inlineCidFontDictionary()}`,
    extraObjects: [...NESTED_REFERENCE_OBJECTS, `13 0 obj\n${inlineCidFontDictionary()}\nendobj\n`]
  });
  const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
  assert.equal(font.reason, "descendant-font-unresolved");
  assert.equal(font.metrics, null);
  assert.equal(font.descendantObjectNumber, null);
  const entryStep = font.descendantTrace.at(-1);
  assert.equal(entryStep.step, "descendant-fonts-entry");
  assert.equal(entryStep.accepted, false);
  assert.deepEqual(entryStep.references, ["13 0 R"], "the reference element must still be reported, alongside the dictionary one");
});

test("refuses an empty /DescendantFonts array", { skip }, async () => {
  const pdf = makeInlinePdf({ descendantFonts: "" });
  const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
  assert.equal(font.reason, "descendant-font-missing");
  assert.equal(font.metrics, null);
  assert.equal(font.descendantObjectNumber, null);
});

test("refuses an inline dictionary that is not a CID font", { skip }, async () => {
  const pdf = makeInlinePdf({ descendantFonts: inlineCidFontDictionary({ subtype: "/Type1" }) });
  const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
  assert.equal(font.reason, "unsupported-cid-font");
  assert.equal(font.metrics, null);
});

test("refuses an array element that is neither a reference nor a dictionary", { skip }, async () => {
  const pdf = makeInlinePdf({ descendantFonts: "/NotAFont" });
  const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
  assert.equal(font.reason, "descendant-font-unresolved");
  assert.equal(font.metrics, null);
});

test("the malformed inline-dictionary cases reach the public refusal and change nothing", { skip }, async () => {
  const cases = [
    { what: "two inline dictionaries", descendantFonts: `${inlineCidFontDictionary()} ${inlineCidFontDictionary()}` },
    { what: "an empty array", descendantFonts: "" },
    { what: "an inline dictionary that is not a CID font", descendantFonts: inlineCidFontDictionary({ subtype: "/Type1" }) }
  ];
  for (const { what, descendantFonts } of cases) {
    const pdf = makeInlinePdf({ descendantFonts });
    const editor = new PdfTextEditor(pdf);
    await editor.setFallbackFont(fontBytes);
    const [match] = await editor.searchText("令和");
    assert.ok(match, `${what}: the fixture must contain 令和`);
    const checked = await editor.checkTextMatchReplacement(match.id, "しょ");
    assert.equal(checked.allowed, false, what);
    assert.equal(checked.code, "FALLBACK_FONT_METRICS_UNAVAILABLE", what);
    await assert.rejects(() => editor.replaceTextMatch(match.id, "しょ"), /./, `${what}: replace must refuse too`);
    assert.deepEqual(await editor.save(), pdf, `${what}: the document's bytes must be untouched`);
  }
});
