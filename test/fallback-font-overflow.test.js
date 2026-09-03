// v0.4.4: refusing a fallback replacement that would overrun the text after it.
//
// v0.4.1 through v0.4.3 kept a TJ-drawn match's FOLLOWING text at exactly the x it had
// before, by writing one adjustment computed from the two fonts' widths (see
// planTextArrayRewrite() in src/pdf-document.js and test/fallback-font-tj.test.js). That
// adjustment can always be chosen, however wide the replacement is -- it only moves where
// the NEXT string starts. What it cannot do is undraw the replacement's OWN glyphs from
// the space that move reclaims: a real edit of a real PDF (令和 -> しょうわ, reported
// against v0.4.3) showed exactly that -- the following text landed at the right x, with
// the replacement's own trailing glyph drawn on top of it.
//
// This file is the synthetic half of the fix: exact, engineered widths so the boundary
// between "fits" and "overflows" is checked at values chosen for the test, not left to
// whatever a real font happens to produce. test/fallback-font-tj.test.js carries the
// real-world narrative version (令和 -> しょ vs. 令和 -> しょうわ) against the real fallback
// font's own widths.
//
// The matched text's own width is controlled by the document's /W array (see
// test/helpers/document-font.js: 令 and 和 are both exactly 1000 glyph-space units, so a
// match of both is exactly 2000 -- an availableAdvance chosen to be round). The
// replacement's width is not controllable at all: it is whatever the real fallback font
// (BIZ UDGothic) draws, and every character it has is quantized to 500 (half-width
// Latin/digits/punctuation) or 1000 (full-width kana/kanji) glyph-space units -- so the
// "narrow" and "wide" cases below are chosen from THOSE increments, not from the 1800 /
// 4000 example values in the design discussion, which do not both land on a real advance
// with this font. The overflow case (2000 vs. 4000) still matches that example exactly.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import { TEST_FONT, readTestFont } from "../scripts/fetch-test-font.js";
import { CMAP, W_ARRAY, buildPdf, encode, glyphs, streamObject } from "./helpers/document-font.js";

const fontBytes = readTestFont();
const skip = fontBytes ? false : `${TEST_FONT.name} is not present -- run \`npm run test:font\` to fetch it`;

/** Same shape as fallback-font-tj.test.js's fixture: a real CID font's /W and /DW. */
function makePdf(content) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    encode(`7 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Doc /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /W [${W_ARRAY}] /CIDToGIDMap /Identity >>\nendobj\n`),
    encode("8 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Doc /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n")
  ]);
}

const body = (operators) => `BT /FJP 36 Tf 24 60 Td ${operators} ET`;

async function editorFor(content) {
  const editor = new PdfTextEditor(makePdf(content));
  await editor.setFallbackFont(fontBytes);
  return editor;
}

/* --------------------------------------------------------------- A, B, C: narrow/equal/wide */

test("allows a replacement narrower than the slot it would occupy", { skip }, async () => {
  // 令和 is 2000 units wide (availableAdvance); "abc" is 500 x 3 = 1500 in the fallback
  // font (replacementAdvance) -- narrower, so the existing TJ adjustment simply leaves a
  // gap before 8年度, exactly as it always has.
  const editor = await editorFor(body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`));
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "abc");
  assert.deepEqual(verdict, { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "abc");
  await editor.save();
});

test("allows a replacement exactly as wide as the slot it would occupy", { skip }, async () => {
  // しょ is 1000 x 2 = 2000 in the fallback font -- exactly availableAdvance. Equal is
  // safe (no floating-point tolerance needed: both sides are the same integer).
  const editor = await editorFor(body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`));
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "しょ");
  assert.deepEqual(verdict, { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょ");
  await editor.save();
});

test("refuses a replacement wider than the slot it would occupy", { skip }, async () => {
  // しょうわ is 1000 x 4 = 4000 -- double availableAdvance (2000). This is the exact shape
  // of the reported bug: しょうわ drawn over 8年度. Refused before anything is written.
  const content = body(`[${glyphs("令和")} -50 ${glyphs("8年度")}] TJ`);
  const original = makePdf(content);
  const editor = await editorFor(content);
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.mode, null);
  assert.equal(verdict.code, "FALLBACK_LAYOUT_UNSUPPORTED");
  assert.equal(verdict.unsafeReason, "fallback-replacement-overflows-slot");
  assert.deepEqual(verdict.diagnostics, { replacementAdvance: 4000, availableAdvance: 2000 });

  await assert.rejects(editor.replaceTextMatch(match.id, "しょうわ"), (error) => {
    assert.equal(error.code, "FALLBACK_LAYOUT_UNSUPPORTED");
    assert.equal(error.unsafeReason, "fallback-replacement-overflows-slot");
    assert.deepEqual(error.diagnostics, { replacementAdvance: 4000, availableAdvance: 2000 });
    return true;
  });

  // Atomic failure: nothing was staged, and the document is byte-for-byte untouched.
  assert.equal(editor.pending.size, 0);
  assert.equal(editor.pendingObjects.size, 0);
  assert.equal(editor.pendingStreams.size, 0);
  assert.equal(editor.fallbackEmbedding, null, "no font embedding may have been recorded");
  assert.deepEqual(await editor.save(), original, "the document must be byte-for-byte untouched, including no embedded font");
});

/* ------------------------------------------------------------ D: no downstream dependency */

test("does not refuse an over-width replacement whose following position does not depend on it", { skip }, async () => {
  // Same "wide" しょうわ as the refused case above, but nothing is drawn from the match's
  // end at all: the array ends there and ET follows. Nothing downstream can overlap it, so
  // the slot-overflow check does not apply -- this is not a claim that the page has room,
  // only that nothing in this text flow depends on where the replacement ends.
  const editor = await editorFor(body(`[${glyphs("令和")}] TJ`));
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.deepEqual(verdict, { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょうわ");
  const saved = await editor.save();
  assert.deepEqual((await new PdfTextEditor(saved).listTextRuns()).map((run) => run.text), ["しょうわ"]);
});

test("does not refuse an over-width replacement whose following text is explicitly repositioned", { skip }, async () => {
  // 8年度 is drawn again, but after a fresh Td -- so its position is set outright, not
  // inherited from where the match ended. The overflow check does not need to run because
  // there is nothing in the same flow whose start position it would have to protect, not
  // because the replacement happens to fit.
  const editor = await editorFor(`BT /FJP 36 Tf 24 60 Td [${glyphs("令和")}] TJ 0 -20 Td ${glyphs("8年度")} Tj ET`);
  const [match] = await editor.searchText("令和");
  const verdict = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.deepEqual(verdict, { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょうわ");
  const saved = await editor.save();
  assert.deepEqual((await new PdfTextEditor(saved).listTextRuns()).map((run) => run.text), ["しょうわ", "8年度"]);
});

/* --------------------------------------------------------- E: TJ adjustment moves the line */

test("measures availableAdvance from the real following-text position, not just glyph widths", { skip }, async () => {
  // 令 and 和 are drawn as two separate operands of one TJ array with a displacement K
  // between them -- still 2000 units of glyph width between them, but the actual position
  // 8年度 must keep is 2000 - K (see planTextArrayRewrite()'s "between" in
  // src/pdf-document.js), because a positive TJ number pulls the following text left and a
  // negative one pushes it right. しょ (2000) is used throughout, so only availableAdvance
  // changes across the three cases.
  const cases = [
    // K = 0: availableAdvance is the plain 2000, same as every other test in this file.
    { k: "0", availableAdvance: 2000, allowed: true },
    // K = +500: 8年度's real position is 2000 - 500 = 1500, which しょ (2000) overruns.
    { k: "500", availableAdvance: 1500, allowed: false },
    // K = -500: 8年度's real position is 2000 - (-500) = 2500, comfortably past しょ (2000).
    { k: "-500", availableAdvance: 2500, allowed: true }
  ];
  for (const { k, availableAdvance, allowed } of cases) {
    const content = body(`[${glyphs("令")} ${k} ${glyphs("和")} -50 ${glyphs("8年度")}] TJ`);
    const original = makePdf(content);
    const editor = await editorFor(content);
    const [match] = await editor.searchText("令和");
    const verdict = await editor.checkTextMatchReplacement(match.id, "しょ");
    assert.equal(verdict.allowed, allowed, `K=${k}: ${JSON.stringify(verdict)}`);
    if (allowed) {
      await editor.replaceTextMatch(match.id, "しょ");
      await editor.save();
    } else {
      assert.equal(verdict.unsafeReason, "fallback-replacement-overflows-slot", `K=${k}`);
      assert.deepEqual(verdict.diagnostics, { replacementAdvance: 2000, availableAdvance }, `K=${k}`);
      await assert.rejects(editor.replaceTextMatch(match.id, "しょ"));
      assert.deepEqual(await editor.save(), original, `K=${k}: the document must be untouched`);
    }
  }
});
