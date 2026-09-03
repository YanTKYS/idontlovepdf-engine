// Reading a font's widths out of the objects a real PDF writer actually produces (v0.4.2).
//
// v0.4.1 could only measure a font whose `/Widths` (simple) or `/W` and `/DW` (CID) were
// written *inside* the font dictionary. A width array written as its own indirect object --
// `/W 9 0 R`, which is what a writer does with anything long -- was refused outright, and
// with it every `TJ` fallback replacement in such a document: FALLBACK_FONT_METRICS_UNAVAILABLE.
//
// The fixtures here reproduce that structure and nothing else about it changes: the numbers
// are still the PDF's own, still read as numbers, and a font whose widths cannot be
// established exactly is still refused -- with a reason that now says which structure
// defeated it. The unsafe half of this file is the important half.
//
// Positions are checked by test/helpers/text-advance.js, which imports nothing from src/
// and resolves these indirect objects itself.
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
 * The shape this version exists for: a Type0 / `/Identity-H` font over a CIDFontType2
 * whose `/W` and `/DW` are indirect objects of their own (9 and 10 below) rather than
 * values written in the descendant's dictionary.
 *
 * Every part of it is a knob, so the unsafe fixtures further down can break exactly one
 * thing at a time and nothing else.
 */
function makeCidPdf({
  content = TJ,
  encoding = "/Encoding /Identity-H",
  descendantFonts = "/DescendantFonts [7 0 R]",
  descendantSubtype = "/CIDFontType2",
  widths = "/W 9 0 R /DW 10 0 R",
  widthObject = `9 0 obj\n[${W_ARRAY}]\nendobj\n`,
  defaultWidthObject = "10 0 obj\n1000\nendobj\n",
  extraObjects = []
} = {}) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /F3 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode(`5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc ${encoding} ${descendantFonts} /ToUnicode 6 0 R >>\nendobj\n`),
    streamObject(6, CMAP),
    encode(`7 0 obj\n<< /Type /Font /Subtype ${descendantSubtype} /BaseFont /ABCDEF+Doc /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R ${widths} /CIDToGIDMap /Identity >>\nendobj\n`),
    encode("8 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Doc /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n"),
    encode(widthObject),
    encode(defaultWidthObject),
    ...extraObjects.map(encode)
  ]);
}

/** The other half: a simple font whose `/Widths` and `/FirstChar` are indirect objects. */
const SIMPLE_WIDTHS = new Map([[" ", 250], ["R", 700], ["e", 550], ["i", 300], ["w", 800], ["a", 550], ["8", 600], ["n", 560], ["d", 560], ["o", 560]]);
const SIMPLE_FIRST_CHAR = 32;
const SIMPLE_WIDTH_ARRAY = Array.from({ length: 95 }, (_, index) => SIMPLE_WIDTHS.get(String.fromCharCode(SIMPLE_FIRST_CHAR + index)) ?? 500);
const codes = (text) => `<${[...text].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}>`;
const SIMPLE_TJ = `BT /F3 12 Tf 24 60 Td [${codes("Reiwa")} -50 ${codes("8nendo")}] TJ ET`;

function makeSimplePdf({
  content = SIMPLE_TJ,
  subtype = "/TrueType",
  widths = "/Widths 7 0 R",
  firstChar = "/FirstChar 8 0 R",
  widthObject = `7 0 obj\n[${SIMPLE_WIDTH_ARRAY.join(" ")}]\nendobj\n`,
  firstCharObject = `8 0 obj\n${SIMPLE_FIRST_CHAR}\nendobj\n`,
  missingWidth = "/MissingWidth 0",
  extraObjects = [],
  extra = ""
} = {}) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /F3 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode(`5 0 obj\n<< /Type /Font /Subtype ${subtype} /BaseFont /ABCDEF+Simple ${firstChar} /LastChar 126 ${widths} ${extra}/FontDescriptor 6 0 R >>\nendobj\n`),
    encode(`6 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Simple /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 ${missingWidth} >>\nendobj\n`),
    encode(widthObject),
    encode(firstCharObject),
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

/* ------------------------------------------------------------------ the safe structures */

test("measures a CID font whose /W and /DW are indirect objects, and keeps what follows in place", { skip }, async () => {
  const pdf = makeCidPdf();
  // The premise: this is the structure v0.4.1 refused. It looked for `/W [` in the
  // descendant's own dictionary and gave up on a reference -- which is what this is.
  const text = latin1.decode(pdf);
  assert.match(text, /7 0 obj\n<< [^\n]*\/W 9 0 R \/DW 10 0 R/, "the widths must be indirect objects, not values in the descendant's dictionary");
  assert.equal(text.match(/\/W \[/g), null, "no direct /W array may be present");

  const { saved, reopened, before, after, stream } = await replaceAndMeasure(pdf, "令和", "しょ", "fallback-font");

  // 令和 was 1000 + 950 wide; しょ is 1000 + 1000, so the array is pulled back by 50 --
  // exactly the arithmetic the direct-/W fixture in fallback-font-tj.test.js does.
  assert.match(stream, /\/F3 36 Tf \[50 -50 <000300040005>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F3" && glyph.code >= 0x0003).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before), "every glyph after the match must be drawn where it was");

  // save -> reopen -> search.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ", "8年度"]);
  assert.equal((await reopened.searchText("しょ")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
  assert.equal((await reopened.searchText("8年度")).length, 1);
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g).length, 1);
  // The original file is still the head of the saved one: an incremental update, which an
  // independent reader opens by following /Prev. (Chromium does, in test/browser/.)
  assert.deepEqual(saved.subarray(0, pdf.length), pdf);
  assert.match(latin1.decode(saved), /\/Prev \d+/);
});

test("proves the fixture's own premises: 令和 is writable in this font, しょ is not", { skip }, async () => {
  const editor = new PdfTextEditor(makeCidPdf());
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  // 平 and 成 are in the subset, so the ordinary path writes them -- which is why
  // 令和 -> 平成 succeeded in the field where 令和 -> しょ did not.
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "平成"), { allowed: true, mode: "single-run" });

  const plain = new PdfTextEditor(makeCidPdf());
  const [plainMatch] = await plain.searchText("令和");
  const refused = await plain.checkTextMatchReplacement(plainMatch.id, "しょ");
  assert.equal(refused.code, "FONT_ENCODING_UNSUPPORTED");
  assert.deepEqual(refused.characters, ["し", "ょ"]);
});

test("measures a CID font whose /DescendantFonts array is itself an indirect object", { skip }, async () => {
  const pdf = makeCidPdf({
    descendantFonts: "/DescendantFonts 11 0 R",
    extraObjects: ["11 0 obj\n[7 0 R]\nendobj\n"]
  });
  const { stream, before, after } = await replaceAndMeasure(pdf, "令和", "しょ", "fallback-font");
  assert.match(stream, /\/F3 36 Tf \[50 -50 <000300040005>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F3" && glyph.code >= 0x0003).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before));
});

test("measures a CID font whose /Encoding name is itself an indirect object", { skip }, async () => {
  const pdf = makeCidPdf({ encoding: "/Encoding 11 0 R", extraObjects: ["11 0 obj\n/Identity-H\nendobj\n"] });
  const { stream, before, after } = await replaceAndMeasure(pdf, "令和", "しょ", "fallback-font");
  assert.match(stream, /\/F3 36 Tf \[50 -50 <000300040005>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F3" && glyph.code >= 0x0003).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before));
});

test("reads an indirect /DW written as a real number, not just an integer", { skip }, async () => {
  // A PDF number is plain decimal, and a real is as legal as an integer wherever a number
  // is expected. 和 is left out of /W here, so its width is /DW: 999.5, making the whole
  // match 1999.5 wide against しょ's 2000 -- an adjustment of 0.5, which has to be written
  // as such rather than the file being refused for stating a width with a decimal point.
  const pdf = makeCidPdf({
    widthObject: "9 0 obj\n[1 [1000] 3 [500] 4 [1000] 5 [1000]]\nendobj\n",
    defaultWidthObject: "10 0 obj\n999.5\nendobj\n"
  });
  const { stream, before, after } = await replaceAndMeasure(pdf, "令和", "しょ", "fallback-font");
  assert.match(stream, /\/F3 36 Tf \[0.5 -50 <000300040005>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F3" && glyph.code >= 0x0003).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before), "every glyph after the match must be drawn where it was");
});

test("diagnoses the descendant font by the same path the measurement takes", { skip }, async () => {
  // The diagnosis is the next thing a real document is judged by, so it must not stop a
  // hop short of the CIDFont that states the widths: /DescendantFonts written as an object
  // of its own has to be followed, exactly as describeFontWidths() follows it.
  const pdf = makeCidPdf({
    descendantFonts: "/DescendantFonts 11 0 R",
    extraObjects: ["11 0 obj\n[7 0 R]\nendobj\n"]
  });
  const editor = new PdfTextEditor(pdf);
  const [font] = await diagnoseFontMetrics(editor);

  assert.equal(font.name, "F3");
  assert.equal(font.codeBytes, 2, "the widths are readable, so the diagnosis must say so");
  assert.match(font.descendant ?? "", /\/Subtype \/CIDFontType2/, "the real descendant font must be reported");
  assert.match(font.descendant ?? "", /\/W 9 0 R/);
  const width = font.related.find((item) => item.key === "descendant /W");
  assert.ok(width, "the /W object the widths actually come from must be listed");
  assert.equal(width.reference, "9 0 R");
  assert.match(width.detail, /\[1 \[1000\] 2 \[950\]/);
});

/**
 * A second CIDFont, deliberately not identical to object 7: a `/DescendantFonts` naming
 * both must not quietly measure with whichever one happens to come first.
 */
const SECOND_CID_FONT = "12 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GHIJKL+Other "
  + "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R "
  + "/W 9 0 R /DW 10 0 R /CIDToGIDMap /Identity >>\nendobj\n";

/* --------------------------------------------------- the walk's own account of itself */

// "descendant-font-unresolved" names a walk, not a hop: /DescendantFonts may be a direct
// array or an object of its own, and either may fail at the reference, at the array's
// contents, or at the CIDFont behind it. Told only the reason, a real document cannot be
// told apart from any other -- which is what made 22550.pdf's /F3 undiagnosable from the
// refusal alone. resolveDescendantFont() therefore records each hop it takes, and these
// pin down that the record is the *measuring* walk's own: same function, same branches,
// so a trace can never describe a path the widths did not take.

test("records each hop of the descendant walk, direct and indirect alike", { skip }, async () => {
  const direct = new PdfTextEditor(makeCidPdf());
  const [plain] = await diagnoseFontMetrics(direct);
  assert.deepEqual(plain.descendantTrace.map((step) => step.step), ["descendant-fonts-entry", "resolve-first-reference"]);
  assert.equal(plain.descendantTrace[0].form, "direct-array", "a direct array must not be reported as a reference");
  assert.deepEqual(plain.descendantTrace[0].references, ["7 0 R"]);
  assert.equal(plain.descendantObjectNumber, 7, "the CIDFont's own object number must be reported");

  const indirect = new PdfTextEditor(makeCidPdf({
    descendantFonts: "/DescendantFonts 11 0 R",
    extraObjects: ["11 0 obj\n[7 0 R]\nendobj\n"]
  }));
  const [followed] = await diagnoseFontMetrics(indirect);
  assert.deepEqual(
    followed.descendantTrace.map((step) => step.step),
    ["descendant-fonts-entry", "resolve-first-reference", "nested-array-element", "resolve-nested-reference"]
  );
  assert.equal(followed.descendantTrace[0].form, "indirect-reference");
  assert.equal(followed.descendantTrace[1].kind, "array", "the object between must be reported as the array it is");
  assert.equal(followed.descendantTrace[2].matched, true);
  assert.equal(followed.descendantTrace[3].kind, "dictionary");
  assert.equal(followed.descendantObjectNumber, 7, "the CIDFont behind the array, not the array itself");
  // Both walks reach the same widths, so the trace describes a path that really measures.
  assert.equal(plain.codeBytes, 2);
  assert.equal(followed.codeBytes, 2);
});

test("names the hop that failed, not just that one did", { skip }, async () => {
  const cases = [
    {
      what: "a reference to an object the file does not contain",
      pdf: makeCidPdf({ descendantFonts: "/DescendantFonts [99 0 R]" }),
      lastStep: "resolve-first-reference",
      check: (step) => {
        assert.equal(step.kind, "unresolved");
        assert.match(step.error, /missing from the xref table/);
        assert.equal(step.location.storage, "missing-from-xref");
      }
    },
    {
      what: "an indirect /DescendantFonts that is not an array at all",
      pdf: makeCidPdf({ descendantFonts: "/DescendantFonts 11 0 R", extraObjects: ["11 0 obj\n42\nendobj\n"] }),
      lastStep: "nested-array-element",
      check: (step) => assert.equal(step.matched, false)
    },
    {
      what: "an indirect array holding more than the one font the spec allows",
      pdf: makeCidPdf({ descendantFonts: "/DescendantFonts 11 0 R", extraObjects: ["11 0 obj\n[7 0 R 12 0 R]\nendobj\n", SECOND_CID_FONT] }),
      lastStep: "nested-array-element",
      check: (step) => {
        assert.equal(step.matched, false);
        assert.equal(step.inner.trim(), "7 0 R 12 0 R", "the contents that defeated it must be readable");
      }
    },
    {
      what: "a direct array holding more than the one font the spec allows",
      pdf: makeCidPdf({ descendantFonts: "/DescendantFonts [7 0 R 12 0 R]", extraObjects: [SECOND_CID_FONT] }),
      lastStep: "descendant-fonts-entry",
      check: (step) => {
        assert.equal(step.accepted, false, "the entry itself must stop the walk");
        assert.deepEqual(step.references, ["7 0 R", "12 0 R"], "both fonts the array named must be reported");
      }
    }
  ];

  for (const { what, pdf, lastStep, check } of cases) {
    const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
    assert.equal(font.reason, "descendant-font-unresolved", what);
    assert.equal(font.metrics, null, `${what}: the refusal itself must not soften`);
    assert.equal(font.descendantObjectNumber, null, `${what}: no CIDFont was reached, so none may be named`);
    assert.equal(font.descendantTrace.at(-1).step, lastStep, what);
    check(font.descendantTrace.at(-1));
  }
});

test("reports where the cross-reference table puts each object of the walk", { skip }, async () => {
  // Which objects are compressed is the first thing to establish about a real document,
  // and it is not visible from the reason at all.
  const [font] = await diagnoseFontMetrics(new PdfTextEditor(makeCidPdf({
    descendantFonts: "/DescendantFonts 11 0 R",
    extraObjects: ["11 0 obj\n[7 0 R]\nendobj\n"]
  })));
  assert.equal(font.location.storage, "regular");
  assert.equal(font.location.generation, 0);
  assert.equal(font.objectGeneration, 0, "the generation the /Resources reference stated");
  for (const step of font.descendantTrace.filter((step) => step.reference)) {
    assert.equal(step.location.storage, "regular", `${step.reference} is a normal indirect object in this fixture`);
    assert.equal(typeof step.location.offset, "number");
  }
});

test("refuses two descendant fonts whichever way the array is written", { skip }, async () => {
  // PDF 9.7.6.2 makes /DescendantFonts a one-element array, and nothing in a file with two
  // says which to measure with -- so both shapes must refuse. The asymmetry this pins down
  // is the one that mattered: written directly, the array used to resolve to whichever font
  // came first and MEASURE with it, while the identical array written as an object of its
  // own was refused. Which shape the writer chose must not decide that.
  const direct = makeCidPdf({ descendantFonts: "/DescendantFonts [7 0 R 12 0 R]", extraObjects: [SECOND_CID_FONT] });
  const indirect = makeCidPdf({
    descendantFonts: "/DescendantFonts 11 0 R",
    extraObjects: ["11 0 obj\n[7 0 R 12 0 R]\nendobj\n", SECOND_CID_FONT]
  });

  for (const [what, pdf] of [["direct", direct], ["indirect", indirect]]) {
    const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
    assert.equal(font.reason, "descendant-font-unresolved", `${what}: two descendant fonts must be refused`);
    assert.equal(font.metrics, null, `${what}: no widths may be established from either of them`);
    assert.equal(font.descendantObjectNumber, null, `${what}: neither font may be named as the descendant`);
  }

  // And the refusal has to reach the caller, not just the diagnosis: a TJ replacement
  // needing the fallback font is refused with the public code, and replaceTextMatch()
  // refuses on the same ground rather than writing anything.
  for (const [what, pdf] of [["direct", direct], ["indirect", indirect]]) {
    const editor = new PdfTextEditor(pdf);
    await editor.setFallbackFont(fontBytes);
    const [match] = await editor.searchText("令和");
    assert.ok(match, `${what}: the fixture must contain 令和`);
    const checked = await editor.checkTextMatchReplacement(match.id, "しょ");
    assert.equal(checked.allowed, false, what);
    assert.equal(checked.code, "FALLBACK_FONT_METRICS_UNAVAILABLE", what);
    assert.equal(checked.unsafeReason, "descendant-font-unresolved", what);
    await assert.rejects(() => editor.replaceTextMatch(match.id, "しょ"), /./, `${what}: replace must refuse too`);
    assert.deepEqual(await editor.save(), pdf, `${what}: the document's bytes must be untouched`);
  }

  // The one-element array both shapes are meant to accept still measures, so this is a
  // refusal of the malformed case and not of the structure itself.
  for (const pdf of [makeCidPdf(), makeCidPdf({ descendantFonts: "/DescendantFonts 11 0 R", extraObjects: ["11 0 obj\n[7 0 R]\nendobj\n"] })]) {
    const [font] = await diagnoseFontMetrics(new PdfTextEditor(pdf));
    assert.equal(font.codeBytes, 2);
    assert.equal(font.descendantObjectNumber, 7);
  }
});

test("tracing changes nothing about which structures resolve", { skip }, async () => {
  // The trace is an output, never an input: passing one must not make a font measurable
  // that is not, nor the other way round.
  const { resolveDescendantFont } = await import("../src/font-metrics.js");
  for (const descendantFonts of ["/DescendantFonts [7 0 R]", "/DescendantFonts 11 0 R", "/DescendantFonts [99 0 R]", ""]) {
    const editor = new PdfTextEditor(makeCidPdf({ descendantFonts, extraObjects: ["11 0 obj\n[7 0 R]\nendobj\n"] }));
    await editor.listTextRuns();
    const resolve = (target) => editor.document.resolveObject(target, editor.security, undefined);
    const fontObject = await resolve({ number: 5, generation: 0 });
    const untraced = await resolveDescendantFont(fontObject.dictionary, resolve);
    const traced = await resolveDescendantFont(fontObject.dictionary, resolve, []);
    assert.deepEqual(traced, untraced, `${descendantFonts || "(no /DescendantFonts)"} must resolve identically either way`);
  }
});

test("measures a simple font whose /Widths and /FirstChar are indirect objects", { skip }, async () => {
  const pdf = makeSimplePdf();
  assert.match(latin1.decode(pdf), /\/Widths 7 0 R/);
  const { stream, before, after, reopened } = await replaceAndMeasure(pdf, "Reiwa", "しょ", "fallback-font");

  // Reiwa is 700 + 550 + 300 + 800 + 550 = 2900 glyph-space units; しょ is 2000, so the
  // array is pushed forward by 900 for 8nendo to stay where it was.
  assert.match(stream, /\/F3 12 Tf \[-900 -50 <386e656e646f>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F3").map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before).slice(5), "8nendo must be drawn exactly where it was");
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ", "8nendo"]);
});

test("takes an indirect /MissingWidth from the font descriptor rather than assuming zero", { skip }, async () => {
  // A code outside /Widths gets /MissingWidth, which the file may state indirectly too.
  // The array here stops at code 51, so every letter of Reiwa takes that width: 5 x 480.
  const pdf = makeSimplePdf({
    widthObject: `7 0 obj\n[${SIMPLE_WIDTH_ARRAY.slice(0, 20).join(" ")}]\nendobj\n`,
    missingWidth: "/MissingWidth 9 0 R",
    extraObjects: ["9 0 obj\n480\nendobj\n"]
  });
  // 2400 removed, 2000 written: 8nendo needs the array pushed back by 400. Reading
  // /MissingWidth as 0 (or ignoring it) would write a different number.
  const { stream } = await replaceAndMeasure(pdf, "Reiwa", "しょ", "fallback-font");
  assert.match(stream, /\/F3 12 Tf \[-400 -50 <386e656e646f>\] TJ/);
});

/* --------------------------------------------------------------------- and the unsafe ones */

test("refuses every structure whose widths it cannot establish exactly, and changes nothing", { skip }, async () => {
  const cases = [
    // --- the indirect objects this version resolves, when they cannot be resolved ---
    {
      what: "a /W pointing at an object that is not in the file",
      pdf: makeCidPdf({ widths: "/W 99 0 R /DW 10 0 R" }),
      unsafeReason: "w-unresolved"
    },
    {
      what: "a /W pointing at a dictionary instead of an array",
      pdf: makeCidPdf({ widthObject: "9 0 obj\n<< /Type /Whatever >>\nendobj\n" }),
      unsafeReason: "invalid-width-array"
    },
    {
      what: "a /W array holding a reference where a width should be",
      pdf: makeCidPdf({ widthObject: "9 0 obj\n[1 [1000] 2 [10 0 R]]\nendobj\n" }),
      unsafeReason: "invalid-width-array"
    },
    {
      what: "a /W array holding a name where a width should be",
      pdf: makeCidPdf({ widthObject: "9 0 obj\n[1 [1000] 2 [/Wide]]\nendobj\n" }),
      unsafeReason: "invalid-width-array"
    },
    {
      what: "a /DW that is not a number",
      pdf: makeCidPdf({ widths: "/W 9 0 R /DW /Wide" }),
      unsafeReason: "invalid-default-width"
    },
    {
      what: "a /DW pointing at an object that is not a number",
      pdf: makeCidPdf({ defaultWidthObject: "10 0 obj\n(1000)\nendobj\n" }),
      unsafeReason: "invalid-default-width"
    },
    {
      what: "a /DW pointing at an object that is not a well-formed number",
      pdf: makeCidPdf({ defaultWidthObject: "10 0 obj\n1.2.3\nendobj\n" }),
      unsafeReason: "invalid-default-width"
    },
    {
      what: "a /DW pointing at an object written in exponent notation, which PDF has no such thing as",
      pdf: makeCidPdf({ defaultWidthObject: "10 0 obj\n1e3\nendobj\n" }),
      unsafeReason: "invalid-default-width"
    },
    {
      what: "a /Widths pointing at an object that is not in the file",
      pdf: makeSimplePdf({ widths: "/Widths 99 0 R" }),
      unsafeReason: "widths-unresolved"
    },
    {
      what: "a /Widths array holding a name where a width should be",
      pdf: makeSimplePdf({ widthObject: "7 0 obj\n[/Wide 500]\nendobj\n" }),
      unsafeReason: "invalid-width-array"
    },
    {
      what: "a /FirstChar pointing at an object that is not a number",
      pdf: makeSimplePdf({ firstCharObject: "8 0 obj\n<< /Type /Whatever >>\nendobj\n" }),
      unsafeReason: "invalid-first-char"
    },
    // --- structures this version deliberately does not read, resolvable or not ---
    {
      what: "an /Encoding that is a predefined CMap, where the code is not the CID",
      pdf: makeCidPdf({ encoding: "/Encoding /90ms-RKSJ-H" }),
      unsafeReason: "non-identity-encoding"
    },
    {
      what: "an /Encoding that is an embedded CMap stream",
      pdf: makeCidPdf({
        encoding: "/Encoding 11 0 R",
        extraObjects: ["11 0 obj\n<< /Type /CMap /WMode 0 /Length 5 >>\nstream\nhello\nendstream\nendobj\n"]
      }),
      unsafeReason: "embedded-cmap-encoding"
    },
    {
      what: "a descendant font that is not in the file",
      pdf: makeCidPdf({ descendantFonts: "/DescendantFonts [99 0 R]" }),
      unsafeReason: "descendant-font-unresolved"
    },
    {
      what: "no descendant font at all",
      pdf: makeCidPdf({ descendantFonts: "" }),
      unsafeReason: "descendant-font-missing"
    },
    {
      what: "a descendant that is not a CID font",
      pdf: makeCidPdf({ descendantSubtype: "/Type1" }),
      unsafeReason: "unsupported-cid-font"
    },
    {
      what: "a simple font with no /Widths at all",
      pdf: makeSimplePdf({ widths: "", widthObject: "7 0 obj\n[]\nendobj\n" }),
      unsafeReason: "missing-widths"
    },
    {
      what: "a simple font with no /FirstChar",
      pdf: makeSimplePdf({ firstChar: "" }),
      unsafeReason: "missing-first-char"
    },
    {
      what: "a Type 3 font, whose widths are in its own glyph space",
      pdf: makeSimplePdf({ subtype: "/Type3", extra: "/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << >> " }),
      unsafeReason: "unsupported-type3"
    },
    {
      what: "a font subtype whose widths this does not read",
      pdf: makeSimplePdf({ subtype: "/Type1C" }),
      unsafeReason: "unsupported-font-subtype"
    }
  ];

  for (const { what, pdf, unsafeReason } of cases) {
    const query = /\/Subtype \/Type0/.test(latin1.decode(pdf).slice(0, 2000)) ? "令和" : "Reiwa";
    const editor = new PdfTextEditor(pdf);
    await editor.setFallbackFont(fontBytes);
    const [match] = await editor.searchText(query);
    assert.ok(match, `the fixture must contain ${query}: ${what}`);

    const verdict = await editor.checkTextMatchReplacement(match.id, "しょ");
    assert.equal(verdict.allowed, false, `should have been refused: ${what}`);
    assert.equal(verdict.code, "FALLBACK_FONT_METRICS_UNAVAILABLE", `for: ${what}`);
    assert.equal(verdict.unsafeReason, unsafeReason, `for: ${what}`);

    // replaceTextMatch() must reach the identical verdict, and change nothing.
    await assert.rejects(editor.replaceTextMatch(match.id, "しょ"), (error) => {
      assert.equal(error.code, "FALLBACK_FONT_METRICS_UNAVAILABLE", `for: ${what}`);
      return true;
    });
    assert.equal(editor.pending.size, 0);
    assert.equal(editor.pendingObjects.size, 0);
    assert.equal(editor.pendingStreams.size, 0);
    assert.deepEqual(await editor.save(), pdf, `the document must be untouched: ${what}`);
  }
});

test("still refuses a vertical font whose /Encoding name is an indirect object", { skip }, async () => {
  const pdf = makeCidPdf({ encoding: "/Encoding 11 0 R", extraObjects: ["11 0 obj\n/Identity-V\nendobj\n"] });
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "しょ");
  assert.equal(verdict.code, "FALLBACK_WRITING_MODE_UNSUPPORTED");
  await assert.rejects(editor.replaceTextMatch(match.id, "しょ"), (error) => error.code === "FALLBACK_WRITING_MODE_UNSUPPORTED");
  assert.deepEqual(await editor.save(), pdf);
});

test("refuses a width no TJ adjustment can express exactly", { skip }, async () => {
  // The invariant is `replacement width - adjustment === original width`, checked rather
  // than trusted. A width with more decimals than a PDF number written here can carry back
  // exactly makes it unprovable -- so the replacement is refused, not rounded into place.
  const pdf = makeCidPdf({ widthObject: "9 0 obj\n[1 [1000] 2 [950.1234567] 3 [500] 4 [1000] 5 [1000]]\nendobj\n" });
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "しょ");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "FALLBACK_FONT_METRICS_UNAVAILABLE");
  assert.equal(verdict.unsafeReason, "adjustment-not-representable");
  await assert.rejects(editor.replaceTextMatch(match.id, "しょ"), (error) => error.code === "FALLBACK_FONT_METRICS_UNAVAILABLE");
  assert.deepEqual(await editor.save(), pdf);
});
