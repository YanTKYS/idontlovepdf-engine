import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_PADDING,
  authenticateOwnerPassword,
  authenticateUserPassword,
  computeFileKey,
  deriveObjectKey,
  padPassword
} from "../src/security/standard-r4.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const fromHex = (value) => Uint8Array.from(Buffer.from(value, "hex"));

/*
 * Fixture: a Standard/V4/R4/AESV2 Encrypt dictionary for an empty user password and
 * owner password "ownersecret", /P -44, and a fixed 16-byte /ID. /O, /U, and the
 * resulting file/object keys below were computed by an independent, hand-written
 * Python implementation of PDF spec Algorithms 1/2/3/5/7 (hashlib.md5 + a from-spec
 * RC4 -- no pypdf, no `cryptography` package, and no code shared with
 * src/security/*.js), then cross-checked here so this module's own test vectors are
 * not just testing the implementation against itself.
 */
const FIXTURE = {
  idBytes: fromHex("0123456789abcdef0123456789abcdef"),
  o: fromHex("0d94cdbff3096a459d7f0029d11691bd3f634199cc78e3dae85030e1b6545c89"),
  u: fromHex("0c991873079e1dec5112c49c43cb2b53"),
  p: -44,
  revision: 4,
  keyLengthBytes: 16,
  fileKeyHex: "19721e8a18b983ee5130f72620a31396",
  objectKeyObj4Gen0Hex: "d892bf276d5f0669fa7150882d07ca72",
  objectKeyObj4Gen1Hex: "5c3e81aab7e38171b2923631dca5b0eb",
  objectKeyObj9Gen0Hex: "7bf7f73d8e9dd945109ae9b992463377"
};

test("pads a password with the spec's fixed padding string, and truncates a long one", () => {
  assert.deepEqual(padPassword(""), PASSWORD_PADDING);
  const short = padPassword("abc");
  assert.equal(hex(short.subarray(0, 3)), Buffer.from("abc").toString("hex"));
  assert.deepEqual(short.subarray(3), PASSWORD_PADDING.subarray(0, 29));
  const exact32 = "x".repeat(32);
  assert.deepEqual(padPassword(exact32), new TextEncoder().encode(exact32));
  const tooLong = "y".repeat(40);
  assert.deepEqual(padPassword(tooLong), new TextEncoder().encode(tooLong).subarray(0, 32));
});

test("derives the expected file encryption key for an empty user password (Algorithm 2)", () => {
  const fileKey = computeFileKey({
    paddedPassword: padPassword(""),
    o: FIXTURE.o,
    p: FIXTURE.p,
    idBytes: FIXTURE.idBytes,
    revision: FIXTURE.revision,
    keyLengthBytes: FIXTURE.keyLengthBytes,
    encryptMetadata: true
  });
  assert.equal(hex(fileKey), FIXTURE.fileKeyHex);
});

test("authenticates the empty user password against a real /U value (Algorithm 6)", () => {
  const result = authenticateUserPassword({
    password: "",
    o: FIXTURE.o,
    u: FIXTURE.u,
    p: FIXTURE.p,
    idBytes: FIXTURE.idBytes,
    revision: FIXTURE.revision,
    keyLengthBytes: FIXTURE.keyLengthBytes,
    encryptMetadata: true
  });
  assert.equal(result.success, true);
  assert.equal(hex(result.fileKey), FIXTURE.fileKeyHex);
});

test("rejects a wrong user password explicitly, without a file key", () => {
  const result = authenticateUserPassword({
    password: "not the password",
    o: FIXTURE.o,
    u: FIXTURE.u,
    p: FIXTURE.p,
    idBytes: FIXTURE.idBytes,
    revision: FIXTURE.revision,
    keyLengthBytes: FIXTURE.keyLengthBytes,
    encryptMetadata: true
  });
  assert.equal(result.success, false);
  assert.equal(result.fileKey, null);
});

test("authenticates the correct owner password, recovering the same file key as the user login (Algorithm 7)", () => {
  const result = authenticateOwnerPassword({
    password: "ownersecret",
    o: FIXTURE.o,
    u: FIXTURE.u,
    p: FIXTURE.p,
    idBytes: FIXTURE.idBytes,
    revision: FIXTURE.revision,
    keyLengthBytes: FIXTURE.keyLengthBytes,
    encryptMetadata: true
  });
  assert.equal(result.success, true);
  assert.equal(hex(result.fileKey), FIXTURE.fileKeyHex);
});

test("rejects a wrong owner password explicitly, without a file key", () => {
  const result = authenticateOwnerPassword({
    password: "not the owner password",
    o: FIXTURE.o,
    u: FIXTURE.u,
    p: FIXTURE.p,
    idBytes: FIXTURE.idBytes,
    revision: FIXTURE.revision,
    keyLengthBytes: FIXTURE.keyLengthBytes,
    encryptMetadata: true
  });
  assert.equal(result.success, false);
  assert.equal(result.fileKey, null);
});

test("derives distinct, spec-matching per-object AES keys from object/generation numbers (Algorithm 1)", () => {
  const fileKey = fromHex(FIXTURE.fileKeyHex);
  const obj4gen0 = deriveObjectKey({ fileKey, objectNumber: 4, generation: 0, useAesSalt: true });
  const obj4gen1 = deriveObjectKey({ fileKey, objectNumber: 4, generation: 1, useAesSalt: true });
  const obj9gen0 = deriveObjectKey({ fileKey, objectNumber: 9, generation: 0, useAesSalt: true });
  assert.equal(hex(obj4gen0), FIXTURE.objectKeyObj4Gen0Hex);
  assert.equal(hex(obj4gen1), FIXTURE.objectKeyObj4Gen1Hex);
  assert.equal(hex(obj9gen0), FIXTURE.objectKeyObj9Gen0Hex);
  // Changing either the object number or the generation number alone must change
  // the derived key -- an object-key bug that ignored one of them would still pass
  // the fixed-vector checks above by coincidence if only one input ever varied.
  assert.notDeepEqual(obj4gen0, obj4gen1);
  assert.notDeepEqual(obj4gen0, obj9gen0);
});

test("a non-AES (plain RC4) crypt filter's object key omits the \"sAlT\" bytes, differing from AESV2's", () => {
  const fileKey = fromHex(FIXTURE.fileKeyHex);
  const withSalt = deriveObjectKey({ fileKey, objectNumber: 4, generation: 0, useAesSalt: true });
  const withoutSalt = deriveObjectKey({ fileKey, objectNumber: 4, generation: 0, useAesSalt: false });
  assert.notDeepEqual(withSalt, withoutSalt);
});
