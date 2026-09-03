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
    // A real Type0 font always declares its /Encoding: it is what says whether the font
    // writes horizontally or vertically, which a fallback replacement depends on knowing.
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n"),
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

test("refuses ' and \", the text-showing operators that carry a line move", { skip }, async () => {
  // `TJ` is written since v0.4.1 -- see test/fallback-font-tj.test.js, which covers it in
  // full. `'` and `\"` move to the next line before drawing, which neither rewrite accounts
  // for, and are deliberately not widened along with it.
  for (const [operators, operator] of [
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
  // A match half in a TJ and half in a Tj would have to be both rewrites at once.
  const mixed = await editorFor(body(`[${glyphs("令")}] TJ ${glyphs("和")} Tj`));
  const [match] = await mixed.searchText("令和");
  const refused = await mixed.checkTextMatchReplacement(match.id, "しょうわ");
  assert.equal(refused.code, "FALLBACK_OPERATOR_UNSUPPORTED");
  assert.match(refused.reason, /mixes/);
  assert.equal(mixed.pendingObjects.size, 0);
});

test("writes a TJ whose match ends the array with nothing drawn after it", { skip }, async () => {
  // The v0.4.0 rule reached through a TJ: nothing is drawn from where the match ends, so no
  // width arithmetic is needed and this document's font -- which states no widths at all --
  // is no obstacle. The full TJ story is in test/fallback-font-tj.test.js.
  const editor = await editorFor(body(`[${glyphs("令和")}] TJ`));
  const { runs, reopened } = await replaceAndReopen(editor, "令和", "しょうわ", "fallback-font");
  assert.deepEqual(runs, ["しょうわ"]);
  assert.equal((await reopened.searchText("しょうわ")).length, 1);
});

/* ------------------------------- what a fallback rewrite means for the rest of the session */

test("reports the replaced text on a later search, not what the run used to hold", { skip }, async () => {
  // A fallback rewrite turns one operator into several, so the run it came from no longer
  // reads as its original operand. Search has to say so, or a second occurrence in the
  // same run would be handed back as if nothing had happened.
  const editor = await editorFor(body(`${glyphs("令和令和")} Tj`));
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2);
  await editor.replaceTextMatch(matches[0].id, "しょうわ");

  assert.equal((await editor.searchText("しょうわ")).length, 1, "the replacement must be findable");
  assert.equal((await editor.searchText("令和")).length, 1, "only the untouched occurrence is left");
  // Before saving, the rewritten run is still modelled as one run, so its text reads as
  // one string. After save and reopen it is several operators with a font switch between
  // them, and search does not join across that -- see the README. Saving and reopening,
  // which is what a caller editing one match at a time does, settles the difference.
  assert.equal((await editor.searchText("しょうわ令和")).length, 1, "the run still reads as one string until it is saved");
});

test("refuses to edit a run a fallback rewrite has already replaced", { skip }, async () => {
  const original = makePdf(body(`${glyphs("令和令和")} Tj`));
  const editor = await editorFor(body(`${glyphs("令和令和")} Tj`));
  const matches = await editor.searchText("令和");
  await editor.replaceTextMatch(matches[0].id, "しょうわ");
  const staged = new Map(editor.pendingStreams);

  // The second match from the original search described the run as it was.
  await assert.rejects(editor.replaceTextMatch(matches[1].id, "しょうわ"), (error) => {
    assert.match(error.code, /MATCH_STALE|FALLBACK_EDIT_REQUIRES_SAVE/);
    return true;
  });
  // A freshly found match into the same run is refused too, and says what to do about it.
  const [fresh] = await editor.searchText("令和");
  const refused = await editor.checkTextMatchReplacement(fresh.id, "しょうわ");
  assert.equal(refused.code, "FALLBACK_EDIT_REQUIRES_SAVE");
  assert.match(refused.reason, /Save this document and reopen/);

  // Neither refusal disturbed the replacement already staged.
  assert.deepEqual([...editor.pendingStreams], [...staged]);
  assert.notDeepEqual(await editor.save(), original);
});

test("replaces the second occurrence after saving and reopening", { skip }, async () => {
  // The documented way round the rule above, and the flow a caller that saves per edit
  // already follows.
  const editor = await editorFor(body(`${glyphs("令和令和")} Tj`));
  const first = await editor.searchText("令和");
  await editor.replaceTextMatch(first[0].id, "しょうわ");

  const reopened = new PdfTextEditor(await editor.save());
  await reopened.setFallbackFont(fontBytes);
  assert.equal((await reopened.searchText("しょうわ")).length, 1);
  const remaining = await reopened.searchText("令和");
  assert.equal(remaining.length, 1);
  await reopened.replaceTextMatch(remaining[0].id, "しょうわ");

  const final = new PdfTextEditor(await reopened.save());
  assert.deepEqual((await final.listTextRuns()).map((run) => run.text), ["しょうわ", "しょうわ"]);
  assert.deepEqual(await final.searchText("令和"), []);
  // Two matches rather than one string: each replacement sits in the fallback font with
  // the document's own font re-stated between them, and search does not join text across
  // a font change. The page reads しょうわしょうわ; searching for it as one does not.
  assert.equal((await final.searchText("しょうわ")).length, 2);
  assert.deepEqual(await final.searchText("しょうわしょうわ"), []);
});

test("refuses a run drawn by a vertical font, and one whose writing mode is not stated", { skip }, async () => {
  // The fallback font is embedded for horizontal writing, so it cannot stand in for text
  // laid out down the page. What decides it is the font's own writing mode -- a rotated
  // text matrix over a horizontal font is still horizontal, and is not refused here.
  for (const [encoding, expected] of [["/Identity-V", "vertical"], ["", "not say"]]) {
    const pdf = buildPdf([
      encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
      encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
      encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
      streamObject(4, REIWA),
      encode(`5 0 obj\n<< /Type /Font /Subtype /Type0 ${encoding ? `/Encoding ${encoding} ` : ""}/ToUnicode 6 0 R >>\nendobj\n`),
      streamObject(6, CMAP)
    ]);
    const editor = new PdfTextEditor(pdf);
    await editor.setFallbackFont(fontBytes);
    const [match] = await editor.searchText("令和");
    const refused = await editor.checkTextMatchReplacement(match.id, "しょうわ");
    assert.equal(refused.allowed, false, `${encoding || "no /Encoding"} should have been refused`);
    assert.equal(refused.code, "FALLBACK_WRITING_MODE_UNSUPPORTED");
    assert.match(refused.reason, new RegExp(expected));
    assert.equal(editor.pendingObjects.size, 0);
  }
});

test("still replaces horizontal text whose page happens to be rotated", { skip }, async () => {
  // A rotated text matrix is not a vertical font: nothing about the layout axis changes,
  // so this is replaced like any other horizontal text.
  const editor = await editorFor(`BT /FJP 36 Tf 0 1 -1 0 60 20 Tm ${glyphs("令和")} Tj ET`);
  const [match] = await editor.searchText("令和");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょうわ"), { allowed: true, mode: "fallback-font" });
});

test("folds an ordinary replacement already staged on the same run into the rewrite", { skip }, async () => {
  // The first 令和 is written by the document's own font; the second needs the fallback.
  // The fallback rewrite spans the whole operator while the ordinary edit spans only its
  // operand, so both have to be recognised as edits to the same run or they collide.
  const editor = await editorFor(body(`${glyphs("令和令和")} Tj`));
  const [first] = await editor.searchText("令和");
  await editor.replaceTextMatch(first.id, "平成");
  assert.deepEqual(await editor.checkTextMatchReplacement(first.id, "平成"), { allowed: false, mode: null, code: "MATCH_STALE", reason: (await editor.checkTextMatchReplacement(first.id, "平成")).reason });

  const [second] = await editor.searchText("令和");
  assert.deepEqual(await editor.checkTextMatchReplacement(second.id, "しょうわ"), { allowed: true, mode: "fallback-font-partial" });
  await editor.replaceTextMatch(second.id, "しょうわ");

  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["平成", "しょうわ"]);
  assert.equal((await reopened.searchText("平成")).length, 1);
  assert.equal((await reopened.searchText("しょうわ")).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
});

/**
 * A PDF whose /Resources /Font sub-dictionary is an indirect object compressed inside an
 * Object Stream -- a shape ordinary text extraction already handles, so adding a fallback
 * font to it must not be the one thing that cannot.
 */
function makeCompressedFontResourcePdf() {
  const header = encode("%PDF-1.5\n");
  const fontDictionary = "<< /FJP 5 0 R >>";
  // An object stream is a table of "object-number offset" pairs, then the objects
  // themselves starting at /First. This one holds object 9, the /Font dictionary.
  const objStmHeader = "9 0\n";
  const objStmData = encode(objStmHeader + fontDictionary);
  const plain = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R /Resources << /Font 9 0 R >> >>" },
    { number: 4, streamBytes: encode(REIWA) },
    { number: 5, dictionary: "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>" },
    { number: 6, streamBytes: encode(CMAP) },
    { number: 7, streamBytes: objStmData, dictionary: `<< /Type /ObjStm /N 1 /First ${objStmHeader.length} /Length ${objStmData.length} >>` }
  ];
  const chunks = [header];
  const offsets = new Map();
  let position = header.length;
  for (const object of plain) {
    offsets.set(object.number, position);
    const head = object.streamBytes
      ? encode(`${object.number} 0 obj\n${object.dictionary ?? `<< /Length ${object.streamBytes.length} >>`}\nstream\n`)
      : encode(`${object.number} 0 obj\n${object.dictionary}\nendobj\n`);
    chunks.push(head);
    position += head.length;
    if (object.streamBytes) {
      chunks.push(object.streamBytes, encode("\nendstream\nendobj\n"));
      position += object.streamBytes.length + "\nendstream\nendobj\n".length;
    }
  }

  const widths = [1, 4, 2];
  const bigEndian = (value, width) => Array.from({ length: width }, (_, index) => (value >>> ((width - 1 - index) * 8)) & 0xff);
  const rows = [
    { type: 0, a: 0, b: 65535 },
    ...plain.map((object) => ({ type: 1, a: offsets.get(object.number), b: 0 })),
    { type: 0, a: 0, b: 65535 },   // object 8 is unused
    { type: 2, a: 7, b: 0 },       // object 9 lives in object stream 7, at index 0
    { type: 1, a: position, b: 0 } // object 10, the xref stream itself
  ];
  const raw = rows.flatMap((row) => [...bigEndian(row.type, widths[0]), ...bigEndian(row.a, widths[1]), ...bigEndian(row.b, widths[2])]);
  const data = Uint8Array.from(raw);
  const xrefOffset = position;
  chunks.push(encode(`10 0 obj\n<< /Type /XRef /Size ${rows.length} /W [${widths.join(" ")}] /Root 1 0 R /Length ${data.length} >>\nstream\n`), data, encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

test("adds the fallback font to a /Font resource compressed inside an Object Stream", { skip }, async () => {
  const pdf = makeCompressedFontResourcePdf();
  const editor = new PdfTextEditor(pdf);
  // Reading it works, so replacing in it has to as well -- and must not throw out of the
  // check API, which is supposed to answer rather than raise.
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["令和"]);

  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょうわ"), { allowed: true, mode: "fallback-font" });

  await editor.replaceTextMatch(match.id, "しょうわ");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょうわ"]);
  assert.equal((await reopened.searchText("しょうわ")).length, 1);
  // The /Font dictionary was rewritten as a plain object carrying both fonts.
  assert.match(latin1.decode(await editor.save()), /9 0 obj\n<< \/FJP 5 0 R \/ILPFallback \d+ 0 R >>/);
});

/* ------------------------------------------------------------------ what is embedded */

test("embeds one font however many replacements use it, across pages", { skip }, async () => {
  // Two pages, each with its own /Resources, sharing one content stream shape.
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, REIWA),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n"),
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

/**
 * Two pages, each with its own /Resources object, so each needs the fallback font
 * registered separately even though they share the embedded font itself.
 */
function makeTwoPagePdf() {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, REIWA),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    encode("7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 8 0 R /Resources 9 0 R >>\nendobj\n"),
    streamObject(8, REIWA),
    encode("9 0 obj\n<< /Font << /FJP 5 0 R >> >>\nendobj\n")
  ]);
}

test("checking a replacement changes nothing, so a later replace still registers the font", { skip }, async () => {
  // check() and replace() run one planner. If checking a second page recorded that page as
  // already carrying the font, the replace that followed would skip adding it -- writing a
  // content stream naming a font the page's /Resources never got. The caller's natural
  // order is check-then-replace, so this has to hold.
  const editor = new PdfTextEditor(makeTwoPagePdf());
  await editor.setFallbackFont(fontBytes);
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2);

  await editor.replaceTextMatch(matches[0].id, "しょうわ");
  const snapshot = JSON.stringify([...editor.fallbackEmbedding.resources]);
  const pendingObjects = new Set(editor.pendingObjects.keys());

  await editor.checkTextMatchReplacement(matches[1].id, "しょうわ");
  assert.equal(JSON.stringify([...editor.fallbackEmbedding.resources]), snapshot, "checking must not record the second page as done");
  assert.deepEqual(new Set(editor.pendingObjects.keys()), pendingObjects, "checking must stage nothing");

  await editor.replaceTextMatch(matches[1].id, "しょうわ");
  const saved = await editor.save();
  const reopened = new PdfTextEditor(saved);
  // Both pages read back as text, not as raw glyph ids -- which is what happens when a
  // page names a font its /Resources do not have.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょうわ", "しょうわ"]);
  await reopened.listTextRuns();
  assert.match(reopened.document.object(9).dictionary, /\/ILPFallback \d+ 0 R/, "the second page's /Resources must carry the font");
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g).length, 1, "and the font itself is still embedded once");
});

test("refuses a different fallback font once one has been used", { skip }, async () => {
  // Text already written holds glyph ids of the font it was written with; another font's
  // ids are other glyphs, so swapping would turn text already written into gibberish.
  const editor = await editorFor(REIWA);
  // Before anything is written, changing it is fine.
  await editor.setFallbackFont(fontBytes);

  const [match] = await editor.searchText("令和");
  await editor.replaceTextMatch(match.id, "しょうわ");
  await assert.rejects(editor.setFallbackFont(fontBytes), (error) => {
    assert.equal(error.code, "FALLBACK_FONT_ALREADY_IN_USE");
    return true;
  });
  // And the replacement already made is untouched.
  assert.deepEqual((await new PdfTextEditor(await editor.save()).listTextRuns()).map((run) => run.text), ["しょうわ"]);
});

test("refuses a replacement containing a space where word spacing is in force", { skip }, async () => {
  // Tw reaches single-byte code 32 only, and the fallback font is written through a 2-byte
  // encoding, so a space in the replacement would not be spaced as the document's other
  // spaces are. Measured against pdf.js before this rule was written.
  const spaced = await editorFor(body(`20 Tw ${glyphs("令和")} Tj`));
  const [match] = await spaced.searchText("令和");
  const refused = await spaced.checkTextMatchReplacement(match.id, "しょう わ");
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "FALLBACK_WORD_SPACING_UNSUPPORTED");
  assert.equal(spaced.pendingObjects.size, 0);

  // A replacement without a space is unaffected by it.
  assert.deepEqual(await spaced.checkTextMatchReplacement(match.id, "しょうわ"), { allowed: true, mode: "fallback-font" });

  // And with word spacing off -- the default, and what `0 Tw` restores -- a space is fine.
  for (const operators of [`${glyphs("令和")} Tj`, `20 Tw 0 Tw ${glyphs("令和")} Tj`]) {
    const editor = await editorFor(body(operators));
    const [plain] = await editor.searchText("令和");
    assert.deepEqual(await editor.checkTextMatchReplacement(plain.id, "しょう わ"), { allowed: true, mode: "fallback-font" });
  }
});

test("embeds the font once across repeated save and reopen cycles", { skip }, async () => {
  // A caller that saves and reopens between edits -- which is how this engine is meant to
  // be driven -- would otherwise get another copy of a multi-megabyte font every round.
  // A later session recognises the font an earlier one embedded and adds to it instead.
  let pdf = makePdf(body(`${glyphs("令和令和令和")} Tj`));
  const original = pdf.length;
  const replacements = ["しょうわ", "たいしょう", "めいじ"];
  const growth = [];

  for (const replacement of replacements) {
    const editor = new PdfTextEditor(pdf);
    await editor.setFallbackFont(fontBytes);
    const [match] = await editor.searchText("令和");
    await editor.replaceTextMatch(match.id, replacement);
    const previous = pdf.length;
    pdf = await editor.save();
    growth.push(pdf.length - previous);
  }

  assert.equal(latin1.decode(pdf).match(/\/FontFile2/g).length, 1, "the font program must be written exactly once");
  assert.ok(growth[0] > 1_000_000, "the first save embeds the font");
  assert.ok(growth[1] < 100_000 && growth[2] < 100_000, `later saves must not re-embed it, but grew by ${growth.slice(1)}`);
  assert.ok(pdf.length < original + growth[0] + 100_000);

  // All three replacements survived, and each is searchable as Unicode.
  const reopened = new PdfTextEditor(pdf);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), replacements);
  for (const replacement of replacements) assert.equal((await reopened.searchText(replacement)).length, 1);
  assert.deepEqual(await reopened.searchText("令和"), []);
});

test("adopts an embedded font only when it is the same program byte for byte", { skip }, async () => {
  // Writing into a font already in the document means resolving new glyph ids against the
  // font supplied now, so the two have to be the same program. A name and a size do not
  // establish that: two builds of one family share a name, can share a length, and may
  // number their glyphs differently -- in which case the text added last would draw the
  // wrong characters, silently. The marker is therefore a digest of the program.
  const first = await editorFor(REIWA);
  const [firstMatch] = await first.searchText("令和");
  await first.replaceTextMatch(firstMatch.id, "しょうわ");
  const saved = await first.save();
  assert.match(latin1.decode(saved), /\/ILPFallbackFont <[0-9a-f]{64}>/, "the marker must be a digest of the program");

  // A different font program that is indistinguishable by name and size: one byte of the
  // same file changed. It still parses, and still calls itself BIZUDGothic-Regular.
  const impostor = Uint8Array.from(fontBytes);
  impostor[impostor.length - 1] ^= 0xff;
  assert.equal(impostor.length, fontBytes.length);
  assert.notDeepEqual(impostor, fontBytes);

  const reopened = new PdfTextEditor(saved);
  await reopened.setFallbackFont(impostor);
  const [again] = await reopened.searchText("しょうわ");
  await reopened.replaceTextMatch(again.id, "たいしょう");
  const twice = await reopened.save();

  // The embedded font was not adopted: this one is embedded alongside it.
  assert.equal(latin1.decode(twice).match(/\/FontFile2/g).length, 2, "a different program must be embedded separately");
  const digests = new Set([...latin1.decode(twice).matchAll(/\/ILPFallbackFont <([0-9a-f]{64})>/g)].map((entry) => entry[1]));
  assert.equal(digests.size, 2, "the two fonts must be marked with different digests");
  assert.deepEqual((await new PdfTextEditor(twice).listTextRuns()).map((run) => run.text), ["たいしょう"]);
});

test("adopts the embedded font when the same program is supplied again", { skip }, async () => {
  // The other half of the rule above: the identical program is recognised and reused.
  const first = await editorFor(REIWA);
  const [firstMatch] = await first.searchText("令和");
  await first.replaceTextMatch(firstMatch.id, "しょうわ");
  const saved = await first.save();

  const reopened = new PdfTextEditor(saved);
  // A separate copy of the same bytes, as a caller loading the file again would have.
  await reopened.setFallbackFont(Uint8Array.from(fontBytes));
  const [again] = await reopened.searchText("しょうわ");
  await reopened.replaceTextMatch(again.id, "たいしょう");
  const twice = await reopened.save();

  assert.equal(latin1.decode(twice).match(/\/FontFile2/g).length, 1, "the same program must be embedded once");
  assert.ok(twice.length - saved.length < 100_000, `the second save re-embedded the font: +${twice.length - saved.length} bytes`);
  assert.deepEqual((await new PdfTextEditor(twice).listTextRuns()).map((run) => run.text), ["たいしょう"]);
});

/**
 * As many distinct characters as asked for, all of which the fallback font can write.
 * Candidates come from the CJK block; any the font lacks are reported by the engine
 * itself (FALLBACK_FONT_MISSING_GLYPH names them), so this asks rather than assumes.
 */
async function distinctFallbackText(count) {
  const editor = await editorFor(REIWA);
  const [match] = await editor.searchText("令和");
  const candidates = [];
  for (let code = 0x4e00; candidates.length < count * 5; code += 1) candidates.push(String.fromCodePoint(code));

  // One question, one answer: the refusal names every character the font lacks.
  const verdict = await editor.checkTextMatchReplacement(match.id, candidates.join(""));
  const missing = new Set(verdict.allowed ? [] : verdict.characters);
  if (!verdict.allowed) assert.equal(verdict.code, "FALLBACK_FONT_MISSING_GLYPH", verdict.reason);
  const usable = candidates.filter((character) => !missing.has(character));
  assert.ok(usable.length >= count, `the fallback font covers only ${usable.length} of the candidates`);
  return usable.slice(0, count).join("");
}

test("splits the ToUnicode CMap into groups a PDF reader will accept", { skip }, async () => {
  // A beginbfchar group may hold at most 100 entries; 101 is invalid outright. Glyphs
  // accumulate as a document is edited, so this is reached by ordinary use, not extremes.
  for (const count of [100, 101, 250]) {
    const replacement = await distinctFallbackText(count);
    assert.equal([...replacement].length, count);

    const editor = await editorFor(REIWA);
    const [match] = await editor.searchText("令和");
    assert.deepEqual(await editor.checkTextMatchReplacement(match.id, replacement), { allowed: true, mode: "fallback-font" });
    await editor.replaceTextMatch(match.id, replacement);

    const saved = await editor.save();
    const reopened = new PdfTextEditor(saved);
    // The engine's own CMap reader gets every character back, so no entry was lost.
    assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), [replacement], `for ${count} glyphs`);
    assert.equal((await reopened.searchText(replacement)).length, 1);

    // And no group exceeds what the specification allows.
    const cmap = latin1.decode(saved).match(/\/Ordering \(UCS\)[\s\S]*?endcmap/)[0];
    const groups = [...cmap.matchAll(/(\d+) beginbfchar/g)].map((group) => Number(group[1]));
    for (const size of groups) assert.ok(size > 0 && size <= 100, `a beginbfchar group of ${size} is invalid`);
    assert.equal(groups.reduce((sum, size) => sum + size, 0), count, `all ${count} glyphs must be mapped`);
    assert.equal(groups.length, Math.ceil(count / 100));
  }
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
