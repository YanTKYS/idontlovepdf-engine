// Writing characters the document's own fonts have no code for, by embedding one that
// does (PdfTextEditor#setFallbackFont).
//
// A PDF's embedded fonts are normally subsetted to the characters the document actually
// used, so its /ToUnicode lists only those -- which is why 令和 -> 平成 works in a document
// containing 平 and 成, and 令和 -> しょうわ does not in one that never contained し. These
// tests cover both halves: the document's own font is still tried first and still wins
// where it can, and the fallback is reached only for what it cannot write.
//
// The font is a test fixture fetched by `npm run test:font`; without it these skip.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";
import { TEST_FONT, readTestFont } from "../scripts/fetch-test-font.js";

const fontBytes = readTestFont();
const skip = fontBytes ? false : `${TEST_FONT.name} is not present -- run \`npm run test:font\` to fetch it`;

const encode = (value) => new TextEncoder().encode(value);
const latin1 = new TextDecoder("latin1");

/** The document's own font knows these characters and no others. */
const CODES = new Map([
  ["令", "0001"], ["和", "0002"], ["申", "0003"], ["請", "0004"],
  ["は", "0005"], ["で", "0006"], ["す", "0007"], ["平", "0008"], ["成", "0009"]
]);
const UNICODE = new Map([
  ["0001", "4EE4"], ["0002", "548C"], ["0003", "7533"], ["0004", "8ACB"], ["0005", "306F"],
  ["0006", "3067"], ["0007", "3059"], ["0008", "5E73"], ["0009", "6210"]
]);
const glyphs = (text) => `<${[...text].map((character) => CODES.get(character)).join("")}>`;

function streamObject(number, content) {
  const stream = encode(content);
  return new Uint8Array([
    ...encode(`${number} 0 obj\n<< /Length ${stream.length} >>\nstream\n`),
    ...stream,
    ...encode("\nendstream\nendobj\n")
  ]);
}

function buildPdf(objects) {
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

const CMAP = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n${UNICODE.size} beginbfchar\n`
  + [...UNICODE].map(([code, unicode]) => `<${code}> <${unicode}>`).join("\n")
  + `\nendbfchar\nendcmap\nend end`;

function makePdf(content, { resources = "<< /Font << /FJP 5 0 R >> >>" } = {}) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R /Resources ${resources} >>\nendobj\n`),
    streamObject(4, content),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP)
  ]);
}

const body = (operators) => `BT /FJP 36 Tf 20 60 Td ${operators} ET`;
const REIWA = body(`${glyphs("令和")} Tj`);

/** An editor with the fallback font set, on a document built from `content`. */
async function editorFor(content, options) {
  const editor = new PdfTextEditor(makePdf(content, options));
  await editor.setFallbackFont(fontBytes);
  return editor;
}

/** search -> check -> replace -> save -> reopen, returning what the reopened file holds. */
async function replaceAndReopen(editor, query, replacement, expectedMode) {
  const [match] = await editor.searchText(query);
  assert.ok(match, `the fixture must contain ${query}`);
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, replacement), { allowed: true, mode: expectedMode });
  await editor.replaceTextMatch(match.id, replacement);
  const saved = await editor.save();
  const reopened = new PdfTextEditor(saved);
  return { saved, reopened, runs: (await reopened.listTextRuns()).map((run) => run.text) };
}

/* ------------------------------------------------- the document's own font comes first */

test("uses the document's own font whenever it can, and embeds nothing", { skip }, async () => {
  const original = makePdf(REIWA);
  const editor = await editorFor(REIWA);
  const { saved, runs } = await replaceAndReopen(editor, "令和", "平成", "single-run");
  assert.deepEqual(runs, ["平成"]);
  // 平 and 成 are both in the document's font, so no font was embedded for them.
  assert.ok(saved.length < original.length + 2000, `nothing should have been embedded, but the file grew by ${saved.length - original.length} bytes`);
});

test("behaves exactly as before when no fallback font is set", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  const refused = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "FONT_ENCODING_UNSUPPORTED");
  await assert.rejects(editor.replaceTextMatch(match.id, "しょうわ"), (error) => {
    assert.equal(error.code, "FONT_ENCODING_UNSUPPORTED");
    return true;
  });
  assert.equal(editor.pendingObjects.size, 0);
  assert.deepEqual(await editor.save(), makePdf(REIWA));
});

test("names the characters the document cannot write, so a caller need not read messages", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  const [match] = await editor.searchText("令和");
  const refused = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.deepEqual(refused.characters, ["し", "ょ", "う", "わ"]);
});

/* ------------------------------------------- whole run, however the length changes */

test("writes a longer replacement the document's font cannot express", { skip }, async () => {
  // The case this version exists for: 令和 -> しょうわ, two characters becoming four, none
  // of which the document ever contained.
  const editor = await editorFor(REIWA);
  const { reopened, runs } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font");
  assert.deepEqual(runs, ["しょうわ"]);
  assert.equal((await reopened.searchText("しょうわ")).length, 1, "the replacement must be searchable as Unicode");
  assert.deepEqual(await reopened.searchText("令和"), []);
});

test("writes a shorter replacement, and one of the same length", { skip }, async () => {
  for (const [replacement, expected] of [["しょうわ", ["しょうわ"]], ["昭和", ["昭和"]], ["昭", ["昭"]]]) {
    const editor = await editorFor(REIWA);
    const { reopened, runs } = await replaceAndReopen(editor, "令和", replacement, "fallback-font");
    assert.deepEqual(runs, expected);
    assert.equal((await reopened.searchText(replacement)).length, 1);
  }
});

test("counts characters as code points, including outside the BMP", { skip }, async () => {
  // U+20B9F is one code point and two UTF-16 units; the font has it.
  const editor = await editorFor(REIWA);
  const { reopened, runs } = await replaceAndReopen(editor, "令和", "\u{20b9f}和", "fallback-font");
  assert.deepEqual(runs, ["\u{20b9f}和"]);
  assert.equal((await reopened.searchText("\u{20b9f}和")).length, 1);
});

test("refuses a character the fallback font does not have either", { skip }, async () => {
  const editor = await editorFor(REIWA);
  const [match] = await editor.searchText("令和");
  // U+20BB7 is a real CJK code point that this font happens not to cover; U+E000 is
  // private-use and no general-purpose font covers it.
  for (const replacement of ["\u{20bb7}和", "\u{e000}和"]) {
    const refused = await editor.checkTextMatchReplacement(match.id, replacement);
    assert.equal(refused.allowed, false);
    assert.equal(refused.code, "FALLBACK_FONT_MISSING_GLYPH");
    assert.deepEqual(refused.characters, [[...replacement][0]]);
  }
  assert.equal(editor.pendingObjects.size, 0);
});

/* ---------------------------------------------------------------- position safety */

test("replaces where nothing is drawn from the run's end, and refuses where something is", { skip }, async () => {
  const cases = [
    [body(`${glyphs("令和")} Tj`), "fallback-font"],
    [body(`${glyphs("令和")} Tj 200 0 Td ${glyphs("です")} Tj`), "fallback-font"],
    [`BT /FJP 36 Tf 20 60 Td ${glyphs("令和")} Tj ET BT /FJP 36 Tf 20 20 Td ${glyphs("です")} Tj ET`, "fallback-font"],
    // Drawn from where 令和 ends: the replacement's width is not the original's, so です
    // would move. Same character count would move it too -- the font differs.
    [body(`${glyphs("令和")} Tj ${glyphs("です")} Tj`), "FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE"],
    // A stream that ends inside an open text object: a later stream of the same page may
    // continue from here, which nothing in one stream can rule out.
    [`BT /FJP 36 Tf 20 60 Td ${glyphs("令和")} Tj`, "FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE"]
  ];
  for (const [content, expected] of cases) {
    const editor = await editorFor(content);
    const [match] = await editor.searchText("令和");
    const verdict = await editor.checkTextMatchReplacement(match.id, "しょうわ");
    assert.equal(verdict.allowed ? verdict.mode : verdict.code, expected, `for: ${content}`);
    if (!verdict.allowed) assert.equal(editor.pendingObjects.size, 0);
  }
});

/* ------------------------------------------------------------- part of a single run */

test("replaces part of a run, keeping the rest in the document's own font", { skip }, async () => {
  const editor = await editorFor(body(`${glyphs("申請は令和です")} Tj`));
  const { reopened, runs } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font-partial");

  // Three runs now: the prefix and suffix still in the document's font, the replacement
  // in the embedded one. です follows the replacement's own width, as editing text should.
  assert.deepEqual(runs, ["申請は", "しょうわ", "です"]);
  assert.equal((await reopened.searchText("しょうわ")).length, 1);
  await reopened.listTextRuns();
  assert.match(
    latin1.decode(reopened.streams[0].decoded),
    /^BT \/FJP 36 Tf 20 60 Td <[0-9a-f]+> Tj \/ILPFallback 36 Tf <[0-9a-f]+> Tj \/FJP 36 Tf <[0-9a-f]+> Tj ET$/
  );
});

test("handles a match at the very start or the very end of a run", { skip }, async () => {
  for (const [content, expected] of [
    [body(`${glyphs("令和です")} Tj`), ["しょうわ", "です"]],
    [body(`${glyphs("申請は令和")} Tj`), ["申請は", "しょうわ"]]
  ]) {
    const editor = await editorFor(content);
    const { runs } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font-partial");
    // No empty operator is emitted for the side that has no text.
    assert.deepEqual(runs, expected);
  }
});

test("keeps a partial replacement of the same length working too", { skip }, async () => {
  const editor = await editorFor(body(`${glyphs("申請は令和です")} Tj`));
  const { runs } = await replaceAndReopen(editor, "令和", "昭和", "fallback-font-partial");
  assert.deepEqual(runs, ["申請は", "昭和", "です"]);
});

/* ------------------------------------------------------------------- several runs */

test("replaces a match split across several runs", { skip }, async () => {
  const editor = await editorFor(body(`${glyphs("令")} Tj ${glyphs("和")} Tj`));
  const { reopened, runs } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font-multi-run");
  // Drawn where the match began; the run it no longer needs is left as an empty operand
  // rather than the stream being rebuilt around its removal.
  assert.deepEqual(runs, ["しょうわ", ""]);
  assert.equal((await reopened.searchText("しょうわ")).length, 1);
});

test("keeps the prefix and suffix of a multi-run match", { skip }, async () => {
  const editor = await editorFor(body(`${glyphs("申請は令")} Tj ${glyphs("和です")} Tj`));
  const { runs } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font-multi-run");
  assert.deepEqual(runs, ["申請は", "しょうわ", "です"]);
});

test("refuses a multi-run match whose runs are not simply adjacent", { skip }, async () => {
  // The same boundaries v0.3.0 refuses a length change across: redrawing the pieces as one
  // would draw them under state they were not drawn under.
  for (const operators of [
    `${glyphs("令")} Tj 5 Tc ${glyphs("和")} Tj`,
    `${glyphs("令")} Tj 1 0 0 rg ${glyphs("和")} Tj`,
    `${glyphs("令")} Tj /Span BMC ${glyphs("和")} Tj EMC`
  ]) {
    const editor = await editorFor(body(operators));
    const [match] = await editor.searchText("令和");
    const refused = await editor.checkTextMatchReplacement(match.id, "しょうわ");
    assert.equal(refused.allowed, false);
    assert.match(refused.code, /FALLBACK_MULTI_RUN_UNSUPPORTED|MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED/);
    assert.equal(editor.pendingObjects.size, 0);
  }
});

test("finds and replaces every occurrence separately", { skip }, async () => {
  const editor = await editorFor(`BT /FJP 36 Tf 20 60 Td ${glyphs("令和")} Tj ET BT /FJP 36 Tf 20 20 Td ${glyphs("令和")} Tj ET`);
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2);
  await editor.replaceTextMatch(matches[1].id, "しょうわ");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["令和", "しょうわ"]);
});

/* -------------------------------------------------------------- operators and limits */

test("refuses every text-showing operator but Tj", { skip }, async () => {
  for (const [operators, operator] of [
    [`[${glyphs("令和")}] TJ`, "TJ"],
    [`14 TL ${glyphs("令和")} '`, "'"],
    [`14 TL 0 0 ${glyphs("令和")} "`, '"']
  ]) {
    const editor = await editorFor(body(operators));
    const [match] = await editor.searchText("令和");
    const refused = await editor.checkTextMatchReplacement(match.id, "しょうわ");
    assert.equal(refused.allowed, false, `${operator} should have been refused`);
    assert.equal(refused.code, "FALLBACK_OPERATOR_UNSUPPORTED");
    assert.equal(editor.pendingObjects.size, 0);
  }
});

/* ------------------------------------------------------------------ what is embedded */

test("embeds one font however many replacements use it, across pages", { skip }, async () => {
  // Two pages, each with its own /Resources, sharing one content stream shape.
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, REIWA),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    encode("7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 8 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(8, REIWA)
  ]);
  const editor = new PdfTextEditor(pdf);
  await editor.setFallbackFont(fontBytes);
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2, "one match per page");
  await editor.replaceTextMatch(matches[0].id, "しょうわ");
  await editor.replaceTextMatch(matches[1].id, "しょうわ");

  const saved = await editor.save();
  // One copy of a 4.5 MB font, not two -- and both pages can reach it.
  assert.ok(saved.length < pdf.length + 4_000_000, `the font looks embedded more than once: ${saved.length} bytes`);
  const reopened = new PdfTextEditor(saved);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょうわ", "しょうわ"]);
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g).length, 1, "the font program must be written once");
});

test("picks a resource name the page is not already using", { skip }, async () => {
  const editor = await editorFor(REIWA, { resources: "<< /Font << /FJP 5 0 R /ILPFallback 5 0 R >> >>" });
  await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font");
  assert.match(latin1.decode(await editor.save()), /\/ILPFallback 5 0 R \/ILPFallback1 \d+ 0 R/);
});

test("writes font objects a reader can resolve, and saves incrementally", { skip }, async () => {
  const original = makePdf(REIWA);
  const editor = await editorFor(REIWA);
  const { saved, reopened } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font");
  await reopened.listTextRuns();
  const text = latin1.decode(saved);

  assert.match(text, /\/Subtype \/Type0 .*\/Encoding \/Identity-H/);
  assert.match(text, /\/Subtype \/CIDFontType2/);
  assert.match(text, /\/CIDToGIDMap \/Identity/);
  assert.match(text, new RegExp(`/Length1 ${fontBytes.length}\\b`));
  assert.match(text, /\/DW 1000 \/W \[\d+ \[\d+\]/);
  // The original bytes are still the head of the file: this is an incremental update.
  assert.deepEqual(saved.subarray(0, original.length), original);
  assert.match(text, /\/Prev \d+/);
});

test("refuses bytes that are not a TrueType font", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf(REIWA));
  await assert.rejects(editor.setFallbackFont(encode("not a font at all")), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_INVALID");
    return true;
  });
});

/* ------------------------------------------------------- the rest of the API is intact */

test("keeps stale matches, unknown matches and /P permissions refusing", { skip }, async () => {
  const editor = await editorFor(REIWA);
  const [match] = await editor.searchText("令和");
  await editor.replaceText("4:0", "平成");
  const stale = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.equal(stale.code, "MATCH_STALE");
  await assert.rejects(editor.replaceTextMatch(match.id, "しょうわ"), (error) => {
    assert.equal(error.code, "MATCH_STALE");
    return true;
  });

  await editor.searchText("平成");
  const superseded = await editor.checkTextMatchReplacement(match.id, "しょうわ");
  assert.equal(superseded.code, "UNKNOWN_MATCH");
});

test("leaves an editor untouched when a replacement is refused", { skip }, async () => {
  const original = makePdf(body(`${glyphs("令和")} Tj ${glyphs("です")} Tj`));
  const editor = await editorFor(body(`${glyphs("令和")} Tj ${glyphs("です")} Tj`));
  const [match] = await editor.searchText("令和");
  await assert.rejects(editor.replaceTextMatch(match.id, "しょうわ"));
  assert.equal(editor.pending.size, 0);
  assert.equal(editor.pendingObjects.size, 0);
  assert.equal(editor.pendingStreams.size, 0);
  assert.deepEqual(await editor.save(), original);
});
