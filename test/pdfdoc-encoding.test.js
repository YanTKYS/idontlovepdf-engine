import assert from "node:assert/strict";
import test from "node:test";

import { encodePdfDocPassword } from "../src/security/pdfdoc-encoding.js";

test("passes ASCII printable characters through unchanged", () => {
  assert.deepEqual(encodePdfDocPassword("abc123!@#"), new TextEncoder().encode("abc123!@#"));
  assert.deepEqual(encodePdfDocPassword(""), new Uint8Array(0));
  assert.deepEqual(encodePdfDocPassword(undefined), new Uint8Array(0));
});

test("encodes Latin-1-range characters (0xA1-0xFF) as their own single byte, not as multi-byte UTF-8", () => {
  // "e-acute" is one byte (0xE9) in PDFDocEncoding (same as Latin-1 there), but two
  // bytes (0xC3 0xA9) in UTF-8 -- exactly the mismatch that made the previous,
  // UTF-8-based implementation fail to authenticate a correct non-ASCII password.
  const eAcute = "café";
  assert.deepEqual(encodePdfDocPassword(eAcute), Uint8Array.of(0x63, 0x61, 0x66, 0xe9));
  assert.deepEqual([...encodePdfDocPassword("é")], [0xe9]);
  assert.notDeepEqual(encodePdfDocPassword("é"), new TextEncoder().encode("é"));
});

test("maps the documented special characters (0x18-0x1F, 0x80-0x9F, 0xA0) to their PDFDocEncoding byte", () => {
  assert.deepEqual(encodePdfDocPassword("˘"), Uint8Array.of(0x18)); // breve
  assert.deepEqual(encodePdfDocPassword("•"), Uint8Array.of(0x80)); // bullet
  assert.deepEqual(encodePdfDocPassword("™"), Uint8Array.of(0x92)); // trademark
  assert.deepEqual(encodePdfDocPassword("€"), Uint8Array.of(0xa0)); // EURO SIGN (displaces NBSP here)
});

test("rejects characters PDFDocEncoding cannot represent, instead of guessing or substituting", () => {
  assert.throws(() => encodePdfDocPassword(" "), /cannot be represented/); // NBSP -- 0xA0 means EURO SIGN instead
  assert.throws(() => encodePdfDocPassword("­"), /cannot be represented/); // soft hyphen: undefined
  assert.throws(() => encodePdfDocPassword("\x7f"), /cannot be represented/); // DEL
  assert.throws(() => encodePdfDocPassword("\x1f"), /cannot be represented/); // reserved for a special accent char
  assert.throws(() => encodePdfDocPassword("日"), /cannot be represented/); // a CJK character, well outside the table
  assert.throws(() => encodePdfDocPassword("\u{1f600}"), /cannot be represented/); // an emoji, outside the BMP entirely
});
