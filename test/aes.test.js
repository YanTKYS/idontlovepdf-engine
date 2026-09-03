// src/security/aes.js -- AES-CBC + PKCS#7, with and without Web Crypto.
//
// The Web Crypto path and the JavaScript path have to be indistinguishable to callers:
// same plaintext for the same input, and the same refusal for a wrong key or damaged
// padding. Both are checked against node:crypto (OpenSSL, sharing no code with either)
// rather than only against each other.
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import { decryptAesCbc } from "../src/security/aes.js";
import { withWebCrypto, withoutWebCrypto } from "./helpers/web-crypto.js";

/** `IV || AES-CBC(PKCS#7) ciphertext`, the layout PDF AESV2/AESV3 strings and streams use. */
function encrypt(key, plain) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(key.length === 16 ? "aes-128-cbc" : "aes-256-cbc", key, iv);
  return new Uint8Array([...iv, ...cipher.update(plain), ...cipher.final()]);
}

// 0 and 15 sit either side of a whole padding block; 16 and 32 are the lengths where
// PKCS#7 adds a full block of padding, which is where an unpadding step goes wrong.
const LENGTHS = [0, 1, 15, 16, 17, 31, 32, 33, 100, 4096];

for (const [label, keyLength] of [["AESV2 (128-bit)", 16], ["AESV3 (256-bit)", 32]]) {
  test(`${label} decrypts identically with and without Web Crypto`, async () => {
    for (const length of LENGTHS) {
      const key = new Uint8Array(randomBytes(keyLength));
      const plain = new Uint8Array(randomBytes(length));
      const data = encrypt(Buffer.from(key), Buffer.from(plain));

      const viaWebCrypto = await withWebCrypto(() => decryptAesCbc(key, data));
      assert.deepEqual(viaWebCrypto, plain, `${label}, Web Crypto, length ${length}`);
      const inJavaScript = await withoutWebCrypto(() => decryptAesCbc(key, data));
      assert.deepEqual(inJavaScript, plain, `${label}, JavaScript, length ${length}`);
    }
  });
}

test("both paths refuse a wrong key rather than returning mis-unpadded data", async () => {
  // A wrong key leaves plaintext whose last byte is a valid padding length about one time
  // in 256, so this is run enough times to catch an unpadding step that only looks at it.
  let refusedByWebCrypto = 0;
  let refusedInJavaScript = 0;
  const attempts = 300;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = encrypt(randomBytes(32), randomBytes(64));
    const wrongKey = new Uint8Array(randomBytes(32));
    const viaWebCrypto = await withWebCrypto(() => decryptAesCbc(wrongKey, data).then(() => null, (error) => error));
    const viaJavaScript = await withoutWebCrypto(() => decryptAesCbc(wrongKey, data).then(() => null, (error) => error));
    if (viaWebCrypto) refusedByWebCrypto += 1;
    if (viaJavaScript) refusedInJavaScript += 1;
    // Whatever either does, they must do the same thing -- a caller must not be able to
    // tell from the outcome whether the page had Web Crypto.
    assert.equal(Boolean(viaJavaScript), Boolean(viaWebCrypto), `attempt ${attempt}`);
    if (viaJavaScript) assert.match(viaJavaScript.message, /^AES-CBC decryption failed \(invalid key or invalid PKCS#7 padding\)/);
  }
  assert.ok(refusedByWebCrypto > attempts * 0.9, `Web Crypto accepted ${attempts - refusedByWebCrypto} of ${attempts} wrong keys`);
  assert.equal(refusedInJavaScript, refusedByWebCrypto);
});

test("both paths refuse every damaged padding byte of a final block", async () => {
  const key = new Uint8Array(randomBytes(32));
  // 16 bytes of plaintext, so PKCS#7 adds a whole block of 0x10 and the file is exactly
  // IV | C1 (the plaintext block) | C2 (the padding block).
  const data = encrypt(Buffer.from(key), Buffer.alloc(16, 0x41));
  assert.equal(data.length, 48, "the fixture must be IV plus exactly two ciphertext blocks");
  const paddingBlock = data.length - 16;      // C2, which decrypts to the padding
  const previousBlock = paddingBlock - 16;    // C1, which CBC then XORs into it

  // The padding block is damaged through C1, not through C2 itself. In CBC the last
  // plaintext block is `P2 = D(C2) XOR C1`, so flipping bits in C1 flips exactly those
  // bits of P2 and leaves the rest of it alone: padding byte i becomes 0x10 ^ 0xff = 0xef,
  // which is never valid padding, for every i and for every key. Damaging C2 instead
  // would replace P2 with an unrelated block, which is valid PKCS#7 about 1 time in 256
  // (measured: 0.4% of single-byte flips) -- the same test, but passing by luck.
  for (let index = previousBlock; index < paddingBlock; index += 1) {
    const damaged = Uint8Array.from(data);
    damaged[index] ^= 0xff;
    // Only the last of these damages the length byte; the other fifteen leave it saying
    // 16 and corrupt a byte the padding claims to cover, so an unpadding step that reads
    // the length and nothing else accepts them and fails this test.
    await withWebCrypto(() => assert.rejects(decryptAesCbc(key, damaged), /AES-CBC decryption failed/, `Web Crypto, byte ${index}`));
    await withoutWebCrypto(() => assert.rejects(decryptAesCbc(key, damaged), /AES-CBC decryption failed/, `JavaScript, byte ${index}`));
  }
});

test("both paths reject malformed input the same way, before any key is used", async () => {
  const key = new Uint8Array(randomBytes(16));
  for (const [data, message] of [
    [new Uint8Array(15), /shorter than one IV block/],
    [new Uint8Array(16), /not a multiple of the 16-byte block size/],
    [new Uint8Array(20), /not a multiple of the 16-byte block size/]
  ]) {
    await withWebCrypto(() => assert.rejects(decryptAesCbc(key, data), message));
    await withoutWebCrypto(() => assert.rejects(decryptAesCbc(key, data), message));
  }
});
