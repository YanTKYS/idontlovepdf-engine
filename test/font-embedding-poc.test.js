// EXPERIMENT -- see docs/experiments/font-embedding-poc.md.
//
// The engine writes replacement text through the CMap of the font the PDF already uses,
// so it can only ever write characters the document already contains: 令和 -> 平成 works,
// 令和 -> 昭和 does not. These tests pin that limit, and then check whether embedding a
// Japanese font and switching to it for the replaced run lifts it -- through save, reopen
// and a Unicode search of the reopened document.
//
// The fallback font is fetched by `npm run poc:font` into tmp/, which git does not track;
// without it every test here skips rather than failing.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import {
  checkTextMatchReplacementWithFallback,
  loadFallbackFont,
  replaceTextMatchWithFallbackFont
} from "../src/experimental/font-embedding.js";
import { POC_FONT, readPocFont } from "../scripts/fetch-poc-font.js";

const fontBytes = readPocFont();
const skip = fontBytes ? false : `${POC_FONT.name} is not present -- run \`npm run poc:font\` to fetch it`;
const fallback = fontBytes ? loadFallbackFont(fontBytes) : null;

const encode = (value) => new TextEncoder().encode(value);
const latin1 = new TextDecoder("latin1");

/**
 * A document whose font knows 令 和 で す and nothing else -- the shape of a real PDF with
 * a subsetted embedded font, whose /ToUnicode lists only the characters it actually used.
 * 昭 is therefore unwritable through it, which is the whole problem.
 */
const CODES = new Map([["令", "0001"], ["和", "0002"], ["で", "0003"], ["す", "0004"], ["平", "0005"], ["成", "0006"]]);
const UNICODE = new Map([["0001", "4EE4"], ["0002", "548C"], ["0003", "3067"], ["0004", "3059"], ["0005", "5E73"], ["0006", "6210"]]);
const glyphs = (text) => `<${[...text].map((character) => CODES.get(character)).join("")}>`;

function streamObject(number, content) {
  const stream = encode(content);
  return new Uint8Array([
    ...encode(`${number} 0 obj\n<< /Length ${stream.length} >>\nstream\n`),
    ...stream,
    ...encode("\nendstream\nendobj\n")
  ]);
}

function makePdf(content, { resources = "<< /Font << /FJP 5 0 R >> >>" } = {}) {
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n${UNICODE.size} beginbfchar\n`
    + [...UNICODE].map(([code, unicode]) => `<${code}> <${unicode}>`).join("\n")
    + `\nendbfchar\nendcmap\nend end`;
  const objects = [
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 140] /Contents 4 0 R /Resources ${resources} >>\nendobj\n`),
    streamObject(4, content),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, cmap)
  ];
  const chunks = [encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  chunks.push(encode(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + `${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  ));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

const REIWA = `BT /FJP 36 Tf 20 60 Td ${glyphs("令和")} Tj ET`;

/* -------------------------------------------------- the limit this experiment tests */

test("the document's own font cannot write a character the document never used", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");

  // 平成 is writable: both characters are in this font's CMap.
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "平成"), { allowed: true, mode: "single-run" });

  // 昭和 is not, because 昭 appears nowhere in the document.
  const refused = await editor.checkTextMatchReplacement(match.id, "昭和");
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "FONT_ENCODING_UNSUPPORTED");
  assert.match(refused.reason, /no ToUnicode code for "昭"/);
});

/* ----------------------------------------------------------------- the experiment */

test("embeds a Japanese font and writes a character the document never contained", { skip }, async () => {
  const original = makePdf(REIWA);
  const editor = new PdfTextEditor(original);
  const [match] = await editor.searchText("令和");

  assert.deepEqual(
    await checkTextMatchReplacementWithFallback(editor, match.id, "昭和", { font: fallback }),
    { allowed: true, mode: "fallback-font-whole-run", usesFallbackFont: true }
  );
  const result = await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  assert.equal(result.usedFallbackFont, true);

  const saved = await editor.save();
  const reopened = new PdfTextEditor(saved);

  // Reopened by the engine: the replacement is there, and searchable as Unicode -- so the
  // characters kept their meaning and did not become anonymous glyphs.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["昭和"]);
  assert.equal((await reopened.searchText("昭和")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);

  // The original bytes are still the start of the file: this is an incremental update.
  assert.deepEqual(saved.subarray(0, original.length), original);
  assert.match(latin1.decode(saved), /\/Prev \d+/);
});

test("switches to the embedded font for the run and straight back afterwards", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  const { resourceName, glyphIds } = await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  const reopened = new PdfTextEditor(await editor.save());
  await reopened.listTextRuns();

  // The run is drawn by the embedded font at the size the original Tf set, and the
  // original font is re-stated immediately after, so nothing later in the stream is
  // affected. Everything else about the text state is left alone.
  assert.equal(
    latin1.decode(reopened.streams[0].decoded),
    `BT /FJP 36 Tf 20 60 Td /${resourceName} 36 Tf <${glyphIds.map((id) => id.toString(16).padStart(4, "0")).join("")}> Tj /FJP 36 Tf ET`
  );
});

test("leaves following text in the original font untouched", { skip }, async () => {
  const content = `BT /FJP 36 Tf 20 60 Td ${glyphs("令和")} Tj ET BT /FJP 36 Tf 190 60 Td ${glyphs("です")} Tj ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("令和");
  await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  const reopened = new PdfTextEditor(await editor.save());

  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["昭和", "です"]);
  // です is still drawn by the original font, with its own operand untouched.
  assert.match(latin1.decode(reopened.streams[0].decoded), /ET BT \/FJP 36 Tf 190 60 Td <00030004> Tj ET$/);
});

test("adds the font to the page's resources without disturbing the existing ones", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  const { resourceName, fontObjectNumbers } = await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  const reopened = new PdfTextEditor(await editor.save());
  await reopened.listTextRuns();

  const page = reopened.document.object(3).dictionary;
  assert.match(page, /\/Font << \/FJP 5 0 R \/ILPFallback \d+ 0 R >>/);
  assert.equal(resourceName, "ILPFallback");
  assert.match(page, /\/MediaBox \[0 0 400 140\]/, "the rest of the page dictionary must survive");
  assert.equal(fontObjectNumbers.type0, 7, "new objects are numbered past the document's own");
});

test("picks a resource name the document is not already using", { skip }, async () => {
  // This page already has an /ILPFallback of its own, so the obvious name is taken.
  const editor = new PdfTextEditor(makePdf(REIWA, { resources: "<< /Font << /FJP 5 0 R /ILPFallback 5 0 R >> >>" }));
  const [match] = await editor.searchText("令和");
  const { resourceName } = await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  assert.equal(resourceName, "ILPFallback1");
  assert.match(new PdfTextEditor(await editor.save()).bytes && latin1.decode(await editor.save()), /\/ILPFallback 5 0 R \/ILPFallback1 \d+ 0 R/);
});

test("writes font objects a PDF reader can actually resolve", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  const { fontObjectNumbers, glyphIds } = await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  const reopened = new PdfTextEditor(await editor.save());
  await reopened.listTextRuns();
  const dictionary = (number) => reopened.document.object(number).dictionary;

  // Type0 addressed by glyph id, descending to a CIDFontType2 whose CIDs are glyph ids.
  assert.match(dictionary(fontObjectNumbers.type0), /\/Type \/Font \/Subtype \/Type0 .*\/Encoding \/Identity-H/);
  assert.match(dictionary(fontObjectNumbers.type0), new RegExp(`/DescendantFonts \\[${fontObjectNumbers.cidFont} 0 R\\]`));
  assert.match(dictionary(fontObjectNumbers.cidFont), /\/Subtype \/CIDFontType2/);
  assert.match(dictionary(fontObjectNumbers.cidFont), /\/CIDToGIDMap \/Identity/);
  assert.match(dictionary(fontObjectNumbers.cidFont), /\/CIDSystemInfo << \/Registry \(Adobe\) \/Ordering \(Identity\) \/Supplement 0 >>/);
  assert.match(dictionary(fontObjectNumbers.descriptor), /\/Type \/FontDescriptor/);
  assert.match(dictionary(fontObjectNumbers.descriptor), new RegExp(`/FontFile2 ${fontObjectNumbers.fontFile} 0 R`));

  // The font program itself, with /Length1 giving its uncompressed size.
  assert.match(dictionary(fontObjectNumbers.fontFile), new RegExp(`/Length1 ${fallback.bytes.length}\\b`));

  // Widths for the glyphs actually drawn, scaled from the font's own em to PDF's 1000.
  const widths = dictionary(fontObjectNumbers.cidFont).match(/\/W \[(.*?)\] \/CIDToGIDMap/)[1];
  for (const glyphId of glyphIds) assert.match(widths, new RegExp(`${glyphId} \\[\\d+\\]`));
  assert.match(dictionary(fontObjectNumbers.cidFont), /\/DW 1000/);
});

test("maps every embedded glyph back to its Unicode character", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  const { glyphIds } = await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
  const reopened = new PdfTextEditor(await editor.save());

  // Proved through the engine's own CMap reader rather than by matching the CMap text:
  // reopening decodes the run to 昭和, which only works if ToUnicode is right.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["昭和"]);
  assert.deepEqual(glyphIds, ["昭", "和"].map((character) => fallback.font.charToGlyph(character).index));
});

/* ------------------------------------------------ the existing path is still first */

test("does not embed anything when the document's own font can write the replacement", { skip }, async () => {
  const original = makePdf(REIWA);
  const editor = new PdfTextEditor(original);
  const [match] = await editor.searchText("令和");

  const verdict = await checkTextMatchReplacementWithFallback(editor, match.id, "平成", { font: fallback });
  assert.deepEqual(verdict, { allowed: true, mode: "single-run", usesFallbackFont: false });

  const result = await replaceTextMatchWithFallbackFont(editor, match.id, "平成", { font: fallback });
  assert.equal(result.usedFallbackFont, false);

  const saved = await editor.save();
  assert.ok(saved.length < original.length + 2000, `no font should have been embedded, but the file grew by ${saved.length - original.length} bytes`);
  assert.deepEqual((await new PdfTextEditor(saved).listTextRuns()).map((run) => run.text), ["平成"]);
});

test("embeds the font once however many runs are replaced through it", { skip }, async () => {
  const content = `BT /FJP 36 Tf 20 60 Td ${glyphs("令和")} Tj ET BT /FJP 36 Tf 190 60 Td ${glyphs("令和")} Tj ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2);

  const first = await replaceTextMatchWithFallbackFont(editor, matches[0].id, "昭和", { font: fallback });
  const second = await replaceTextMatchWithFallbackFont(editor, matches[1].id, "昭和", { font: fallback });
  assert.deepEqual(first.fontObjectNumbers, second.fontObjectNumbers, "the second replacement must reuse the embedded font");

  const saved = await editor.save();
  assert.deepEqual((await new PdfTextEditor(saved).listTextRuns()).map((run) => run.text), ["昭和", "昭和"]);
  // One copy of a 4.5 MB font, not two.
  assert.ok(saved.length < 4_000_000, `the font looks embedded twice: ${saved.length} bytes`);
});

/* ------------------------------------------------------ refused rather than guessed */

test("refuses what this experiment deliberately does not cover", { skip }, async () => {
  const cases = [
    // Only part of a run: would need the run's other characters re-encoded too.
    [`BT /FJP 36 Tf 20 60 Td ${glyphs("令和です")} Tj ET`, "令和", "昭和", "FALLBACK_PARTIAL_RUN_UNSUPPORTED"],
    // Several runs: each would need its own switch, and the spacing between them decided.
    [`BT /FJP 36 Tf 20 60 Td [${glyphs("令")} 0 ${glyphs("和")}] TJ ET`, "令和", "昭和", "FALLBACK_MULTI_RUN_UNSUPPORTED"],
    // A different character count: needs the layout work this experiment is isolating.
    [REIWA, "令和", "昭和です", "FALLBACK_LENGTH_CHANGE_UNSUPPORTED"]
  ];
  for (const [content, query, replacement, code] of cases) {
    const editor = new PdfTextEditor(makePdf(content));
    const [match] = await editor.searchText(query);
    const verdict = await checkTextMatchReplacementWithFallback(editor, match.id, replacement, { font: fallback });
    assert.equal(verdict.allowed, false, `${code} should have been refused`);
    assert.equal(verdict.code, code);
    await assert.rejects(replaceTextMatchWithFallbackFont(editor, match.id, replacement, { font: fallback }), (error) => {
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(editor.pendingObjects.size, 0, "a refusal must not embed a font");
  }
});

test("refuses a character even the fallback font does not have", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  // U+E000 is a private-use code point: absent from the document's font and from any
  // general-purpose font. Paired with a character the fallback font does have, so what
  // is reported is the missing glyph rather than the character count.
  const verdict = await checkTextMatchReplacementWithFallback(editor, match.id, "和", { font: fallback });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "FALLBACK_FONT_MISSING_GLYPH");
  assert.equal(editor.pendingObjects.size, 0);
});

test("leaves the engine's own API refusing exactly as it did", { skip }, async () => {
  // The experiment must not change what the shipped API does, however it is called.
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  await assert.rejects(editor.replaceTextMatch(match.id, "昭和"), (error) => {
    assert.equal(error.code, "FONT_ENCODING_UNSUPPORTED");
    return true;
  });
  assert.equal(editor.pendingObjects.size, 0);
  assert.deepEqual(await editor.save(), makePdf(REIWA));
});
