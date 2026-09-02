// The high-level, caller-facing search/replace API: PdfTextEditor#searchText() and
// #replaceTextMatch(). What makes it necessary is that a PDF draws a word as whatever
// sequence of text-showing operands its producer felt like emitting, so the runs of
// listTextRuns() are pieces of words, not words -- see the first test below, which
// pins the v0.2.0 behaviour this API exists to fix.
//
// Fixtures here are built with a real /ToUnicode CMap and Japanese text, because that
// is the shape the problem was actually reported in; `glyphs()` keeps the content
// streams readable ("令和6年度" rather than a wall of character codes).
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

/** Character -> the code this fixture's font uses for it, mirrored by CMAP below. */
const CODES = new Map([
  ["令", "0001"], ["和", "0002"], ["6", "0003"], ["年", "0004"], ["度", "0005"],
  ["7", "0006"], ["申", "0007"], ["請", "0008"], ["は", "0009"], ["で", "000a"],
  ["す", "000b"], ["今", "000c"], ["か", "000d"], ["ら", "000e"], ["ま", "000f"],
  ["\u{1f600}", "0010"]
]);

const UNICODE = new Map([
  ["0001", "4ee4"], ["0002", "548c"], ["0003", "0036"], ["0004", "5e74"], ["0005", "5ea6"],
  ["0006", "0037"], ["0007", "7533"], ["0008", "8acb"], ["0009", "306f"], ["000a", "3067"],
  ["000b", "3059"], ["000c", "4eca"], ["000d", "304b"], ["000e", "3089"], ["000f", "307e"],
  // Outside the BMP: one Unicode code point, two UTF-16 code units. Nothing in the
  // engine may count it as two characters (see the surrogate-pair test at the end).
  ["0010", "d83dde00"]
]);

const CMAP = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n${UNICODE.size} beginbfchar\n`
  + [...UNICODE].map(([code, unicode]) => `<${code}> <${unicode}>`).join("\n")
  + `\nendbfchar\nendcmap\nend end`;

/** The hexadecimal string operand that draws `text` in this fixture's font. */
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
  const xref = offset;
  chunks.push(encode(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + `${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  ));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

/**
 * A one-page PDF whose page body is `content`, with two fonts (/FJP and /FALT) that
 * share the CMap above -- so a font switch changes the font name without changing what
 * any character encodes to, which is what the font-continuity tests need.
 */
function makePdf(content) {
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /FJP 5 0 R /FALT 7 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    encode("7 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n")
  ]);
}

/** `令和6年度` as five operands of one TJ array, spaced apart -- the reported structure. */
const SPLIT_TJ = `BT /FJP 12 Tf 72 700 Td [${glyphs("令")} 120 ${glyphs("和")} -20 ${glyphs("6")} 0 ${glyphs("年")} 0 ${glyphs("度")}] TJ ET`;

const texts = (matches) => matches.map((match) => match.text);

/* ------------------------------------------------- the problem this API exists to fix */

test("run-level search finds a single character but nothing longer when a word is split across runs", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const runs = await editor.listTextRuns();

  // The PDF shows one word; it is drawn as five separate string operands, so
  // listTextRuns() reports five runs of one character each.
  assert.deepEqual(runs.map((run) => run.text), ["令", "和", "6", "年", "度"]);

  // Searching those runs one by one -- what a caller on v0.2.0 could do -- therefore
  // finds "令" and can never find "令和", let alone the whole word. This is the bug.
  assert.equal(runs.filter((run) => run.text.includes("令")).length, 1);
  assert.equal(runs.filter((run) => run.text.includes("令和")).length, 0);
  assert.equal(runs.filter((run) => run.text.includes("令和6年度")).length, 0);

  // searchText() joins the runs the content stream says are consecutive, so the word
  // is one match -- as are any of its substrings, across the same run boundaries.
  assert.deepEqual(texts(await editor.searchText("令和6年度")), ["令和6年度"]);
  assert.deepEqual(texts(await editor.searchText("令和")), ["令和"]);
  assert.deepEqual(texts(await editor.searchText("和6")), ["和6"]);
  assert.equal((await editor.searchText("令和6年度"))[0].runCount, 5);
});

test("searches across consecutive Tj operators, not just within one TJ array", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj ${glyphs("和")} Tj ${glyphs("6")} Tj ${glyphs("年")} Tj ${glyphs("度")} Tj ET`;
  const editor = new PdfTextEditor(makePdf(content));
  assert.equal((await editor.listTextRuns()).length, 5);
  assert.deepEqual(texts(await editor.searchText("令和6年度")), ["令和6年度"]);
});

test("does not treat a TJ numeric adjustment as a break in the text", async () => {
  const editor = new PdfTextEditor(makePdf(`BT /FJP 12 Tf 72 700 Td [${glyphs("令")} 120 ${glyphs("和")}] TJ ET`));
  assert.deepEqual(texts(await editor.searchText("令和")), ["令和"]);
});

test("returns each occurrence of a repeated string as its own match", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td [${glyphs("令")} ${glyphs("和")} ${glyphs("令")} ${glyphs("和")}] TJ ET`;
  const matches = await new PdfTextEditor(makePdf(content)).searchText("令和");
  assert.deepEqual(texts(matches), ["令和", "令和"]);
  assert.equal(new Set(matches.map((match) => match.id)).size, 2, "match ids must be distinct");
});

test("hands back the surrounding text so repeated matches can be told apart", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td ${glyphs("令和6年度")} Tj ${glyphs("から")} Tj ${glyphs("令和6年度")} Tj ${glyphs("まで")} Tj ET`;
  const matches = await new PdfTextEditor(makePdf(content)).searchText("令和6年度");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].after, "から令和6年度まで");
  assert.equal(matches[1].before, "令和6年度から");
});

/* ------------------------------------------------------------ boundaries never crossed */

const boundaryCases = [
  ["a separate BT ... ET block", `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj ET BT /FJP 12 Tf 72 100 Td ${glyphs("和")} Tj ET`],
  ["Td", `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj 100 0 Td ${glyphs("和")} Tj ET`],
  ["TD", `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj 100 -14 TD ${glyphs("和")} Tj ET`],
  ["Tm", `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj 1 0 0 1 200 400 Tm ${glyphs("和")} Tj ET`],
  ["T*", `BT /FJP 12 Tf 14 TL 72 700 Td ${glyphs("令")} Tj T* ${glyphs("和")} Tj ET`],
  ["the newline-then-show operator '", `BT /FJP 12 Tf 14 TL 72 700 Td ${glyphs("令")} Tj ${glyphs("和")} ' ET`],
  ['the newline-then-show operator "', `BT /FJP 12 Tf 14 TL 72 700 Td ${glyphs("令")} Tj 0 0 ${glyphs("和")} " ET`],
  ["a font switch", `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj /FALT 12 Tf ${glyphs("和")} Tj ET`]
];

for (const [label, content] of boundaryCases) {
  test(`does not join text across ${label}`, async () => {
    const editor = new PdfTextEditor(makePdf(content));
    assert.deepEqual(await editor.searchText("令和"), [], `"令" and "和" must not be joined across ${label}`);
    // Both halves are still there; only the join across the boundary is refused.
    assert.equal((await editor.searchText("令")).length, 1);
    assert.equal((await editor.searchText("和")).length, 1);
  });
}

test("does not join text across two content streams", async () => {
  const pdf = buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents [4 0 R 7 0 R] /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, `BT /FJP 12 Tf 72 700 Td ${glyphs("令")} Tj ET`),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    streamObject(7, `BT /FJP 12 Tf 72 700 Td ${glyphs("和")} Tj ET`)
  ]);
  const editor = new PdfTextEditor(pdf);
  assert.equal((await editor.listTextRuns()).length, 2);
  assert.deepEqual(await editor.searchText("令和"), []);
});

test("keeps searching across an operator that changes neither position nor font", async () => {
  // Marked content and a colour change sit between the two halves of one word all the
  // time; breaking on them would put the reported bug straight back.
  const content = `BT /FJP 12 Tf 72 700 Td /Span << /MCID 3 >> BDC ${glyphs("令")} Tj 0 0 0 rg ${glyphs("和")} Tj EMC ET`;
  assert.deepEqual(texts(await new PdfTextEditor(makePdf(content)).searchText("令和")), ["令和"]);
});

/* --------------------------------------------------------------------- search contract */

test("refuses an empty query instead of matching every run", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  await assert.rejects(editor.searchText(""), (error) => {
    assert.equal(error.code, "EMPTY_QUERY");
    return true;
  });
});

test("keeps match ids opaque: they carry no run id, object number, or offset", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const [match] = await editor.searchText("令和6年度");
  const runIds = (await editor.listTextRuns()).map((run) => run.id);
  for (const runId of runIds) assert.ok(!match.id.includes(runId), `match id leaks run id ${runId}`);
  assert.ok(!/\b4\b/.test(match.id), "match id leaks the content stream object number");
  assert.deepEqual(Object.keys(match).sort(), ["after", "before", "fontName", "id", "runCount", "text"]);
});

test("supersedes the previous search's match ids when searchText() runs again", async () => {
  // Documented in the README: ids live until the next search on the same editor. This
  // is what keeps a long-lived editor (the PoC searches on every keystroke) from
  // accumulating match records for every query the user ever typed.
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const [first] = await editor.searchText("令和6年度");
  await editor.searchText("令和");
  await assert.rejects(editor.replaceTextMatch(first.id, "令和7年度"), (error) => {
    assert.equal(error.code, "UNKNOWN_MATCH");
    assert.match(error.message, /superseded/);
    return true;
  });
});

test("does not accept a match id issued by a different editor", async () => {
  const bytes = makePdf(SPLIT_TJ);
  const [foreign] = await new PdfTextEditor(bytes).searchText("令和6年度");
  const editor = new PdfTextEditor(bytes);
  await editor.searchText("令和6年度");
  await assert.rejects(editor.replaceTextMatch(foreign.id, "令和7年度"), (error) => {
    assert.equal(error.code, "UNKNOWN_MATCH");
    return true;
  });
});

/* -------------------------------------------------------------------------- replacement */

test("replaces a match split across runs, keeping one operand per original run", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const [match] = await editor.searchText("令和6年度");
  await editor.replaceTextMatch(match.id, "令和7年度");
  const reopened = new PdfTextEditor(await editor.save());

  // Still five runs, still one character each: only the character that changed did.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["令", "和", "7", "年", "度"]);
  assert.deepEqual(await reopened.searchText("令和6年度"), []);
  assert.deepEqual(texts(await reopened.searchText("令和7年度")), ["令和7年度"]);
  // The TJ array's own spacing is untouched -- nothing was re-computed or dropped.
  assert.match(new TextDecoder("latin1").decode(await editor.save()), /120 <0002> -20/);
});

test("keeps the text on either side of a match that starts and ends mid-run", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td [${glyphs("申請は令")} 0 ${glyphs("和6年")} 0 ${glyphs("度です")}] TJ ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("令和6年度");
  assert.equal(match.runCount, 3);
  await editor.replaceTextMatch(match.id, "令和7年度");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["申請は令", "和7年", "度です"]);
  assert.deepEqual(texts(await reopened.searchText("申請は令和7年度です")), ["申請は令和7年度です"]);
});

test("replaces a match contained in a single run at any length, as replaceText() always has", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td ${glyphs("申請は令和6年度です")} Tj ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("令和6年度");
  assert.equal(match.runCount, 1);
  // Shorter than the match: a single-run replacement rewrites the whole operand, so
  // there is no operand boundary to preserve and no reason to refuse it.
  await editor.replaceTextMatch(match.id, "今年度");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["申請は今年度です"]);
});

test("deletes a match split across runs by emptying the operands it covers", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td [${glyphs("申請は令")} 0 ${glyphs("和6年")} 0 ${glyphs("度です")}] TJ ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("令和6年度");
  await editor.replaceTextMatch(match.id, "");
  const reopened = new PdfTextEditor(await editor.save());

  // The middle run lay wholly inside the match, so its operand is now empty; the
  // operands themselves are all still there, which keeps this an ordinary edit.
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["申請は", "", "です"]);
  assert.deepEqual(await reopened.searchText("令和6年度"), []);
  assert.deepEqual(texts(await reopened.searchText("申請はです")), ["申請はです"]);
});

test("refuses a multi-run replacement of a different length, and stages nothing", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const [match] = await editor.searchText("令和6年度");
  await assert.rejects(editor.replaceTextMatch(match.id, "今年度"), (error) => {
    assert.equal(error.code, "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED");
    return true;
  });
  // Refused means refused: save() has nothing to write and returns the input unchanged.
  assert.deepEqual(await editor.save(), makePdf(SPLIT_TJ));
});

test("refuses a match whose text has been changed by a low-level replaceText()", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const [match] = await editor.searchText("令和6年度");
  // The same document, edited underneath the match through the run-level API.
  await editor.replaceText("4:2", "7");

  await assert.rejects(editor.replaceTextMatch(match.id, "令和7年度"), (error) => {
    assert.equal(error.code, "MATCH_STALE");
    assert.match(error.message, /stale/);
    return true;
  });
  // Only the edit that was actually asked for is present -- the stale match wrote nothing.
  assert.deepEqual((await new PdfTextEditor(await editor.save()).listTextRuns()).map((run) => run.text), ["令", "和", "7", "年", "度"]);
});

test("refuses a second match once the first has rewritten a run they share", async () => {
  // "令和令和" drawn as three operands, so the two matches of "令和" overlap in the
  // middle one: replacing the first necessarily changes text the second described.
  const content = `BT /FJP 12 Tf 72 700 Td [${glyphs("令")} 0 ${glyphs("和令")} 0 ${glyphs("和")}] TJ ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2);

  await editor.replaceTextMatch(matches[0].id, "今か");
  await assert.rejects(editor.replaceTextMatch(matches[1].id, "今か"), (error) => {
    assert.equal(error.code, "MATCH_STALE");
    return true;
  });
  assert.deepEqual((await new PdfTextEditor(await editor.save()).listTextRuns()).map((run) => run.text), ["今", "か令", "和"]);
});

test("fails clearly when the existing font cannot encode a replacement character", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const [match] = await editor.searchText("令和6年度");
  // "8" has no code in this fixture's font, and no font is ever embedded to give it one.
  await assert.rejects(editor.replaceTextMatch(match.id, "令和8年度"), /has no ToUnicode code for "8"/);
  assert.equal(editor.pending.size, 0, "a failed encode must not leave part of the match replaced");
});

test("replaces one of two matches in the same operator without disturbing the other", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td [${glyphs("令")} ${glyphs("和")} ${glyphs("令")} ${glyphs("和")}] TJ ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const matches = await editor.searchText("令和");
  assert.equal(matches.length, 2);

  await editor.replaceTextMatch(matches[1].id, "今か");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["令", "和", "今", "か"]);
  assert.deepEqual(texts(await reopened.searchText("令和")), ["令和"]);
});

test("counts characters in Unicode code points, not UTF-16 code units", async () => {
  const content = `BT /FJP 12 Tf 72 700 Td [${glyphs("\u{1f600}")} 0 ${glyphs("和")}] TJ ET`;
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("\u{1f600}和");
  assert.equal(match.runCount, 2);

  // "😀和" is 2 code points but 3 UTF-16 code units. "令和" is 2 of each: equal-length
  // by the only measure that matters here, so the multi-run replacement goes through.
  await editor.replaceTextMatch(match.id, "令和");
  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["令", "和"]);
});

/* ------------------------------------------------------- the v0.2.0 API is still there */

test("leaves the low-level run API working exactly as before", async () => {
  const editor = new PdfTextEditor(makePdf(SPLIT_TJ));
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.id), ["4:0", "4:1", "4:2", "4:3", "4:4"]);
  assert.deepEqual(runs.map((run) => run.textObjectId), [0, 0, 0, 0, 0]);
  assert.equal(runs[0].fontName, "FJP");

  await editor.replaceText("4:2", "7");
  assert.deepEqual((await new PdfTextEditor(await editor.save()).listTextRuns()).map((run) => run.text), ["令", "和", "7", "年", "度"]);
});
