import assert from "node:assert/strict";
import test from "node:test";

import { firstIdBytes, stringValue } from "../src/pdf-dictionary-text.js";

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
