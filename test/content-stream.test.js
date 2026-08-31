import assert from "node:assert/strict";
import test from "node:test";

import { scanTextRuns, skipDictionary } from "../src/content-stream.js";

const encode = (value) => new TextEncoder().encode(value);
const utf8 = new TextDecoder("utf-8");
const latin1 = new TextDecoder("latin1");

/** Literal-string run text as scanTextRuns() actually returns it: raw bytes, not
 * CMap-decoded (that only happens above this layer, in pdf-document.js). */
function texts(bytes, context) {
  return scanTextRuns(bytes, context).map((run) => (run.syntax === "literal" ? utf8.decode(run.value) : run.value));
}

/* ----------------------------------------------------------------- dictionary operands */
/* These reproduce the exact scanner defect the /Span << /MCID 12 >> BDC bug report
 * describes: without skipDictionary(), the dictionary's own second `<` was mistaken
 * for the start of a hex string, and everything up to (and past) the dictionary's
 * `/MCID 12 ` was fed to readHex() as if it were hex digits. */

test("does not misinterpret a dictionary operand's second '<' as a hex string (the reported bug)", () => {
  const bytes = encode("BT /Span << /MCID 12 >> BDC (Hello) Tj EMC ET");
  assert.deepEqual(texts(bytes), ["Hello"]);
});

test("does not treat a literal string nested inside a dictionary operand as a text run", () => {
  const bytes = encode("BT /Span << /ActualText (Not a text run) >> BDC (Visible) Tj EMC ET");
  assert.deepEqual(texts(bytes), ["Visible"]);
});

test("does not treat a hex string nested inside a dictionary operand as a text run", () => {
  const bytes = encode("BT /Span << /Data <414243> >> BDC (Visible) Tj EMC ET");
  assert.deepEqual(texts(bytes), ["Visible"]);
});

test("skips a nested dictionary inside a dictionary operand", () => {
  const bytes = encode(
    "BT /Span << /MCID 1 /Properties << /Lang (ja-JP) >> >> BDC (Visible) Tj EMC ET"
  );
  assert.deepEqual(texts(bytes), ["Visible"]);
});

test("skips an array (with nested literal and hex strings) inside a dictionary operand", () => {
  const bytes = encode(
    "BT /Span << /BBox [0 0 100 100] /Items [(A) <42>] >> BDC (Visible) Tj EMC ET"
  );
  assert.deepEqual(texts(bytes), ["Visible"]);
});

test("treats a '%' comment inside a dictionary operand as whitespace", () => {
  const bytes = encode("BT /Span << /MCID 1 % comment\n/Lang (ja-JP) >> BDC (Visible) Tj ET");
  assert.deepEqual(texts(bytes), ["Visible"]);
});

test("still reads a real hex text-showing string that follows a dictionary operand", () => {
  const bytes = encode("BT /Span << /MCID 1 >> BDC <00010002> Tj EMC ET");
  const [run] = scanTextRuns(bytes);
  assert.equal(run.syntax, "hex");
  assert.deepEqual(run.value, Uint8Array.of(0x00, 0x01, 0x00, 0x02));
});

test("a dictionary containing a literal string with an escaped close-paren does not break depth tracking", () => {
  // The literal string's own content ")" is escaped, so it is data, not a delimiter --
  // readLiteral() (reused by skipDictionary()) already understands this; this just
  // confirms skipDictionary() does not re-scan the string's raw bytes itself.
  const bytes = encode("BT /Span << /ActualText (sample \\) text) >> BDC (Visible) Tj ET");
  assert.deepEqual(texts(bytes), ["Visible"]);
});

/* --------------------------------------------------------------------------- TJ array */
/* Dictionary support must not make the scanner start skipping arrays wholesale -- a
 * TJ array's string operands are still read individually, as before. */

test("still reads each string operand out of a TJ array (regression)", () => {
  const bytes = encode("BT [(日) 20 (本)] TJ ET");
  assert.deepEqual(texts(bytes), ["日", "本"]);
});

/* ------------------------------------------------------------------------- malformed */

test("rejects an unterminated dictionary operand instead of hanging or silently recovering", () => {
  const bytes = encode("BT /Span << /A 1 (Hello) Tj ET");
  assert.throws(() => scanTextRuns(bytes), /Malformed PDF dictionary in content stream/);
});

test("rejects a dictionary operand with an unterminated nested string", () => {
  const bytes = encode("BT /Span << /A (unterminated >> BDC (Hello) Tj ET");
  assert.throws(() => scanTextRuns(bytes), /Malformed PDF literal string/);
});

test("rejects a dictionary operand with an invalid nested hex string", () => {
  const bytes = encode("BT /Span << /A <GG> >> BDC (Hello) Tj ET");
  assert.throws(() => scanTextRuns(bytes), /Malformed PDF hex string/);
});

test("rejects a dictionary operand whose nested dictionary is never closed", () => {
  const bytes = encode("BT /Span << /A 1 /B << /C 2 >> BDC (Hello) Tj ET");
  assert.throws(() => scanTextRuns(bytes), /Malformed PDF dictionary in content stream/);
});

test("still rejects a genuinely malformed hex text-showing string (dictionary support does not silently skip it)", () => {
  const bytes = encode("BT <GG> Tj ET");
  assert.throws(() => scanTextRuns(bytes), /Malformed PDF hex string/);
});

/* -------------------------------------------------------------------------- error context */

test("attaches content-stream context and a byte offset to a parse failure", () => {
  const bytes = encode("BT (unterminated Tj ET");
  assert.throws(
    () => scanTextRuns(bytes, "content stream object 45"),
    (error) => {
      assert.match(error.message, /Malformed PDF literal string/);
      assert.match(error.message, /content stream object 45/);
      assert.match(error.message, /byte offset \d+/);
      assert.equal(typeof error.contentStreamOffset, "number");
      assert.equal(typeof error.contentStreamExcerpt, "string");
      return true;
    }
  );
});

test("still reports a byte offset when no context is given", () => {
  const bytes = encode("BT <GG> Tj ET");
  assert.throws(() => scanTextRuns(bytes), /byte offset \d+/);
});

/* ------------------------------------------------------------------ skipDictionary() unit */

test("skipDictionary() returns the offset just past the matching '>>'", () => {
  const bytes = encode("<< /A 1 >> REST");
  const end = skipDictionary(bytes, 0);
  assert.equal(latin1.decode(bytes.subarray(end)), " REST");
});

test("skipDictionary() throws when not given the start of a dictionary", () => {
  const bytes = encode("(not a dictionary)");
  assert.throws(() => skipDictionary(bytes, 0), /Expected a PDF dictionary/);
});
