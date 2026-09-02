// src/sha2.js -- SHA-256 via Web Crypto where it exists, and in JavaScript where it does not.
//
// Both paths are checked against node:crypto (an OpenSSL-backed implementation sharing no
// code with either) rather than against each other alone, and at the lengths a SHA-256
// implementation gets wrong if it gets anything wrong: side of the 64-byte block, side of
// the point where the 8-byte length field no longer fits in the final block, and either
// side of a block boundary well past the first.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { sha256, sha256Hex } from "../src/sha2.js";

const secureContextCrypto = globalThis.crypto;

/** Runs `body` with `crypto.subtle` unavailable, as it is on a page served over plain HTTP. */
async function withoutWebCrypto(body) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (array) => secureContextCrypto.getRandomValues(array) }
  });
  try {
    assert.equal(globalThis.crypto.subtle, undefined, "the substitution must have taken effect");
    return await body();
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: secureContextCrypto });
  }
}

const LENGTHS = [0, 1, 31, 32, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65_536, 4_667_376];
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

test("Web Crypto path matches node:crypto across the block and length-field boundaries", async () => {
  assert.ok(globalThis.crypto?.subtle, "this test needs a Secure Context to be testing anything");
  for (const length of LENGTHS) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.equal(hex(await sha256(bytes)), createHash("sha256").update(bytes).digest("hex"), `length ${length}`);
  }
});

test("JavaScript path matches node:crypto across the same boundaries", async () => {
  await withoutWebCrypto(async () => {
    for (const length of LENGTHS) {
      const bytes = new Uint8Array(randomBytes(length));
      assert.equal(hex(await sha256(bytes)), createHash("sha256").update(bytes).digest("hex"), `length ${length}`);
    }
  });
});

test("the two paths agree, so a digest written by one is recognised by the other", async () => {
  // This is the property the fallback font depends on: a digest recorded in a PDF over
  // HTTPS has to match the one computed for the same font over HTTP, and the other way round.
  for (const length of LENGTHS) {
    const bytes = new Uint8Array(randomBytes(length));
    const withWebCrypto = await sha256Hex(bytes);
    const inJavaScript = await withoutWebCrypto(() => sha256Hex(bytes));
    assert.equal(inJavaScript, withWebCrypto, `length ${length}`);
  }
});

test("hex output is lowercase, zero-padded, and 64 characters", async () => {
  for (const digest of [await sha256Hex(new Uint8Array(0)), await withoutWebCrypto(() => sha256Hex(new Uint8Array(0)))]) {
    assert.equal(digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  }
});

test("restores crypto after each helper call, so no later test runs blind", () => {
  assert.ok(globalThis.crypto?.subtle, "crypto.subtle must be back");
});
