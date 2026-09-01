import assert from "node:assert/strict";
import test from "node:test";

import { firstIdBytes, stringValue, topLevelInteger, topLevelValueOffset } from "../src/pdf-dictionary-text.js";

/**
 * These build dictionary/trailer *text* the same way pdf-structure.js's
 * decodeBinaryString() does (one UTF-16 code unit per byte, 0-255 -- see that
 * function's own comment for why this must NOT be TextDecoder("latin1"), which is
 * actually windows-1252 and would corrupt bytes 0x80-0x9F). The PDF *source* text
 * below (backslash escapes, parentheses, digits) is itself always ASCII, so it can
 * be written as an ordinary JS string literal; only the *decoded* /O, /U, /ID
 * values are expected to contain the full 0-255 byte range.
 */
function dictionaryText(source) {
  return source;
}

test("stringValue() reads a literal string's named escapes (\\n \\r \\t \\b \\f \\( \\) \\\\)", () => {
  const text = dictionaryText("<< /O (\\n\\r\\t\\b\\f\\(\\)\\\\) >>");
  assert.deepEqual(stringValue(text, "O"), Uint8Array.of(0x0a, 0x0d, 0x09, 0x08, 0x0c, 0x28, 0x29, 0x5c));
});

test("stringValue() reads octal escapes (1-3 digits) to recover bytes 0x80-0x9F, byte-exact", () => {
  // \200 = octal 200 = 128 = 0x80, \237 = octal 237 = 159 = 0x9F, \101 = 'A'.
  // These are exactly the bytes a naive TextDecoder("latin1") round-trip would
  // corrupt (windows-1252 remaps 0x80-0x9F to other Unicode code points).
  const text = dictionaryText("<< /O (\\200\\237\\101) >>");
  assert.deepEqual(stringValue(text, "O"), Uint8Array.of(0x80, 0x9f, 0x41));
});

test("stringValue() treats a backslash followed by end-of-line as a line continuation (no character produced)", () => {
  const text = dictionaryText("<< /O (line1\\\nline2) >>");
  assert.deepEqual(stringValue(text, "O"), new TextEncoder().encode("line1line2"));
});

test("stringValue() reads a hex string, ignoring interior whitespace and padding a trailing odd digit", () => {
  const text = dictionaryText("<< /U <80 9F 41 5> >>");
  assert.deepEqual(stringValue(text, "U"), Uint8Array.of(0x80, 0x9f, 0x41, 0x50));
});

test("stringValue() returns null for an absent key or a nested dictionary value (not a string)", () => {
  const text = dictionaryText("<< /CF << /StdCF << /CFM /AESV2 >> >> >>");
  assert.equal(stringValue(text, "O"), null);
  assert.equal(stringValue(text, "CF"), null);
});

test("firstIdBytes() reads the trailer's /ID first element as a literal string, byte-exact through 0x80-0x9F", () => {
  const trailer = dictionaryText("<< /Size 6 /Root 1 0 R /ID [ (a\\200b\\237c) (second-id-unused) ] >>");
  assert.deepEqual(firstIdBytes(trailer), Uint8Array.of(0x61, 0x80, 0x62, 0x9f, 0x63));
});

test("firstIdBytes() reads the trailer's /ID first element as a hex string", () => {
  const trailer = dictionaryText("<< /Size 6 /Root 1 0 R /ID [<80819FFF> <00>] >>");
  assert.deepEqual(firstIdBytes(trailer), Uint8Array.of(0x80, 0x81, 0x9f, 0xff));
});

test("firstIdBytes() returns null when the trailer has no /ID", () => {
  assert.equal(firstIdBytes("<< /Size 6 /Root 1 0 R >>"), null);
});

/* ---------------------------------------------------------- topLevelInteger() / topLevelValueOffset() */
/* These reproduce the exact structural bug a real PDF (Standard/V5/R6/AESV3) hit:
 * its Encrypt dictionary's own top-level /Length (256, bits) and its Crypt Filter
 * sub-dictionary's /Length (32, bytes) share the same key name, and a plain
 * whole-text search returns whichever one comes first in the raw bytes -- which,
 * for that PDF, was the nested one, silently misreporting the top-level /Length. */

const NESTED_CF_BEFORE_TOP_LEVEL = dictionaryText(
  "<< /Filter /Standard /V 5 /R 6 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /Length 256 >>"
);
const TOP_LEVEL_BEFORE_NESTED_CF = dictionaryText(
  "<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> >>"
);

test("topLevelInteger() reads the Encrypt dictionary's own /Length, not the nested Crypt Filter's, when CF comes first", () => {
  assert.equal(topLevelInteger(NESTED_CF_BEFORE_TOP_LEVEL, "Length"), 256);
});

test("topLevelInteger() reads the same top-level /Length regardless of whether CF appears before or after it", () => {
  // No "first /Length wins" behavior: both orderings must produce the identical
  // top-level value.
  assert.equal(topLevelInteger(NESTED_CF_BEFORE_TOP_LEVEL, "Length"), topLevelInteger(TOP_LEVEL_BEFORE_NESTED_CF, "Length"));
  assert.equal(topLevelInteger(TOP_LEVEL_BEFORE_NESTED_CF, "Length"), 256);
});

test("topLevelInteger() still lets the nested Crypt Filter's own /Length be read from its own isolated sub-dictionary text", () => {
  // This is what parseCryptFilters() in encryption.js actually does: it isolates
  // each named filter's own text first (via nestedDictionaryText()/
  // namedSubDictionaries()), then reads /Length from *that* text -- at which point
  // it IS the top-level (depth-0) key of that smaller dictionary, and
  // topLevelInteger() correctly returns it.
  const stdCfText = "<< /CFM /AESV3 /Length 32 >>";
  assert.equal(topLevelInteger(stdCfText, "Length"), 32);
});

test("topLevelValueOffset() does not mistake /Length appearing inside a literal string, hex string, or array for the real key", () => {
  const text = dictionaryText(
    "<< /SomeText (contains /Length 123 as literal text) " +
    "/SomeHex <4C656E677468> " +
    "/Array [ << /Length 64 >> ] " +
    "/CF << /StdCF << /Length 32 >> >> " +
    "/Length 256 >>"
  );
  assert.equal(topLevelInteger(text, "Length"), 256);
});

test("topLevelValueOffset() returns undefined when /key only appears nested, never at the top level", () => {
  const text = dictionaryText("<< /CF << /StdCF << /Length 32 >> >> >>");
  assert.equal(topLevelValueOffset(text, "Length"), undefined);
  assert.equal(topLevelInteger(text, "Length"), null);
});

test("topLevelInteger() handles multiply-nested structures (array of dictionaries, nested dictionaries) without losing track of depth", () => {
  const text = dictionaryText(
    "<< /Weird [ << /A << /Length 1 >> >> << /B [ << /Length 2 >> ] >> ] /Length 999 >>"
  );
  assert.equal(topLevelInteger(text, "Length"), 999);
});

test("topLevelInteger() reads /V and /R the same depth-aware way (no realistic collision, but consistent with /Length)", () => {
  assert.equal(topLevelInteger(NESTED_CF_BEFORE_TOP_LEVEL, "V"), 5);
  assert.equal(topLevelInteger(NESTED_CF_BEFORE_TOP_LEVEL, "R"), 6);
});

/* ------------------------------------------------------- key/value alternation regression (review round 2) */
/* A depth-only scanner cannot tell a name in *key* position from a structurally
 * identical name that is merely the *value* of a preceding key. In
 * << /Foo /Length /Length 256 >>, the first /Length is /Foo's value, not a key --
 * topLevelValueOffset()/topLevelInteger() must skip exactly one value per key and
 * only match a name when it is actually read in key position. */

test("topLevelInteger() is not fooled by a name-shaped value that equals the key being searched for", () => {
  const text = dictionaryText("<< /Foo /Length /Length 256 >>");
  assert.equal(topLevelInteger(text, "Length"), 256);
});

test("topLevelValueOffset() skips a preceding key's indirect-reference value (N G R) as a single value", () => {
  const text = dictionaryText("<< /Root 1 0 R /Length 256 >>");
  assert.equal(topLevelInteger(text, "Length"), 256);
});

/* ------------------------------------------------------------- strict integer parsing (review round 2) */
/* topLevelInteger() must validate the *entire* value token as a PDF integer
 * (parseStrictInteger()-equivalent), not just scan a leading run of digits. */

test("topLevelInteger() accepts a plain PDF integer", () => {
  assert.equal(topLevelInteger(dictionaryText("<< /Length 256 >>"), "Length"), 256);
});

test("topLevelInteger() accepts a PDF integer with an explicit leading +", () => {
  assert.equal(topLevelInteger(dictionaryText("<< /Length +256 >>"), "Length"), 256);
});

test("topLevelInteger() rejects a value with trailing non-digit characters instead of truncating to the leading digits", () => {
  assert.equal(topLevelInteger(dictionaryText("<< /Length 256foo >>"), "Length"), null);
});

test("topLevelInteger() rejects a real number (contains a decimal point), it is not a PDF integer", () => {
  assert.equal(topLevelInteger(dictionaryText("<< /Length 256.0 >>"), "Length"), null);
  assert.equal(topLevelInteger(dictionaryText("<< /R 6.5 >>"), "R"), null);
});

test("topLevelInteger() rejects a digit run followed by trailing letters", () => {
  assert.equal(topLevelInteger(dictionaryText("<< /R 6abc >>"), "R"), null);
});
