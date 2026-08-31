import assert from "node:assert/strict";
import test from "node:test";

import { rc4 } from "../src/security/rc4.js";

const encode = (value) => new TextEncoder().encode(value);

test("matches well-known RC4 test vectors", () => {
  // These three (key, plaintext) -> ciphertext pairs are the commonly cited RC4
  // worked examples (e.g. from Wikipedia's RC4 article), independent of this
  // codebase's own implementation.
  const vectors = [
    ["Key", "Plaintext", "bbf316e8d940af0ad3"],
    ["Wiki", "pedia", "1021bf0420"],
    ["Secret", "Attack at dawn", "45a01f645fc35b383552544b9bf5"]
  ];
  for (const [key, plaintext, expectedHex] of vectors) {
    const ciphertext = rc4(encode(key), encode(plaintext));
    assert.equal(Buffer.from(ciphertext).toString("hex"), expectedHex, key);
  }
});

test("is its own inverse (the same function encrypts and decrypts)", () => {
  const key = encode("a reasonably long RC4 key for this test");
  const plaintext = encode("Round-tripping through RC4 should recover the original bytes exactly.");
  const ciphertext = rc4(key, plaintext);
  assert.notDeepEqual(ciphertext, plaintext);
  assert.deepEqual(rc4(key, ciphertext), plaintext);
});

test("produces different ciphertext for different keys", () => {
  const plaintext = encode("same plaintext, different keys");
  const a = rc4(encode("key-one"), plaintext);
  const b = rc4(encode("key-two"), plaintext);
  assert.notDeepEqual(a, b);
});

test("rejects an empty key", () => {
  assert.throws(() => rc4(new Uint8Array(0), encode("data")), /key must not be empty/);
});
