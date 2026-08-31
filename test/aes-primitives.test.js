import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import {
  aesCbcNoPaddingDecrypt,
  aesCbcNoPaddingEncrypt,
  aesEcbBlockDecrypt,
  aesEcbBlockEncrypt
} from "../src/security/aes-primitives.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const fromHex = (value) => Uint8Array.from(Buffer.from(value, "hex"));

/* --------------------------------------------------------- FIPS 197 known-answer tests */
/* These come from the published NIST FIPS 197 standard itself (Appendix C.1 and C.3),
 * not from this repository's own implementation -- a from-scratch AES core that only
 * round-trips against itself could still disagree with the actual AES definition. */

test("AES-128 single block matches FIPS 197 Appendix C.1", () => {
  const key = fromHex("000102030405060708090a0b0c0d0e0f");
  const plaintext = fromHex("00112233445566778899aabbccddeeff");
  const ciphertext = aesEcbBlockEncrypt(key, plaintext);
  assert.equal(hex(ciphertext), "69c4e0d86a7b0430d8cdb78070b4c55a");
  assert.deepEqual(aesEcbBlockDecrypt(key, ciphertext), plaintext);
});

test("AES-256 single block matches FIPS 197 Appendix C.3", () => {
  const key = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const plaintext = fromHex("00112233445566778899aabbccddeeff");
  const ciphertext = aesEcbBlockEncrypt(key, plaintext);
  assert.equal(hex(ciphertext), "8ea2b7ca516745bfeafc49904b496089");
  assert.deepEqual(aesEcbBlockDecrypt(key, ciphertext), plaintext);
});

/* --------------------------------------------------------------- Node crypto cross-checks */
/* Independent of this module's own encrypt/decrypt agreeing with each other: Node's
 * built-in `crypto` (a completely separate AES implementation, OpenSSL-backed) is used
 * with auto-padding disabled to build the same no-padding CBC/ECB operations, and the
 * results are compared byte-for-byte in both directions and at both key sizes. */

test("AES-128-CBC no padding matches node:crypto (encrypt and decrypt, both directions)", () => {
  const key = randomBytes(16);
  const iv = randomBytes(16);
  const data = randomBytes(16 * 5);

  const cipher = createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const nodeCiphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  assert.equal(hex(aesCbcNoPaddingEncrypt(key, iv, data)), nodeCiphertext.toString("hex"));

  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  const nodePlaintext = Buffer.concat([decipher.update(nodeCiphertext), decipher.final()]);
  assert.equal(hex(aesCbcNoPaddingDecrypt(key, iv, nodeCiphertext)), nodePlaintext.toString("hex"));
  assert.equal(nodePlaintext.toString("hex"), hex(data));
});

test("AES-256-CBC no padding, zero IV, matches node:crypto (the /UE //OE shape)", () => {
  const key = randomBytes(32);
  const iv = new Uint8Array(16);
  const data = randomBytes(32); // exactly the /UE //OE length

  const cipher = createCipheriv("aes-256-cbc", key, Buffer.from(iv));
  cipher.setAutoPadding(false);
  const nodeCiphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  assert.equal(hex(aesCbcNoPaddingEncrypt(key, iv, data)), nodeCiphertext.toString("hex"));

  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(iv));
  decipher.setAutoPadding(false);
  const nodePlaintext = Buffer.concat([decipher.update(nodeCiphertext), decipher.final()]);
  assert.equal(hex(aesCbcNoPaddingDecrypt(key, iv, nodeCiphertext)), nodePlaintext.toString("hex"));
});

test("AES-256 single-block ECB matches node:crypto's aes-256-ecb over many random blocks", () => {
  for (let trial = 0; trial < 64; trial += 1) {
    const key = randomBytes(32);
    const block = randomBytes(16);
    const cipher = createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    const nodeCiphertext = Buffer.concat([cipher.update(block), cipher.final()]);
    assert.equal(hex(aesEcbBlockEncrypt(key, block)), nodeCiphertext.toString("hex"), `trial ${trial} (key ${hex(key)})`);
    assert.equal(hex(aesEcbBlockDecrypt(key, nodeCiphertext)), block.toString("hex"), `trial ${trial} decrypt (key ${hex(key)})`);
  }
});

/* ------------------------------------------------------------------------------- Buffer aliasing */
/* Node's Buffer overrides Uint8Array's .slice() with view-sharing (not copying)
 * semantics. A from-scratch implementation that used `.slice()` internally to make a
 * "private" mutable working copy would, when handed a real Buffer (as node:crypto
 * APIs and test fixtures throughout this codebase commonly hand out), silently mutate
 * the caller's own bytes in place instead of leaving them untouched. */

test("does not mutate a Buffer input in place (encrypt)", () => {
  const key = Buffer.from(randomBytes(32));
  const block = Buffer.from(randomBytes(16));
  const before = Buffer.from(block).toString("hex");
  aesEcbBlockEncrypt(key, block);
  assert.equal(block.toString("hex"), before);
});

test("does not mutate a Buffer input in place (decrypt)", () => {
  const key = Buffer.from(randomBytes(32));
  const block = Buffer.from(randomBytes(16));
  const before = Buffer.from(block).toString("hex");
  aesEcbBlockDecrypt(key, block);
  assert.equal(block.toString("hex"), before);
});

/* ----------------------------------------------------------------------------------- validation */

test("rejects data that is not a multiple of 16 bytes for CBC no-padding", () => {
  const key = randomBytes(16);
  const iv = randomBytes(16);
  assert.throws(() => aesCbcNoPaddingEncrypt(key, iv, randomBytes(17)), /multiple of 16/);
  assert.throws(() => aesCbcNoPaddingDecrypt(key, iv, randomBytes(15)), /multiple of 16/);
});

test("rejects an ECB block that is not exactly 16 bytes", () => {
  const key = randomBytes(32);
  assert.throws(() => aesEcbBlockEncrypt(key, randomBytes(15)), /exactly 16 bytes/);
  assert.throws(() => aesEcbBlockDecrypt(key, randomBytes(17)), /exactly 16 bytes/);
});

test("rejects an unsupported AES key length", () => {
  assert.throws(() => aesEcbBlockEncrypt(randomBytes(24), randomBytes(16)), /Unsupported AES key length/);
});
