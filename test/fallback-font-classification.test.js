// PoC: choosing BIZ UD明朝 (serif) or BIZ UDゴシック (sans) as the fallback font, per match,
// from the source run's own FontDescriptor -- rather than always BIZ UDGothic (v0.4.0-v0.4.4).
//
// The goal is stated in the PoC brief this exists for: less visual mismatch between the
// document's own type and a fallback replacement, without touching reflow, layout, or any
// existing safety judgement. This file is the Go/No-Go evidence for that:
//
// - classification comes only from FontDescriptor /Flags (PDF 32000-1:2008, 9.8.2, Table
//   123, bit 2 = Serif), read through the same object resolver font-metrics.js already
//   uses for glyph widths -- never from a font's name, and never a large hand-written
//   dictionary (see src/font-classification.js).
// - setFallbackFont() (single font) is untouched: everything still routes to it regardless
//   of the source font's own classification.
// - setFallbackFonts({ sans, serif }) is new: a serif source font gets the serif fallback
//   only when one was actually supplied; sans, unknown, and "serif but no serif fallback
//   registered" all fall back to sans -- the v0.4.4 behaviour.
// - both fonts can be embedded in the same document, each once, reused across further
//   edits and across save/reopen.
// - every existing safety judgement (glyph-width measurement, the TJ overflow check, word
//   spacing, multi-run rules, ...) is completely unaffected by which of the two fonts ends
//   up selected -- these tests exercise the classification and embedding machinery, not a
//   second copy of the safety rules, which test/fallback-font*.test.js already cover.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import { diagnoseFallbackFontSelection } from "../src/pdf-document.js";
import { TEST_FONT, TEST_FONT_SERIF, readTestFont, readTestFontSerif } from "../scripts/fetch-test-font.js";
import { CMAP, W_ARRAY, buildPdf, encode, glyphs, streamObject } from "./helpers/document-font.js";

const sansBytes = readTestFont();
const serifBytes = readTestFontSerif();
const skip = sansBytes && serifBytes
  ? false
  : `${TEST_FONT.name} and/or ${TEST_FONT_SERIF.name} are not present -- run \`npm run test:font\` to fetch them`;

const latin1 = new TextDecoder("latin1");

/** FontDescriptor /Flags: bit 2 (value 2) is Serif. Bit 6 (value 32) is Nonsymbolic. */
const FLAGS = { serif: 34, sans: 32 };

/**
 * A Type0 / Identity-H font over a CIDFontType2 descendant, in the same shape real Japanese
 * PDFs use and the rest of test/fallback-font*.test.js already relies on (see
 * test/helpers/document-font.js) -- except the FontDescriptor's /Flags is a parameter, so
 * the same document shape can be built as clearly-serif, clearly-sans, or (flags: null)
 * carrying no FontDescriptor at all, which is what makes it unclassifiable.
 *
 * `resourceName` names the font in /Resources /Font (default /FJP, matching the rest of
 * the fallback-font tests); `startAt` numbers the objects from there, so two of these can
 * be placed in one document without colliding (see makeMixedPdf() below).
 */
function fontObjects(startAt, { flags, resourceName }) {
  const [type0, cmap, cidFont, descriptor] = [startAt, startAt + 1, startAt + 2, startAt + 3];
  const objects = [
    encode(`${type0} 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${cmap} 0 R >>\nendobj\n`),
    streamObject(cmap, CMAP),
    encode(`${cidFont} 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Doc /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`
      + `${flags === null ? "" : ` /FontDescriptor ${descriptor} 0 R`} /DW 1000 /W [${W_ARRAY}] /CIDToGIDMap /Identity >>\nendobj\n`)
  ];
  if (flags !== null) {
    objects.push(encode(`${descriptor} 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Doc /Flags ${flags} /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n`));
  }
  return { objects, type0, resourceName, nextObject: startAt + objects.length };
}

/** A one-page, one-font document -- serif, sans, or unclassifiable (flags: null). */
function makePdf(content, { flags }) {
  const font = fontObjects(5, { flags, resourceName: "FJP" });
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /FJP ${font.type0} 0 R >> >> >>\nendobj\n`),
    streamObject(4, content),
    ...font.objects
  ]);
}

/** A one-page document with two source fonts: /FSerif and /FSans, each in its own run. */
function makeMixedPdf() {
  // Objects 1-4 are Catalog / Pages / Page / content stream; each fontObjects() call is
  // numbered from wherever the previous one left off, and buildPdf() numbers objects by
  // their position in this array -- so these must match the array positions exactly.
  const serif = fontObjects(5, { flags: FLAGS.serif, resourceName: "FSerif" });
  const sans = fontObjects(serif.nextObject, { flags: FLAGS.sans, resourceName: "FSans" });
  const content = `BT /FSerif 36 Tf 20 120 Td ${glyphs("令和")} Tj ET`
    + `BT /FSans 36 Tf 20 40 Td ${glyphs("令和")} Tj ET`;
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 200] /Contents 4 0 R /Resources << /Font << /FSerif ${serif.type0} 0 R /FSans ${sans.type0} 0 R >> >> >>\nendobj\n`),
    streamObject(4, content),
    ...serif.objects,
    ...sans.objects
  ]);
}

const body = (operators) => `BT /FJP 36 Tf 20 60 Td ${operators} ET`;
const REIWA = body(`${glyphs("令和")} Tj`);

const fontFile2Count = (pdf) => (latin1.decode(pdf).match(/\/FontFile2/g) ?? []).length;
const embeddedDigests = (pdf) => new Set([...latin1.decode(pdf).matchAll(/\/ILPFallbackFont\s*<\s*([0-9a-f]+)\s*>/g)].map((m) => m[1]));

/* ---------------------------------------------------------------------- serif fixture */

test("a serif source font selects BIZ UD明朝, and only BIZ UD明朝 is embedded", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });

  const [match] = await editor.searchText("令和");
  assert.ok(match, "the fixture must contain 令和");

  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "serif");
  assert.equal(diagnosis.selectedRole, "serif");

  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょ"), { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();

  const reopened = new PdfTextEditor(saved);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ"]);
  assert.equal((await reopened.searchText("しょ")).length, 1, "the replacement must be searchable");
  assert.deepEqual(await reopened.searchText("令和"), []);

  assert.equal(fontFile2Count(saved), 1, "exactly one font program must be embedded");
  const text = latin1.decode(saved);
  assert.match(text, /\/BaseFont\s*\/BIZUDMincho-Regular/, "BIZ UD明朝 must be the embedded font's BaseFont");
  // The Gothic (sans) fallback must never have been touched: no second /FontFile2, and the
  // digest recorded on the one Type0 this wrote is Mincho's, not Gothic's.
  assert.ok(!text.includes("BIZUDGothic"), "BIZ UDゴシック must not have been embedded for an all-serif document");
});

test("BIZ UD明朝's own embedded FontDescriptor still classifies as serif after save/reopen, and is reused", { skip }, async () => {
  // The regression this guards: buildFallbackFontObjects() writes a FontDescriptor for the
  // fallback font it embeds, and that FontDescriptor is itself read by classifyFontResource()
  // the next time this engine looks at that font resource -- including when the "source
  // font" of a later edit is text this engine itself already wrote in BIZ UD明朝. If that
  // descriptor did not carry the Serif bit, a document edited a second time after save/
  // reopen would silently drop back to BIZ UDゴシック for text that is, by then, already
  // drawn in BIZ UD明朝 -- defeating the whole point of choosing it in the first place.
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [firstMatch] = await editor.searchText("令和");
  await editor.replaceTextMatch(firstMatch.id, "しょ");
  const saved = await editor.save();

  const reopened = new PdfTextEditor(saved);
  await reopened.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [match] = await reopened.searchText("しょ");
  assert.ok(match, "the reopened document must still contain しょ, drawn in the embedded BIZ UD明朝");

  const diagnosis = await diagnoseFallbackFontSelection(reopened, match.id);
  assert.equal(diagnosis.classification, "serif", "BIZ UD明朝's own FontDescriptor must classify as serif, not sans");
  assert.equal(diagnosis.selectedRole, "serif");

  await reopened.replaceTextMatch(match.id, "しょうわ");
  const twice = await reopened.save();

  assert.equal(fontFile2Count(twice), 1, "still only BIZ UD明朝 -- BIZ UDゴシック must never have been embedded");
  assert.equal(embeddedDigests(twice).size, 1);
  const final = new PdfTextEditor(twice);
  assert.equal((await final.searchText("しょうわ")).length, 1);
});

/* ----------------------------------------------------------------------- sans fixture */

test("a sans-serif source font selects BIZ UDゴシック, and only BIZ UDゴシック is embedded", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.sans }));
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });

  const [match] = await editor.searchText("令和");
  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "sans");
  assert.equal(diagnosis.selectedRole, "sans");

  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();

  const reopened = new PdfTextEditor(saved);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょ"]);
  assert.equal((await reopened.searchText("しょ")).length, 1);

  assert.equal(fontFile2Count(saved), 1, "exactly one font program must be embedded");
  const text = latin1.decode(saved);
  assert.match(text, /\/BaseFont\s*\/BIZUDGothic-Regular/);
  assert.ok(!text.includes("BIZUDMincho"), "BIZ UD明朝 must not have been embedded for an all-sans document");
});

/* -------------------------------------------------------------------- unknown fixture */

test("a FontDescriptor-less source font is unknown, and still falls back to BIZ UDゴシック", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: null }));
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });

  const [match] = await editor.searchText("令和");
  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "unknown");
  assert.equal(diagnosis.selectedRole, "sans", "unknown must fall back to the current-compatible sans font");

  // The safety condition is unaffected by any of this: the same overflow/position rules
  // apply, checked here only incidentally via a normal allowed replacement.
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょ"), { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();
  assert.match(latin1.decode(saved), /\/BaseFont\s*\/BIZUDGothic-Regular/);
  assert.ok(!latin1.decode(saved).includes("BIZUDMincho"));
});

test("a caller using only setFallbackFont() is unaffected by classification, exactly as v0.4.4", { skip }, async () => {
  // The back-compat guarantee, checked against a document whose own font is clearly serif:
  // with no "serif" role ever registered, the single font set by setFallbackFont() -- the
  // "sans" role internally -- is used regardless.
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await editor.setFallbackFont(sansBytes);

  const [match] = await editor.searchText("令和");
  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "serif", "the source font is still read as serif");
  assert.equal(diagnosis.selectedRole, "sans", "but only the sans role is registered, so that is what is used");
  assert.deepEqual(diagnosis.availableRoles, ["sans"]);

  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();
  assert.match(latin1.decode(saved), /\/BaseFont\s*\/BIZUDGothic-Regular/);
});

/* -------------------------------------------------------- serif/sans mixed in one PDF */

test("a serif run and a sans run in the same document each get their own fallback font", { skip }, async () => {
  const editor = new PdfTextEditor(makeMixedPdf());
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });

  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2, "one match per font run");
  const [serifMatch, sansMatch] = matches[0].fontName === "FSerif" ? matches : [matches[1], matches[0]];

  const serifDiagnosis = await diagnoseFallbackFontSelection(editor, serifMatch.id);
  assert.equal(serifDiagnosis.classification, "serif");
  assert.equal(serifDiagnosis.selectedRole, "serif");
  const sansDiagnosis = await diagnoseFallbackFontSelection(editor, sansMatch.id);
  assert.equal(sansDiagnosis.classification, "sans");
  assert.equal(sansDiagnosis.selectedRole, "sans");

  // "しょ" and "めいじ" share no substring, so later searches for either cannot pick up
  // the other -- unlike, say, "しょ" and "たいしょう".
  await editor.replaceTextMatch(serifMatch.id, "しょ");
  const refreshed = await editor.searchText("令和");
  assert.equal(refreshed.length, 1, "only the sans occurrence is left");
  await editor.replaceTextMatch(refreshed[0].id, "めいじ");

  const saved = await editor.save();
  assert.equal(fontFile2Count(saved), 2, "both fallback fonts must be embedded, each once");
  assert.equal(embeddedDigests(saved).size, 2, "the two embedded fonts must carry different digests");

  const reopened = new PdfTextEditor(saved);
  const texts = (await reopened.listTextRuns()).map((run) => run.text);
  assert.deepEqual(new Set(texts), new Set(["しょ", "めいじ"]));
  assert.equal((await reopened.searchText("しょ")).length, 1);
  assert.equal((await reopened.searchText("めいじ")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);

  // Both /Font resource names on the one shared page must be distinct.
  await reopened.listTextRuns();
  const pageDictionary = reopened.document.object(3).dictionary;
  const fontNames = [...pageDictionary.matchAll(/\/(\w+)\s+\d+\s+0\s+R/g)].map((m) => m[1]);
  assert.equal(new Set(fontNames).size, fontNames.length, `resource names must not collide: ${fontNames.join(", ")}`);

  // Editing further, after reopening, reuses both already-embedded fonts rather than
  // embedding either again.
  await reopened.setFallbackFonts({ sans: Uint8Array.from(sansBytes), serif: Uint8Array.from(serifBytes) });
  const [again] = await reopened.searchText("しょ");
  await reopened.replaceTextMatch(again.id, "しょうわ");
  const twice = await reopened.save();
  assert.equal(fontFile2Count(twice), 2, "reusing both fonts must not embed either again");
  assert.ok(twice.length - saved.length < 200_000, `reopening and reusing must not re-embed a multi-megabyte font: +${twice.length - saved.length} bytes`);

  const final = new PdfTextEditor(twice);
  assert.equal((await final.searchText("しょうわ")).length, 1);
  assert.equal((await final.searchText("めいじ")).length, 1);
});

test("registers a second fallback font on a page the first already touched, without colliding on resource name", { skip }, async () => {
  // A narrower version of the mixed-document test above, isolating exactly the resource-
  // name bookkeeping: two different fallback fonts, registered in two separate commits, on
  // the very same page's /Font sub-dictionary.
  const editor = new PdfTextEditor(makeMixedPdf());
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const matches = await editor.searchText("令和");
  await editor.replaceTextMatch(matches[0].id, "しょ");
  await editor.replaceTextMatch((await editor.searchText("令和"))[0].id, "たいしょう");
  const saved = await editor.save();

  const text = latin1.decode(saved);
  const resourceNames = [...text.matchAll(/\/(ILPFallback\d*)\s+\d+\s+0\s+R/g)].map((m) => m[1]);
  assert.ok(resourceNames.length >= 2, `expected at least two fallback resource names, got ${resourceNames.join(", ")}`);
  assert.equal(new Set(resourceNames).size, resourceNames.length, `fallback resource names must be distinct: ${resourceNames.join(", ")}`);

  const reopened = new PdfTextEditor(saved);
  assert.deepEqual(new Set((await reopened.listTextRuns()).map((run) => run.text)), new Set(["しょ", "たいしょう"]));
});

/* --------------------------------------------------- "sans" must be registered first */

test("refuses setFallbackFonts({ serif }) alone -- serif has nothing to fall back to without sans", { skip }, async () => {
  // The bug this guards: without this check, a document whose own font is read as "sans"
  // or "unknown" would have nothing registered for selectFallbackFont() to fall back to,
  // and would end up drawn in the serif font instead -- the opposite of the documented
  // "unknown/sans always falls back to sans" behaviour.
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.sans }));
  await assert.rejects(editor.setFallbackFonts({ serif: serifBytes }), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_INVALID");
    return true;
  });
  assert.equal(editor.fallbackFonts.size, 0, "nothing may have been registered");

  // Registering sans first (or together) makes it work.
  await editor.setFallbackFonts({ sans: sansBytes });
  await editor.setFallbackFonts({ serif: serifBytes });
  const [match] = await editor.searchText("令和");
  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "sans");
  assert.equal(diagnosis.selectedRole, "sans", "a sans-classified source font must still use sans, not the newly-registered serif");
});

test("a single setFallbackFonts({ sans, serif }) call naming both roles is all-or-nothing", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await editor.setFallbackFonts({ sans: sansBytes });
  const [match] = await editor.searchText("令和");
  await editor.replaceTextMatch(match.id, "しょ");

  // "sans" is already in use; the whole call must be refused, including "serif", which
  // has not been used yet and would otherwise have been registered on its own.
  await assert.rejects(editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes }), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_ALREADY_IN_USE");
    return true;
  });
  assert.ok(!editor.fallbackFonts.has("serif"), "serif must not have been registered when the same call's sans was refused");
});

/* ------------------------------------------------ "sans" and "serif" must be distinct */

test("refuses the same font program for both sans and serif", { skip }, async () => {
  // The bug this guards: registerFallbackResource()'s page/Font bookkeeping recognizes an
  // already-registered font by digest alone, shared across roles, while each role still
  // gets its own Type0/CIDFont/ToUnicode object numbers and its own glyph set. Two roles
  // sharing one program would let the second role's page registration silently reuse the
  // first role's page/Font entry while writing descendant-font objects nothing points to --
  // so glyphs only the second role's replacement needed would be missing from the /W and
  // ToUnicode the page actually reads through.
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await assert.rejects(editor.setFallbackFonts({ sans: sansBytes, serif: sansBytes }), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_INVALID");
    return true;
  });
  assert.equal(editor.fallbackFonts.size, 0, "nothing may have been registered");
});

test("refuses registering the same font program for the other role in a later call", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await editor.setFallbackFonts({ sans: sansBytes });
  await assert.rejects(editor.setFallbackFonts({ serif: sansBytes }), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_INVALID");
    return true;
  });
  assert.ok(!editor.fallbackFonts.has("serif"), "serif must not have been registered");

  // And the reverse order: overwriting "sans" (not yet used) with the digest "serif"
  // already carries must be refused too, leaving the original "sans" font in place.
  const other = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await other.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const sansDigestBefore = other.fallbackFonts.get("sans").digest;
  await assert.rejects(other.setFallbackFont(serifBytes), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_INVALID");
    return true;
  });
  assert.equal(other.fallbackFonts.get("sans").digest, sansDigestBefore, "the original sans font must be untouched by the refused call");
});

test("distinct BIZ UDGothic / BIZ UDMincho fonts still register and work as before", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA, { flags: FLAGS.serif }));
  await editor.setFallbackFonts({ sans: sansBytes, serif: serifBytes });
  const [match] = await editor.searchText("令和");
  const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
  assert.equal(diagnosis.classification, "serif");
  assert.equal(diagnosis.selectedRole, "serif");
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();
  assert.match(latin1.decode(saved), /\/BaseFont\s*\/BIZUDMincho-Regular/);
});
