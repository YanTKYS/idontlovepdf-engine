// Replacing text a `TJ` array draws, through the fallback font, without moving anything
// drawn after it (v0.4.1).
//
// v0.4.0 embedded a fallback font only for text drawn by a plain `Tj`, and only where
// nothing at all was drawn from the end of the match -- so `令和 -> しょ` inside
// `[(令和) -50 (8年度)] TJ`, the shape ordinary Japanese PDFs are full of, was refused
// outright. The rewrite here keeps the `TJ` structure and writes one adjustment computed
// from the two fonts' own widths, so `8年度` starts at exactly the x it started at before.
//
// The check is not "it looks right": the tests below re-implement PDF's text-advance
// formula independently of the engine (see simulate()), read both fonts' widths straight
// out of the saved file, and compare the drawing position of every glyph after the match
// with where it was in the original. Nothing in src/ is involved in deciding that answer.
//
// The font is a test fixture fetched by `npm run test:font`; without it these skip.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import { TEST_FONT, readTestFont } from "../scripts/fetch-test-font.js";
import { fontTable, simulate } from "./helpers/text-advance.js";
import { CMAP, FONT, W_ARRAY, buildPdf, encode, glyphs, streamObject } from "./helpers/document-font.js";

const fontBytes = readTestFont();
const skip = fontBytes ? false : `${TEST_FONT.name} is not present -- run \`npm run test:font\` to fetch it`;

const latin1 = new TextDecoder("latin1");

/**
 * A one-page document whose font states its widths the way a real CID font does: a Type0
 * with an `/Identity-H` encoding over a CIDFontType2 descendant carrying `/W` and `/DW`.
 * Those are the numbers a PDF reader positions the text with, and the ones the engine has
 * to measure the replaced text against.
 */
function makePdf(content, { descendantFonts = true } = {}) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    // Without /DescendantFonts there is nowhere for a CID font's widths to be stated, so
    // nothing says how wide this font's characters are -- the shape the unsafe fixtures use.
    encode(`5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H ${descendantFonts ? "/DescendantFonts [7 0 R] " : ""}/ToUnicode 6 0 R >>\nendobj\n`),
    streamObject(6, CMAP),
    encode(`7 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Doc /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /W [${W_ARRAY}] /CIDToGIDMap /Identity >>\nendobj\n`),
    encode("8 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Doc /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n")
  ]);
}

const body = (operators) => `BT /FJP 36 Tf 24 60 Td ${operators} ET`;

async function editorFor(content, options) {
  const editor = new PdfTextEditor(makePdf(content, options));
  await editor.setFallbackFont(fontBytes);
  return editor;
}

/* --------------------------------------------------------------------------------------
 * An independent reader: test/helpers/text-advance.js imports nothing from src/, so what
 * it says about where a glyph lands is a second opinion, not a restatement of the engine's
 * own. v0.4.2 shares it with test/font-metrics-indirect.test.js.
 * ----------------------------------------------------------------------------------- */


/** The x of the first glyph drawn from `codes`, in the document's own font. */
function positionOf(drawn, code) {
  const found = drawn.find((glyph) => glyph.code === code && glyph.font === "FJP");
  assert.ok(found, `no glyph ${code} was drawn in the document's own font`);
  return found.x;
}

const streamTextOf = async (pdf) => {
  const editor = new PdfTextEditor(pdf);
  await editor.listTextRuns();
  return latin1.decode(editor.streams[0].decoded);
};

/**
 * Replaces `query` with `replacement`, then answers the only question that matters: is the
 * text after the match drawn at exactly the same x as before? Measured by simulate() over
 * the before and after content streams, with each file's own font widths.
 */
async function replaceAndMeasure(content, query, replacement, expectedMode, options) {
  const original = makePdf(content, options);
  const editor = await editorFor(content, options);
  const [match] = await editor.searchText(query);
  assert.ok(match, `the fixture must contain ${query}`);
  const verdict = await editor.checkTextMatchReplacement(match.id, replacement);
  if (expectedMode) assert.deepEqual(verdict, { allowed: true, mode: expectedMode });
  else assert.equal(verdict.allowed, true, `should have been allowed: ${content}`);
  await editor.replaceTextMatch(match.id, replacement);
  const saved = await editor.save();
  const reopened = new PdfTextEditor(saved);
  return {
    original,
    saved,
    reopened,
    runs: (await reopened.listTextRuns()).map((run) => run.text),
    before: simulate(content, fontTable(original)),
    after: simulate(await streamTextOf(saved), fontTable(saved)),
    stream: await streamTextOf(saved)
  };
}

/* ---------------------------------------------------------------- the headline fixture */

test("replaces text drawn by TJ and leaves what follows exactly where it was", { skip }, async () => {
  // 令和8年度, drawn as a TJ array with a real kern between the era and the year -- the
  // shape v0.4.0 refused outright. 令和 -> しょ needs the fallback font; 8年度 must not move.
  const content = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);
  const { saved, reopened, runs, before, after, stream } = await replaceAndMeasure(content, "令和", "しょ", "fallback-font");

  assert.deepEqual(runs, ["しょ", "8年度"], "the replacement is drawn, and 8年度 is still there");
  assert.equal(positionOf(before, 0x0003), positionOf(after, 0x0003), "8年度 must start at the same x");
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "FJP" && glyph.code >= 0x0003).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before), "every glyph after the match must be drawn where it was");

  // save -> reopen -> search: the replacement is findable as Unicode and 令和 is gone.
  assert.equal((await reopened.searchText("しょ")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
  assert.equal((await reopened.searchText("8年度")).length, 1);

  // One font program, once.
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g).length, 1);
  // The kern the PDF asked for is still written exactly once, and still where it was.
  assert.equal(stream.match(/-50/g).length, 1);
  // 令和 and しょ are both exactly 1000 + 1000 wide, so no correction is needed -- a zero
  // adjustment is not written at all, and only the document's own -50 kern survives.
  assert.match(stream, /\/FJP 36 Tf \[-50 <000300040005>\] TJ/);
});

test("proves the fixture's own premises: 令和 is writable in the document's font, しょ is not", { skip }, async () => {
  const content = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);
  const editor = await editorFor(content);
  const [match] = await editor.searchText("令和");

  // 平 and 成 are in the subset, so the ordinary path writes them -- no font is embedded.
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "平成"), { allowed: true, mode: "single-run" });
  // し and ょ are not, which is what makes the same edit a fallback edit.
  const plain = new PdfTextEditor(makePdf(content));
  const [plainMatch] = await plain.searchText("令和");
  const refused = await plain.checkTextMatchReplacement(plainMatch.id, "しょ");
  assert.equal(refused.code, "FONT_ENCODING_UNSUPPORTED");
  assert.deepEqual(refused.characters, ["し", "ょ"]);

  // And the existing-font path leaves the TJ array untouched, adjustment and all.
  await editor.replaceTextMatch(match.id, "平成");
  const saved = await editor.save();
  assert.match(await streamTextOf(saved), /\[<00060007> -50 <000300040005>\] TJ/);
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g), null, "nothing is embedded for text the document can write");
});

test("opens in an independent reader, as a well-formed incremental update", { skip }, async () => {
  const content = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);
  const { original, saved } = await replaceAndMeasure(content, "令和", "しょ", "fallback-font");
  const text = latin1.decode(saved);
  // The original file is still the head of the saved one, with the update appended.
  assert.deepEqual(saved.subarray(0, original.length), original);
  assert.match(text, /\/Prev \d+/);
  assert.match(text, /\/Subtype \/Type0 .*\/Encoding \/Identity-H/);
  assert.match(text, /\/Subtype \/CIDFontType2/);
  assert.match(text, /\/CIDToGIDMap \/Identity/);
  assert.match(text, new RegExp(`/Length1 ${fontBytes.length}\\b`));
  // Chromium's own PDF viewer opens the result: see test/browser/fallback-font.test.js.
});

/* ------------------------------------------------- every TJ shape, and every adjustment */

test("keeps every TJ adjustment exactly as the PDF wrote it", { skip }, async () => {
  // For each shape: the operators, the adjustments that must survive byte for byte, and
  // the ones that must NOT survive -- those written *between* the match's own operands,
  // which are removed with the text they separated and folded into the one adjustment the
  // rewrite writes instead. Either way nothing after the match may move, which is checked
  // for every case at the end of the loop.
  //
  // Replaces with "ab" (2 x 500 = 1000 units) rather than しょ (2000): this loop is about
  // which adjustment survives, not the overflow-safety check of v0.4.4 (see
  // test/fallback-font-overflow.test.js for that), and several shapes here spend part of
  // 令和's own 2000 units on an interior kern before the replacement is even measured
  // against what remains -- narrow enough to fit regardless. Two characters, the same
  // count as 令和 itself: a *different* count, with the non-zero interior adjustment some
  // of these cases have, is refused before the fallback font is ever reached (see
  // MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED / variableLengthObstacle() in
  // src/pdf-document.js) -- a pre-existing, unrelated rule this loop is not testing.
  const cases = [
    // The match spans two operands with a kern between them.
    { operators: `[${glyphs("令")} 120 ${glyphs("和")}] TJ ${glyphs("平成")} Tj`, kept: [], consumed: ["120"] },
    // The same drawing written across the operator boundary: identical treatment.
    { operators: `[${glyphs("令")} 120] TJ [${glyphs("和")}] TJ ${glyphs("平成")} Tj`, kept: [], consumed: ["120"] },
    // A leading adjustment, before the match: kept, in front, exactly once.
    { operators: `[120 ${glyphs("令和")}] TJ ${glyphs("平成")} Tj`, kept: ["120"], consumed: [] },
    // A trailing adjustment, after the match.
    { operators: `[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`, kept: ["-50"], consumed: [] },
    // Adjustments on both sides, and one in the middle.
    { operators: `[-25 ${glyphs("令")} 30 ${glyphs("和")} -50 ${glyphs("8年度")}] TJ`, kept: ["-25", "-50"], consumed: ["30"] },
    // Zero written every way a PDF number may be written. The two outside the match are
    // kept exactly as spelled -- not normalised to `0`, not merged, not moved.
    { operators: `[${glyphs("申請")} 0 ${glyphs("令")} +0 ${glyphs("和")} -0 ${glyphs("8年度")}] TJ`, kept: ["0", "-0"], consumed: ["+0"] },
    { operators: `[${glyphs("申請")} 0.0 ${glyphs("令和")} -0.0 ${glyphs("8年度")}] TJ`, kept: ["0.0", "-0.0"], consumed: [] },
    // Two adjustments inside the match that cancel: net zero, and both gone with the text.
    { operators: `[${glyphs("令")} 120] TJ [-120 ${glyphs("和")} -50 ${glyphs("8年度")}] TJ`, kept: ["-50"], consumed: ["120", "-120"] },
    // The match at the very start, in the middle, and at the very end of the array.
    { operators: `[${glyphs("令和")} -50 ${glyphs("8年度")} 0 ${glyphs("平成")}] TJ`, kept: ["-50", "0"], consumed: [] },
    { operators: `[${glyphs("申請")} -10 ${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`, kept: ["-10", "-50"], consumed: [] },
    { operators: `[${glyphs("申請")} -10 ${glyphs("令和")}] TJ ${glyphs("平成")} Tj`, kept: ["-10"], consumed: [] }
  ];
  for (const { operators, kept, consumed } of cases) {
    const { before, after, stream } = await replaceAndMeasure(body(operators), "令和", "ab", null);
    // Everything after the `Td`, so the fixture's own text-position operands are never
    // mistaken for adjustments.
    const written = stream.slice(stream.indexOf(" Td ") + 4);
    const countOf = (adjustment) => (written.match(new RegExp(`(?<![\\d.+-])${adjustment.replace("+", "\\+")}(?![\\d.])`, "g")) ?? []).length;

    for (const adjustment of new Set(kept)) {
      assert.equal(countOf(adjustment), kept.filter((item) => item === adjustment).length, `${adjustment} must survive exactly as often as it was written, in: ${operators} -> ${written}`);
    }
    for (const adjustment of new Set(consumed)) {
      assert.equal(countOf(adjustment), 0, `${adjustment} sat inside the match and must not be written back, in: ${operators} -> ${written}`);
    }
    // And, whatever the shape, nothing drawn after the match moved.
    const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "FJP" && glyph.code >= 0x0003 && glyph.code <= 0x0007).map((glyph) => glyph.x);
    assert.deepEqual(trailing(after), trailing(before), `text after the match moved, in: ${operators}`);
  }
});

test("keeps the text after the match in place under Tc, Tw, Tz and any font size", { skip }, async () => {
  // Font size and horizontal scaling multiply the glyph advance and the TJ adjustment
  // alike, so they cancel out of the arithmetic -- which is asserted here rather than
  // assumed. Tc is allowed only where the glyph count is unchanged (it is: 2 for 2).
  const prefixes = [
    "",                       // nothing in force
    "3 Tc ",                  // character spacing
    "20 Tw ",                 // word spacing, which 2-byte codes never see
    "50 Tz ",                 // horizontal scaling other than 100%
    "150 Tz 2 Tc 20 Tw "      // all three at once
  ];
  const sizes = [8, 36, 10.5];
  for (const prefix of prefixes) {
    for (const size of sizes) {
      const content = `BT /FJP ${size} Tf 24 60 Td ${prefix}[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ ET`;
      const { before, after } = await replaceAndMeasure(content, "令和", "しょ", "fallback-font");
      assert.equal(
        positionOf(after, 0x0003),
        positionOf(before, 0x0003),
        `8年度 moved with "${prefix}" at size ${size}`
      );
    }
  }
});

test("draws the rest of the match's own operand back in the document's own font", { skip }, async () => {
  // The prefix and suffix around a partial match stay in the document's font, and the
  // suffix stays where it was -- it is text drawn after the match like any other. Same
  // length as 令和 (2000 units, equal to the slot exactly) so this is about the
  // prefix/suffix mechanics, not the overflow-safety check -- see the "しょうわ" case in
  // "refuses a TJ replacement that would overrun the text after it" below for that.
  const { runs, stream, before, after } = await replaceAndMeasure(body(`[${glyphs("申請令和です")}] TJ`), "令和", "しょ", "fallback-font-partial");
  assert.deepEqual(runs, ["申請", "しょ", "です"]);
  // The document's own font is re-stated after the fallback, and the suffix drawn in it.
  // No adjustment number is written: 令和 and しょ are exactly the same width.
  assert.match(stream, /\/ILPFallback [\d.]+ Tf \[<[0-9a-f]+>\] TJ \/FJP [\d.]+ Tf \[<000a000b>\] TJ/);
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "FJP" && glyph.code >= 0x000a).map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before), "です must not move");
});

test("keeps text drawn after the whole TJ operator in place too, as long as it fits", { skip }, async () => {
  // v0.4.0 refused this outright (FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE) because a Tj
  // rewrite has no way to put the following text back. A TJ rewrite does -- but only up
  // to the width 令和 actually had (2000 units): しょ (2000) fits exactly, たいしょう (5000)
  // does not, and would be drawn over the 8年度 that follows in the next operator (v0.4.4).
  for (const operators of [
    `[${glyphs("令和")}] TJ ${glyphs("8年度")} Tj`,
    `[${glyphs("令和")}] TJ [${glyphs("8年度")}] TJ`
  ]) {
    const { before, after } = await replaceAndMeasure(body(operators), "令和", "しょ", "fallback-font");
    assert.equal(positionOf(after, 0x0003), positionOf(before, 0x0003), `8年度 moved, in: ${operators}`);
  }
});

test("refuses a TJ replacement that would overrun the text after it, even across operators", { skip }, async () => {
  // The real-world case this version exists for: 令和 -> しょうわ. Widening the match from
  // 2000 to 4000 glyph-space units cannot be fixed by any adjustment, because the
  // adjustment only moves where 8年度 STARTS -- it cannot undraw しょうわ's own glyphs from
  // the space that move reclaims. Refused before anything is written, whether the
  // following text sits in the same TJ array, a later Tj, or a later TJ.
  for (const operators of [
    `[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`,
    `[${glyphs("令和")}] TJ ${glyphs("8年度")} Tj`,
    `[${glyphs("令和")}] TJ [${glyphs("8年度")}] TJ`
  ]) {
    const content = body(operators);
    const original = makePdf(content);
    const editor = await editorFor(content);
    const [match] = await editor.searchText("令和");
    const verdict = await editor.checkTextMatchReplacement(match.id, "しょうわ");
    assert.equal(verdict.allowed, false, `should have been refused, in: ${operators}`);
    assert.equal(verdict.code, "FALLBACK_LAYOUT_UNSUPPORTED", `for: ${operators}`);
    assert.equal(verdict.unsafeReason, "fallback-replacement-overflows-slot", `for: ${operators}`);
    assert.deepEqual(verdict.diagnostics, { replacementAdvance: 4000, availableAdvance: 2000 }, `for: ${operators}`);

    await assert.rejects(editor.replaceTextMatch(match.id, "しょうわ"), (error) => {
      assert.equal(error.code, "FALLBACK_LAYOUT_UNSUPPORTED");
      assert.equal(error.unsafeReason, "fallback-replacement-overflows-slot");
      return true;
    });
    assert.equal(editor.pending.size, 0);
    assert.equal(editor.pendingObjects.size, 0);
    assert.equal(editor.pendingStreams.size, 0);
    assert.deepEqual(await editor.save(), original, `the document must be untouched, in: ${operators}`);
  }
});

test("needs no adjustment where nothing at all is drawn from the match's end", { skip }, async () => {
  // The v0.4.0 situation, reached through a TJ: the match ends the array and an ET follows,
  // so the replacement simply takes the width it takes. No adjustment is written, and no
  // font metrics are needed -- which is why this still works with a font that states none.
  for (const options of [undefined, { descendantFonts: false }]) {
    const { stream, runs } = await replaceAndMeasure(body(`[${glyphs("令和")}] TJ`), "令和", "しょうわ", "fallback-font", options);
    assert.deepEqual(runs, ["しょうわ"]);
    assert.match(stream, /^BT \/FJP 36 Tf 24 60 Td \/ILPFallback 36 Tf \[<[0-9a-f]+>\] TJ \/FJP 36 Tf ET$/);
  }
});

/* ------------------------------------------------------------------------- fail closed */

test("refuses every TJ whose following text it cannot prove it keeps in place", { skip }, async () => {
  // Each case must be refused with the named code, and must leave the document untouched:
  // "we could not compute it, so let it through" is exactly what these guard against.
  const cases = [
    // No /W, no /DW, no descendant font at all: nothing states this font's widths, so the
    // width of the text being removed cannot be known and 8年度 cannot be kept in place.
    {
      content: body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`),
      options: { descendantFonts: false },
      replacement: "しょ",
      code: "FALLBACK_FONT_METRICS_UNAVAILABLE"
    },
    // Character spacing in force and a different number of glyphs: the difference is a
    // multiple of Tc, which a TJ adjustment cannot express exactly at every font size.
    {
      content: body(`3 Tc [${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`),
      replacement: "しょうわ",
      code: "FALLBACK_CHAR_SPACING_UNSUPPORTED"
    },
    // A text-state change between two operands of the match: they are drawn under
    // different state, and this rewrite draws them as one.
    {
      content: body(`[${glyphs("令")}] TJ 3 Tc [${glyphs("和")} -50 ${glyphs("8年度")}] TJ`),
      replacement: "しょ",
      code: "FALLBACK_MULTI_RUN_UNSUPPORTED"
    },
    {
      content: body(`[${glyphs("令")}] TJ 1 0 0 rg [${glyphs("和")} -50 ${glyphs("8年度")}] TJ`),
      replacement: "しょ",
      code: "FALLBACK_MULTI_RUN_UNSUPPORTED"
    },
    // A stray number between two TJ operators is not a displacement -- a reader discards
    // it -- so this refuses to describe the region rather than counting it as one.
    {
      content: body(`[${glyphs("令")}] TJ 120 [${glyphs("和")} -50 ${glyphs("8年度")}] TJ`),
      replacement: "しょ",
      code: "FALLBACK_LAYOUT_UNSUPPORTED"
    },
    // ' and " carry a line move this rewrite does not account for; they are still refused.
    { content: body(`14 TL ${glyphs("令和")} '`), replacement: "しょ", code: "FALLBACK_OPERATOR_UNSUPPORTED" },
    { content: body(`14 TL 0 0 ${glyphs("令和")} "`), replacement: "しょ", code: "FALLBACK_OPERATOR_UNSUPPORTED" },
    // A match half in a TJ and half in a Tj would have to be both rewrites at once.
    { content: body(`[${glyphs("令")}] TJ ${glyphs("和")} Tj`), replacement: "しょ", code: "FALLBACK_OPERATOR_UNSUPPORTED" }
  ];
  for (const { content, options, replacement, code } of cases) {
    const original = makePdf(content, options);
    const editor = await editorFor(content, options);
    const [match] = await editor.searchText("令和");
    assert.ok(match, `the fixture must contain 令和: ${content}`);

    const verdict = await editor.checkTextMatchReplacement(match.id, replacement);
    assert.equal(verdict.allowed, false, `should have been refused: ${content}`);
    assert.equal(verdict.code, code, `for: ${content}`);

    // replaceTextMatch() must reach the identical verdict, and change nothing.
    await assert.rejects(editor.replaceTextMatch(match.id, replacement), (error) => {
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(editor.pending.size, 0);
    assert.equal(editor.pendingObjects.size, 0);
    assert.equal(editor.pendingStreams.size, 0);
    assert.deepEqual(await editor.save(), original, `the document must be untouched: ${content}`);
  }
});

test("refuses a vertical font drawn by TJ, exactly as it does one drawn by Tj", { skip }, async () => {
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`)),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-V /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    encode(`7 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Doc /FontDescriptor 8 0 R /DW 1000 /W [${W_ARRAY}] /CIDToGIDMap /Identity >>\nendobj\n`),
    encode("8 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Doc /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n")
  ]);
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  const refused = await editor.checkTextMatchReplacement(match.id, "しょ");
  assert.equal(refused.code, "FALLBACK_WRITING_MODE_UNSUPPORTED");
  assert.deepEqual(await editor.save(), pdf);
});

test("refuses a replacement the fallback font cannot write either, before touching the file", { skip }, async () => {
  const content = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);
  const editor = await editorFor(content);
  const [match] = await editor.searchText("令和");
  const refused = await editor.checkTextMatchReplacement(match.id, "\u{e000}ょ");
  assert.equal(refused.code, "FALLBACK_FONT_MISSING_GLYPH");
  assert.deepEqual(refused.characters, ["\u{e000}"]);
  assert.equal(editor.pendingObjects.size, 0);
});

/* ------------------------------------------------------ what it costs, and doing it twice */

test("embeds the fallback font once per document, and the update is otherwise small", { skip }, async () => {
  const content = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ ${glyphs("申請")} Tj [${glyphs("令和")} -50 ${glyphs("平成")}] TJ`);
  const editor = await editorFor(content);
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2, "two separate TJ arrays draw 令和");
  await editor.replaceTextMatch(matches[0].id, "しょ");
  // The second match is in a different TJ operator, so it is still editable in this session.
  await editor.replaceTextMatch(matches[1].id, "たい");

  const saved = await editor.save();
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g).length, 1, "the font program must be written once");

  const reopened = new PdfTextEditor(saved);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ", "8年度", "申請", "たい", "平成"]);
  assert.deepEqual(await reopened.searchText("令和"), []);

  // A second round trip adds the new glyphs, not the font again.
  await reopened.setFallbackFont(Uint8Array.from(fontBytes));
  const [again] = await reopened.searchText("しょ");
  await reopened.replaceTextMatch(again.id, "めい");
  const twice = await reopened.save();
  assert.equal(latin1.decode(twice).match(/\/FontFile2/g).length, 1);
  assert.ok(twice.length - saved.length < 100_000, `the second save re-embedded the font: +${twice.length - saved.length} bytes`);
  assert.deepEqual((await new PdfTextEditor(twice).listTextRuns()).map((run) => run.text), ["めい", "8年度", "申請", "たい", "平成"]);
});

test("refuses to edit a TJ stretch it has already rewritten, until the file is saved", { skip }, async () => {
  // The rewrite restructured the operators the text was drawn by, so every run inside the
  // stretch -- the match's own operands and the neighbouring ones copied through it -- is
  // described by byte offsets that no longer hold.
  const editor = await editorFor(body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`));
  const [match] = await editor.searchText("令和");
  await editor.replaceTextMatch(match.id, "しょ");
  const staged = new Map(editor.pendingStreams);

  const [neighbour] = await editor.searchText("8年度");
  const refused = await editor.checkTextMatchReplacement(neighbour.id, "申請");
  assert.equal(refused.code, "FALLBACK_EDIT_REQUIRES_SAVE");
  assert.deepEqual([...editor.pendingStreams], [...staged], "the refusal must not disturb what is already staged");

  // Saving and reopening settles it, as the message says.
  const reopened = new PdfTextEditor(await editor.save());
  await reopened.setFallbackFont(fontBytes);
  const [fresh] = await reopened.searchText("8年度");
  assert.deepEqual(await reopened.checkTextMatchReplacement(fresh.id, "申請"), { allowed: true, mode: "single-run" });
});

test("folds an ordinary replacement staged on a neighbouring operand into the rewrite", { skip }, async () => {
  // 平成 is written through the document's own font; the TJ rewrite then spans the operand
  // that edit sits in. Both have to end up in the file, and neither may overwrite the other.
  const editor = await editorFor(body(`[${glyphs("令和")} -50 ${glyphs("8年度")} 0 ${glyphs("平成")}] TJ`));
  const [year] = await editor.searchText("平成");
  await editor.replaceTextMatch(year.id, "申請");
  const [era] = await editor.searchText("令和");
  await editor.replaceTextMatch(era.id, "しょ");

  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ", "8年度", "申請"]);
  assert.equal((await reopened.searchText("申請")).length, 1);
  assert.deepEqual(await reopened.searchText("平成"), []);
});

/* ------------------------------------------------ a simple, single-byte-encoded font */

/**
 * The other kind of font a TJ can be drawn with: a simple TrueType font, one byte per
 * code, whose widths live in `/Widths` indexed from `/FirstChar`. Word spacing really does
 * reach its code 32, which is what makes the `Tw` rule below more than theoretical.
 */
const SIMPLE_WIDTHS = new Map([[" ", 250], ["R", 700], ["e", 550], ["i", 300], ["w", 800], ["a", 550], ["8", 600], ["n", 560], ["d", 560], ["o", 560]]);
const SIMPLE_FIRST_CHAR = 32;
const SIMPLE_WIDTH_ARRAY = Array.from({ length: 95 }, (_, index) => SIMPLE_WIDTHS.get(String.fromCharCode(SIMPLE_FIRST_CHAR + index)) ?? 500);
const codes = (text) => `<${[...text].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}>`;

function makeSimplePdf(content) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode(`5 0 obj\n<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Simple /FirstChar ${SIMPLE_FIRST_CHAR} /LastChar 126 /Widths [${SIMPLE_WIDTH_ARRAY.join(" ")}] /FontDescriptor 6 0 R >>\nendobj\n`),
    encode("6 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Simple /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 0 >>\nendobj\n")
  ]);
}

test("measures a simple font from its own /Widths, and keeps the text after the match in place", { skip }, async () => {
  // Reiwa is 700 + 550 + 300 + 800 + 550 = 2900 glyph-space units wide; しょ is 2000, so
  // the array has to be pushed forward by 900 for 8nendo to stay where it was.
  const content = `BT /F1 12 Tf 24 60 Td [${codes("Reiwa")} -50 ${codes("8nendo")}] TJ ET`;
  const original = makeSimplePdf(content);
  const editor = new PdfTextEditor(original);
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("Reiwa");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょ"), { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();

  const after = simulate(await streamTextOf(saved), fontTable(saved));
  const before = simulate(content, fontTable(original));
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F1").map((glyph) => glyph.x);
  assert.deepEqual(trailing(after), trailing(before).slice(5), "8nendo must be drawn exactly where it was");
  assert.match(await streamTextOf(saved), /\/F1 12 Tf \[-900 -50 <386e656e646f>\] TJ/);
  assert.deepEqual((await new PdfTextEditor(saved).listTextRuns()).map((run) => run.text), ["しょ", "8nendo"]);
});

test("refuses to remove a single-byte space while word spacing is in force", { skip }, async () => {
  // Tw is added to every code 32 the original drew, and reaches nothing written through
  // the fallback font's 2-byte encoding -- so removing that space would move 8nendo by Tw.
  const content = `BT /F1 12 Tf 24 60 Td 20 Tw [${codes("Rei wa")} -50 ${codes("8nendo")}] TJ ET`;
  const editor = new PdfTextEditor(makeSimplePdf(content));
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("Rei wa");
  const refused = await editor.checkTextMatchReplacement(match.id, "しょ");
  assert.equal(refused.code, "FALLBACK_WORD_SPACING_UNSUPPORTED");
  assert.deepEqual(await editor.save(), makeSimplePdf(content));

  // With word spacing off it is written, and 8nendo still does not move.
  const plainContent = `BT /F1 12 Tf 24 60 Td [${codes("Rei wa")} -50 ${codes("8nendo")}] TJ ET`;
  const plain = new PdfTextEditor(makeSimplePdf(plainContent));
  await plain.setFallbackFont(fontBytes);
  const [plainMatch] = await plain.searchText("Rei wa");
  assert.deepEqual(await plain.checkTextMatchReplacement(plainMatch.id, "しょ"), { allowed: true, mode: "fallback-font" });
  await plain.replaceTextMatch(plainMatch.id, "しょ");
  const saved = await plain.save();
  const trailing = (drawn) => drawn.filter((glyph) => glyph.font === "F1").map((glyph) => glyph.x);
  assert.deepEqual(
    trailing(simulate(await streamTextOf(saved), fontTable(saved))),
    trailing(simulate(plainContent, fontTable(makeSimplePdf(plainContent)))).slice(6)
  );
});
