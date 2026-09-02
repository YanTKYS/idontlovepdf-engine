// Variable-length replacement of a match split across several text runs (v0.3.0).
//
// v0.2.1 refused every multi-run replacement whose character count changed, because
// moving characters between operands can move them on the page. v0.3.0 allows exactly
// the structures where it provably cannot: operands joined only by zero-valued `TJ`
// adjustments or by nothing at all. There, a zero adjustment translates by zero and an
// empty operand advances nothing, so the page depends only on the concatenated text --
// making "all of the replacement into the first operand, the rest emptied" the same
// edit as the single-operand replacement that has always been supported.
//
// Everything else is still refused, and the tests below pin both halves of that: the
// safe structures round-trip through save/reopen, and each unsafe one is refused with
// MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED while its equal-length and delete paths keep
// working.
import assert from "node:assert/strict";
import test from "node:test";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

const CODES = new Map([
  ["実", "0001"], ["績", "0002"], ["報", "0003"], ["告", "0004"], ["書", "0005"],
  ["申", "0006"], ["請", "0007"], ["は", "0008"], ["で", "0009"], ["す", "000a"],
  ["事", "000b"], ["業", "000c"], ["・", "000d"], ["今", "000e"], ["年", "000f"], ["度", "0010"]
]);
const UNICODE = new Map([
  ["0001", "5b9f"], ["0002", "7e3e"], ["0003", "5831"], ["0004", "544a"], ["0005", "66f8"],
  ["0006", "7533"], ["0007", "8acb"], ["0008", "306f"], ["0009", "3067"], ["000a", "3059"],
  ["000b", "4e8b"], ["000c", "696d"], ["000d", "30fb"], ["000e", "4eca"], ["000f", "5e74"], ["0010", "5ea6"]
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

function makePdf(content) {
  const objects = [
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /FJP 5 0 R /FALT 7 0 R >> >> >>\nendobj\n"),
    streamObject(4, content),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP),
    encode("7 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n")
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

const body = (operators) => `BT /FJP 12 Tf 72 700 Td ${operators} ET`;
const texts = (runs) => runs.map((run) => run.text);

/* ------------------------------------------------------------------- safe structures */

/** "実績報告書" as five operands of one TJ array, every adjustment an explicit zero. */
const SAFE_TJ = body(`[${glyphs("実")} 0 ${glyphs("績")} 0 ${glyphs("報")} 0 ${glyphs("告")} 0 ${glyphs("書")}] TJ`);
/** The same word as five consecutive Tj operators with nothing at all between them. */
const SAFE_TJ_OPERATORS = body(`${glyphs("実")} Tj ${glyphs("績")} Tj ${glyphs("報")} Tj ${glyphs("告")} Tj ${glyphs("書")} Tj`);

/**
 * Runs the whole safe path for one fixture: search, ask permission, replace, save,
 * reopen, and confirm through the reopened document that the old text is gone and the
 * new text is findable. Returns the reopened editor's run texts.
 */
async function replaceThroughSaveAndReopen(content, query, replacement, { expectedMode = "variable-length-safe" } = {}) {
  // A replacement that contains the query (報告書 -> 事業実績報告書) leaves the query
  // findable inside the new text; that is the replacement working, not failing.
  const queryOutlivesReplacement = replacement.includes(query);
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText(query);
  assert.ok(match, `the fixture must contain ${query}`);

  const check = await editor.checkTextMatchReplacement(match.id, replacement);
  assert.deepEqual(check, { allowed: true, mode: expectedMode });

  await editor.replaceTextMatch(match.id, replacement);
  const reopened = new PdfTextEditor(await editor.save());
  const runs = texts(await reopened.listTextRuns());

  if (queryOutlivesReplacement) {
    assert.equal((await reopened.searchText(query)).length, 1, `${query} must survive exactly once, inside the replacement`);
  } else {
    assert.deepEqual(await reopened.searchText(query), [], `${query} must be gone after the replacement`);
  }
  if (replacement) assert.equal((await reopened.searchText(replacement)).length, 1, `${replacement} must be findable after the replacement`);
  return runs;
}

test("shortens a match split across a zero-adjustment TJ array", async () => {
  const runs = await replaceThroughSaveAndReopen(SAFE_TJ, "実績報告書", "報告書");
  // Operand count is unchanged: the replacement went into the first, the rest emptied.
  assert.deepEqual(runs, ["報告書", "", "", "", ""]);
});

test("lengthens a match split across a zero-adjustment TJ array", async () => {
  const content = body(`[${glyphs("報")} 0 ${glyphs("告")} 0 ${glyphs("書")}] TJ`);
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "報告書", "事業実績報告書"), ["事業実績報告書", "", ""]);
});

test("shortens a match split across consecutive Tj operators", async () => {
  assert.deepEqual(await replaceThroughSaveAndReopen(SAFE_TJ_OPERATORS, "実績報告書", "報告書"), ["報告書", "", "", "", ""]);
});

test("lengthens a match split across consecutive Tj operators", async () => {
  assert.deepEqual(await replaceThroughSaveAndReopen(SAFE_TJ_OPERATORS, "実績報告書", "事業実績報告書"), ["事業実績報告書", "", "", "", ""]);
});

test("keeps the text on either side when the match covers only part of the first and last runs", async () => {
  const content = body(`[${glyphs("申請は実")} 0 ${glyphs("績")} 0 ${glyphs("報告書です")}] TJ`);
  const runs = await replaceThroughSaveAndReopen(content, "実績報告書", "報告書");
  assert.deepEqual(runs, ["申請は報告書", "", "です"]);
  const reopened = new PdfTextEditor(makePdf(content));
  assert.equal((await reopened.searchText("申請は実績報告書です")).length, 1);
});

test("treats operands with no adjustment between them as adjacent", async () => {
  const content = body(`[${glyphs("実")}${glyphs("績")}${glyphs("報")}${glyphs("告")}${glyphs("書")}] TJ`);
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "実績報告書", "報告書"), ["報告書", "", "", "", ""]);
});

test("reads every spelling of a zero adjustment as zero", async () => {
  // Compared as a PDF number, not as text, so none of these is mistaken for a real kern.
  const content = body(`[${glyphs("実")} -0.0 ${glyphs("績")} +0 ${glyphs("報")} 0.0 ${glyphs("告")} 0 ${glyphs("書")}] TJ`);
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "実績報告書", "報告書"), ["報告書", "", "", "", ""]);
});

test("mixes Tj and TJ operators as long as nothing runs between them", async () => {
  const content = body(`${glyphs("実")} Tj [${glyphs("績")} 0 ${glyphs("報")}] TJ ${glyphs("告書")} Tj`);
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "実績報告書", "報告書"), ["報告書", "", "", ""]);
});

test("leaves the operators and the adjustments around the match exactly as they were", async () => {
  const content = body(`[${glyphs("申請は")} 120 ${glyphs("実")} 0 ${glyphs("績")} 0 ${glyphs("報告書")} -35 ${glyphs("です")}] TJ`);
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("実績報告書");
  await editor.replaceTextMatch(match.id, "報告書");
  const saved = new TextDecoder("latin1").decode(await editor.save());

  // The appended content stream, in full. Same five operands, same operators, and the
  // 120 and -35 kerns outside the match still exactly where and what they were: only
  // the strings inside the match moved, into the first of the operands it covered.
  assert.equal(
    saved.match(/BT[\s\S]*?ET/g).at(-1),
    `BT /FJP 12 Tf 72 700 Td [${glyphs("申請は")} 120 ${glyphs("報告書")} 0 <> 0 <> -35 ${glyphs("です")}] TJ ET`
  );
  assert.deepEqual(texts(await new PdfTextEditor(await editor.save()).listTextRuns()), ["申請は", "報告書", "", "", "です"]);
});

/* --------------------------------------------- spacing that spans an operator boundary */

// A `TJ` adjustment displaces the next string whether it sits at the END of one array,
// at the START of the next, or between two operands of a single one: `[(A) 120] TJ
// [(B)] TJ`, `(A) Tj [120 (B)] TJ` and `[(A) 120 (B)] TJ` all move B by the same amount.
// Reading only the numbers inside an array would call the first two a plain adjacency
// and, on a length change, silently relocate that 120 to after the replacement.

test("refuses a length change across an adjustment at the end of the previous TJ array", async () => {
  const editor = new PdfTextEditor(makePdf(body(`[${glyphs("実")} 120] TJ [${glyphs("績報告書")}] TJ`)));
  const [match] = await editor.searchText("実績報告書");
  const check = await editor.checkTextMatchReplacement(match.id, "報告書");
  assert.equal(check.allowed, false);
  assert.equal(check.code, "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED");
  assert.equal(check.unsafeReason, "non-zero-tj-adjustment");
});

test("refuses a length change across an adjustment at the start of the next TJ array", async () => {
  const editor = new PdfTextEditor(makePdf(body(`${glyphs("実")} Tj [120 ${glyphs("績報告書")}] TJ`)));
  const [match] = await editor.searchText("実績報告書");
  const check = await editor.checkTextMatchReplacement(match.id, "報告書");
  assert.equal(check.allowed, false);
  assert.equal(check.unsafeReason, "non-zero-tj-adjustment");
});

test("refuses a length change when adjustments on either side of the boundary do not cancel", async () => {
  const editor = new PdfTextEditor(makePdf(body(`[${glyphs("実")} 120] TJ [-60 ${glyphs("績報告書")}] TJ`)));
  const [match] = await editor.searchText("実績報告書");
  const check = await editor.checkTextMatchReplacement(match.id, "報告書");
  assert.equal(check.allowed, false);
  assert.equal(check.unsafeReason, "non-zero-tj-adjustment");
});

test("allows a length change across a zero adjustment at the end of the previous TJ array", async () => {
  const content = body(`[${glyphs("実")} 0] TJ [${glyphs("績報告書")}] TJ`);
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "実績報告書", "報告書"), ["報告書", ""]);
});

test("allows a length change across a zero adjustment at the start of the next TJ array", async () => {
  const content = body(`${glyphs("実")} Tj [0 ${glyphs("績報告書")}] TJ`);
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "実績報告書", "報告書"), ["報告書", ""]);
});

test("allows a length change when adjustments on either side of the boundary cancel out", async () => {
  // Net displacement is zero, so the two strings really are adjacent -- and the 120 and
  // -120 stay exactly where they were, still cancelling, after the replacement.
  const content = body(`[${glyphs("実")} 120] TJ [-120 ${glyphs("績報告書")}] TJ`);
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("実績報告書");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "報告書"), { allowed: true, mode: "variable-length-safe" });
  await editor.replaceTextMatch(match.id, "報告書");
  assert.equal(
    new TextDecoder("latin1").decode(await editor.save()).match(/BT[\s\S]*?ET/g).at(-1),
    `BT /FJP 12 Tf 72 700 Td [${glyphs("報告書")} 120] TJ [-120 <>] TJ ET`
  );
  assert.deepEqual(await replaceThroughSaveAndReopen(content, "実績報告書", "報告書"), ["報告書", ""]);
});

test("does not mistake an operator's own numeric operands for spacing between strings", async () => {
  // `12` belongs to Tf and `72 700` to Td: neither displaces one string relative to
  // another, so two plainly consecutive Tj operators stay adjacent.
  const editor = new PdfTextEditor(makePdf(body(`${glyphs("実")} Tj ${glyphs("績報告書")} Tj`)));
  const [match] = await editor.searchText("実績報告書");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "報告書"), { allowed: true, mode: "variable-length-safe" });
});

/* ----------------------------------------------------------------- unsafe structures */

/** Each of these is searchable as one string, but must refuse a length change. */
const unsafeStructures = {
  "a non-zero TJ adjustment": [
    body(`[${glyphs("実")} 120 ${glyphs("績")} 0 ${glyphs("報")} 0 ${glyphs("告")} 0 ${glyphs("書")}] TJ`),
    "non-zero-tj-adjustment"
  ],
  "a character-spacing change": [body(`${glyphs("実")} Tj 20 Tc ${glyphs("績報告書")} Tj`), "text-state-boundary"],
  "a word-spacing change": [body(`${glyphs("実")} Tj 5 Tw ${glyphs("績報告書")} Tj`), "text-state-boundary"],
  "a horizontal-scaling change": [body(`${glyphs("実")} Tj 80 Tz ${glyphs("績報告書")} Tj`), "text-state-boundary"],
  "a render-mode change": [body(`${glyphs("実")} Tj 1 Tr ${glyphs("績報告書")} Tj`), "text-state-boundary"],
  "a colour change": [body(`${glyphs("実")} Tj 1 0 0 rg ${glyphs("績報告書")} Tj`), "text-state-boundary"],
  "a marked-content boundary": [body(`${glyphs("実")} Tj /Span BMC ${glyphs("績報告書")} Tj EMC`), "text-state-boundary"]
};

for (const [label, [content, expectedReason]] of Object.entries(unsafeStructures)) {
  test(`refuses a length change across ${label}`, async () => {
    const editor = new PdfTextEditor(makePdf(content));
    const [match] = await editor.searchText("実績報告書");
    // Searching still works across it -- this is a replacement rule, not a search rule.
    assert.ok(match, "the text must still be searchable across this boundary");

    const check = await editor.checkTextMatchReplacement(match.id, "報告書");
    assert.equal(check.allowed, false);
    assert.equal(check.code, "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED");
    assert.equal(check.unsafeReason, expectedReason);

    await assert.rejects(editor.replaceTextMatch(match.id, "報告書"), (error) => {
      assert.equal(error.code, "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED");
      return true;
    });
    // Refused means nothing was written.
    assert.equal(editor.pending.size, 0);
    assert.deepEqual(await editor.save(), makePdf(content));
  });

  test(`still allows an equal-length replacement and a deletion across ${label}`, async () => {
    // Neither moves a character between operands, so the boundary is irrelevant to them.
    const equal = new PdfTextEditor(makePdf(content));
    const [equalMatch] = await equal.searchText("実績報告書");
    assert.deepEqual(await equal.checkTextMatchReplacement(equalMatch.id, "事業年度報"), { allowed: true, mode: "same-length" });
    await equal.replaceTextMatch(equalMatch.id, "事業年度報");
    assert.equal((await new PdfTextEditor(await equal.save()).searchText("事業年度報")).length, 1);

    const deleted = new PdfTextEditor(makePdf(content));
    const [deleteMatch] = await deleted.searchText("実績報告書");
    assert.deepEqual(await deleted.checkTextMatchReplacement(deleteMatch.id, ""), { allowed: true, mode: "delete" });
    await deleted.replaceTextMatch(deleteMatch.id, "");
    assert.deepEqual(await new PdfTextEditor(await deleted.save()).searchText("実績報告書"), []);
  });
}

test("never sees a multi-run match across a boundary that already ends the search", async () => {
  // Td/TD/Tm/T*, a separate BT ... ET and a font switch all end search continuity, so a
  // length change across them is not refused here -- the match does not exist at all.
  const boundaries = [
    `${glyphs("実")} Tj 100 0 Td ${glyphs("績報告書")} Tj`,
    `${glyphs("実")} Tj 100 -14 TD ${glyphs("績報告書")} Tj`,
    `${glyphs("実")} Tj 1 0 0 1 200 400 Tm ${glyphs("績報告書")} Tj`,
    `14 TL ${glyphs("実")} Tj T* ${glyphs("績報告書")} Tj`,
    `${glyphs("実")} Tj /FALT 12 Tf ${glyphs("績報告書")} Tj`
  ];
  for (const operators of boundaries) {
    const editor = new PdfTextEditor(makePdf(body(operators)));
    assert.deepEqual(await editor.searchText("実績報告書"), [], `must not match across: ${operators}`);
  }
  const split = new PdfTextEditor(makePdf(`BT /FJP 12 Tf 72 700 Td ${glyphs("実")} Tj ET BT /FJP 12 Tf 72 100 Td ${glyphs("績報告書")} Tj ET`));
  assert.deepEqual(await split.searchText("実績報告書"), []);
});

/* ------------------------------------------------------------ v0.2.1 behaviour kept */

test("still replaces a single-run match at any length", async () => {
  const editor = new PdfTextEditor(makePdf(body(`${glyphs("申請は実績報告書です")} Tj`)));
  const [match] = await editor.searchText("実績報告書");
  assert.equal(match.runCount, 1);
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "今年度"), { allowed: true, mode: "single-run" });
  await editor.replaceTextMatch(match.id, "今年度");
  assert.deepEqual(texts(await new PdfTextEditor(await editor.save()).listTextRuns()), ["申請は今年度です"]);
});

test("still splits an equal-length multi-run replacement across the original operands", async () => {
  // Not the "everything into the first operand" rewrite: the operand boundaries the PDF
  // already had are kept, exactly as in v0.2.1.
  const editor = new PdfTextEditor(makePdf(SAFE_TJ));
  const [match] = await editor.searchText("実績報告書");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "事業年度報"), { allowed: true, mode: "same-length" });
  await editor.replaceTextMatch(match.id, "事業年度報");
  assert.deepEqual(texts(await new PdfTextEditor(await editor.save()).listTextRuns()), ["事", "業", "年", "度", "報"]);
});

test("still deletes a multi-run match by emptying each operand's own share", async () => {
  const content = body(`[${glyphs("申請は実")} 0 ${glyphs("績")} 0 ${glyphs("報告書です")}] TJ`);
  const editor = new PdfTextEditor(makePdf(content));
  const [match] = await editor.searchText("実績報告書");
  await editor.replaceTextMatch(match.id, "");
  assert.deepEqual(texts(await new PdfTextEditor(await editor.save()).listTextRuns()), ["申請は", "", "です"]);
});

/* ------------------------------------------- the check and the replacement agree */

test("never reports a replacement as allowed that the replacement itself then refuses", async () => {
  const fixtures = [
    SAFE_TJ,
    SAFE_TJ_OPERATORS,
    body(`[${glyphs("実")} 0] TJ [${glyphs("績報告書")}] TJ`),
    body(`[${glyphs("実")} 120] TJ [${glyphs("績報告書")}] TJ`),
    body(`${glyphs("実")} Tj [120 ${glyphs("績報告書")}] TJ`),
    body(`[${glyphs("実")} 120] TJ [-120 ${glyphs("績報告書")}] TJ`),
    ...Object.values(unsafeStructures).map(([content]) => content)
  ];
  // Shorter, longer, equal-length, delete, and identical -- one of each replacement shape.
  const replacements = ["報告書", "事業実績報告書", "事業年度報", "", "実績報告書"];
  for (const content of fixtures) {
    for (const replacement of replacements) {
      const editor = new PdfTextEditor(makePdf(content));
      const [match] = await editor.searchText("実績報告書");
      const check = await editor.checkTextMatchReplacement(match.id, replacement);
      let replaced = true;
      try {
        await editor.replaceTextMatch(match.id, replacement);
      } catch (error) {
        replaced = false;
        assert.equal(error.code, check.code, "the refusal reason must match the one reported up front");
      }
      assert.equal(replaced, check.allowed, `check and replace disagreed on ${JSON.stringify(replacement)}`);
    }
  }
});

test("reports a character the font cannot encode before anything is staged", async () => {
  const editor = new PdfTextEditor(makePdf(SAFE_TJ));
  const [match] = await editor.searchText("実績報告書");
  // "計画" has no code in this fixture's font, and no font is ever embedded to give it one.
  const check = await editor.checkTextMatchReplacement(match.id, "計画");
  assert.equal(check.allowed, false);
  assert.equal(check.code, "FONT_ENCODING_UNSUPPORTED");
  assert.match(check.reason, /has no ToUnicode code for/);

  await assert.rejects(editor.replaceTextMatch(match.id, "計画"), /has no ToUnicode code for "計"/);
  assert.equal(editor.pending.size, 0, "a failed encode must leave the document untouched");
});

test("keeps the match lifecycle: stale and unknown matches are refused by both APIs", async () => {
  const editor = new PdfTextEditor(makePdf(SAFE_TJ));
  const [match] = await editor.searchText("実績報告書");
  await editor.replaceText("4:2", "年");

  const check = await editor.checkTextMatchReplacement(match.id, "報告書");
  assert.equal(check.allowed, false);
  assert.equal(check.code, "MATCH_STALE");
  await assert.rejects(editor.replaceTextMatch(match.id, "報告書"), (error) => {
    assert.equal(error.code, "MATCH_STALE");
    return true;
  });

  await editor.searchText("報告");
  const superseded = await editor.checkTextMatchReplacement(match.id, "報告書");
  assert.equal(superseded.code, "UNKNOWN_MATCH");
});

test("replaces one of two matches in the same safe segment without disturbing the other", async () => {
  const content = body(
    `[${glyphs("実")} 0 ${glyphs("績")} 0 ${glyphs("報告書")} 0 ${glyphs("・")} 0 ${glyphs("実")} 0 ${glyphs("績")} 0 ${glyphs("報告書")}] TJ`
  );
  const editor = new PdfTextEditor(makePdf(content));
  const matches = await editor.searchText("実績報告書");
  assert.equal(matches.length, 2);

  await editor.replaceTextMatch(matches[1].id, "報告書");
  // The first match's runs were never touched, so it is still valid and still replaceable.
  assert.deepEqual(await editor.checkTextMatchReplacement(matches[0].id, "事業報告"), { allowed: true, mode: "variable-length-safe" });

  const reopened = new PdfTextEditor(await editor.save());
  assert.deepEqual(texts(await reopened.listTextRuns()), ["実", "績", "報告書", "・", "報告書", "", ""]);
  assert.equal((await reopened.searchText("実績報告書・報告書")).length, 1);
});
