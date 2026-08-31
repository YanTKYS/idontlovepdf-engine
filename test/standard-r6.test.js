import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  algorithm2B,
  authenticateOwnerPasswordR6,
  authenticateUserPasswordR6,
  preprocessR6Password,
  saslprep,
  validatePerms
} from "../src/security/standard-r6.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const encode = (value) => new TextEncoder().encode(value);

/* ---------------------------------------------------------- independent Algorithm 2.B */
/* Built only from node:crypto (SHA-256/384/512 + AES-128-CBC no padding via
 * setAutoPadding(false)) -- no code shared with src/security/standard-r6.js -- so this
 * file's fixtures are not produced by (and therefore cannot be masked by a bug in) the
 * very implementation they check. Mirrors the independent-implementation convention
 * already used throughout this repo's test suite (test/standard-r4.test.js,
 * test/pdf-decrypt.test.js, test/object-stream-resolve.test.js, ...). */

function concat(chunks) {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function independentAlgorithm2B(passwordBytes, salt, userKey48) {
  const initial = userKey48 ? concat([passwordBytes, salt, userKey48]) : concat([passwordBytes, salt]);
  let block = createHash("sha256").update(initial).digest();
  let round = 0;
  let lastE;
  while (true) {
    const unit = userKey48 ? concat([passwordBytes, block, userKey48]) : concat([passwordBytes, block]);
    const k1 = Buffer.concat(new Array(64).fill(unit));
    const cipher = createCipheriv("aes-128-cbc", block.subarray(0, 16), block.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    lastE = e;
    round += 1;
    let sum = 0;
    for (let index = 0; index < 16; index += 1) sum += e[index];
    const algorithm = ["sha256", "sha384", "sha512"][sum % 3];
    block = createHash(algorithm).update(e).digest();
    if (round >= 64 && lastE[lastE.length - 1] <= round - 32) break;
  }
  return block.subarray(0, 32);
}

function independentUE(passwordBytes, keySalt, fileKey) {
  const intermediateKey = independentAlgorithm2B(passwordBytes, keySalt, null);
  const cipher = createCipheriv("aes-256-cbc", intermediateKey, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(fileKey), cipher.final()]);
}

function buildUserFixture(passwordBytes, fileKey) {
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);
  const validationHash = independentAlgorithm2B(passwordBytes, validationSalt, null);
  const u = Buffer.concat([validationHash, validationSalt, keySalt]);
  const ue = independentUE(passwordBytes, keySalt, fileKey);
  return { u, ue };
}

function buildOwnerFixture(passwordBytes, userKey48, fileKey) {
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);
  const validationHash = independentAlgorithm2B(passwordBytes, validationSalt, userKey48);
  const o = Buffer.concat([validationHash, validationSalt, keySalt]);
  const intermediateKey = independentAlgorithm2B(passwordBytes, keySalt, userKey48);
  const cipher = createCipheriv("aes-256-cbc", intermediateKey, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const oe = Buffer.concat([cipher.update(fileKey), cipher.final()]);
  return { o, oe };
}

function buildPerms(fileKey, p, encryptMetadata) {
  const buffer = Buffer.alloc(16);
  buffer.writeInt32LE(p, 0);
  buffer.writeUInt32LE(0xffffffff, 4);
  buffer[8] = encryptMetadata ? 0x54 : 0x46;
  buffer[9] = 0x61; // 'a'
  buffer[10] = 0x64; // 'd'
  buffer[11] = 0x62; // 'b'
  randomBytes(4).copy(buffer, 12);
  const cipher = createCipheriv("aes-256-ecb", fileKey, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

/* ------------------------------------------------------------------------- Algorithm 2.B */

test("Algorithm 2.B (user branch, no userKey48) matches an independent node:crypto implementation", async () => {
  for (let trial = 0; trial < 8; trial += 1) {
    const password = trial === 0 ? new Uint8Array(0) : randomBytes(1 + trial * 3);
    const salt = randomBytes(8);
    const mine = await algorithm2B(password, salt, null);
    assert.equal(hex(mine), independentAlgorithm2B(password, salt, null).toString("hex"), `trial ${trial}`);
  }
});

test("Algorithm 2.B (owner branch, with the full 48-byte /U) matches an independent implementation", async () => {
  for (let trial = 0; trial < 8; trial += 1) {
    const password = randomBytes(1 + trial * 4);
    const salt = randomBytes(8);
    const userKey48 = randomBytes(48);
    const mine = await algorithm2B(password, salt, userKey48);
    assert.equal(hex(mine), independentAlgorithm2B(password, salt, userKey48).toString("hex"), `trial ${trial}`);
  }
});

test("Algorithm 2.B user branch and owner branch (with the same password/salt) diverge once userKey48 is mixed in", async () => {
  const password = encode("shared-password");
  const salt = randomBytes(8);
  const userHash = await algorithm2B(password, salt, null);
  const ownerHash = await algorithm2B(password, salt, randomBytes(48));
  assert.notEqual(hex(userHash), hex(ownerHash));
});

/* ------------------------------------------------------------------------ password preprocessing */

test("preprocesses an empty password to zero bytes", () => {
  assert.equal(preprocessR6Password("").length, 0);
  assert.equal(preprocessR6Password(undefined).length, 0);
});

test("preprocesses an ASCII password to its own UTF-8 bytes unchanged", () => {
  assert.deepEqual(preprocessR6Password("hello123"), encode("hello123"));
});

test("preprocesses a general UTF-8 (non-RTL) password via NFKC and UTF-8 encoding", () => {
  // "café" (NFC) and "café" (NFD, e + combining acute) must normalize (NFKC)
  // to the same byte sequence -- this is exactly what SASLprep's normalization step
  // is for: two different Unicode encodings of "the same" password must produce the
  // same file key, not two different ones a real user would find inexplicable.
  const nfc = preprocessR6Password("café");
  const nfd = preprocessR6Password("café");
  assert.deepEqual(nfc, nfd);
  assert.deepEqual(nfc, encode("café"));
});

test("truncates a password to 127 raw UTF-8 bytes, not code points", () => {
  const exact = "x".repeat(127);
  assert.equal(preprocessR6Password(exact).length, 127);
  const tooLong = "x".repeat(200);
  const truncated = preprocessR6Password(tooLong);
  assert.equal(truncated.length, 127);
  assert.deepEqual(truncated, encode(exact));
});

test("deletes RFC 3454 Table B.1 'commonly mapped to nothing' characters", () => {
  // U+00AD SOFT HYPHEN is deleted entirely, not treated as a real character.
  assert.deepEqual(preprocessR6Password("pass­word"), encode("password"));
});

test("maps RFC 3454 C.1.2 non-ASCII space characters to U+0020", () => {
  // U+00A0 NO-BREAK SPACE maps to a plain space.
  assert.deepEqual(preprocessR6Password("a b"), encode("a b"));
});

test("saslprep() rejects prohibited-output characters explicitly instead of passing them through", () => {
  assert.throws(() => saslprep(`pass${String.fromCodePoint(0)}word`), /SASLprep/); // C.2 control character
  assert.throws(() => saslprep("pass�word"), /SASLprep/); // C.6 replacement character
  assert.throws(() => saslprep("password"), /SASLprep/); // C.3 private use
});

test("rejects a right-to-left-script password as outside this module's minimal SASLprep profile", () => {
  // This module documents that it does not implement RFC 3454's real Bidi_Class-
  // table-driven rule, and conservatively refuses RTL-script passwords outright
  // rather than risk a wrong bidi judgement -- see standard-r6.js's docstring.
  assert.throws(() => saslprep("אבג"), /SASLprep/); // Hebrew
  assert.throws(() => saslprep("ابج"), /SASLprep/); // Arabic
});

test("rejects U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR instead of mapping them to a space", () => {
  // RFC 3454 lists these under C.2.2 (non-ASCII control characters), not C.1.2
  // (non-ASCII space characters) -- an earlier version of this file's space table
  // wrongly included them, which would have silently turned "a<LS>b" into the
  // password "a b" instead of rejecting it outright.
  assert.throws(() => saslprep(`a${String.fromCodePoint(0x2028)}b`), /SASLprep/);
  assert.throws(() => saslprep(`a${String.fromCodePoint(0x2029)}b`), /SASLprep/);
});

test("rejects further RFC 3454 C.2.2/C.6 characters not caught by a hand-copied table", () => {
  // These specific codepoints were named in review as gaps in an earlier,
  // hand-transcribed prohibited-codepoint table; the current implementation derives
  // most of C.2/C.3/C.4/C.5 from Unicode's own General_Category via a regex
  // (\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}) specifically so gaps like these
  // cannot recur silently.
  assert.throws(() => saslprep(String.fromCodePoint(0x180e)), /SASLprep/); // C.2.2 Mongolian vowel separator
  assert.throws(() => saslprep(String.fromCodePoint(0x06dd)), /SASLprep/); // C.2.2 Arabic end of ayah
  assert.throws(() => saslprep(String.fromCodePoint(0x2061)), /SASLprep/); // C.2.2 function application
  assert.throws(() => saslprep(String.fromCodePoint(0xfff9)), /SASLprep/); // C.2.2/C.6 interlinear annotation anchor
  assert.throws(() => saslprep(String.fromCodePoint(0x1d173)), /SASLprep/); // C.2.2 musical notation format (astral)
});

test("C.7 Hangul Compatibility Jamo needs no explicit rejection: NFKC always resolves it to ordinary Hangul Jamo first", () => {
  // Every one of the 94 assigned codepoints in U+3131-U+318E canonically
  // decomposes (under NFKC) to the U+1100-U+11FF Hangul Jamo block, so none of
  // them can still be U+3131-U+318E by the time isProhibitedSaslprepCodepoint()
  // runs -- verified here directly, not merely assumed, since standard-r6.js's own
  // docstring relies on this claim to justify not carrying an explicit C.7 check.
  for (let codePoint = 0x3131; codePoint <= 0x318e; codePoint += 1) {
    const normalized = String.fromCodePoint(codePoint).normalize("NFKC");
    assert.notEqual(normalized.codePointAt(0), codePoint, `U+${codePoint.toString(16)} should be transformed by NFKC`);
  }
  // The two unassigned codepoints at the block's edges are not compatibility jamo
  // (no decomposition mapping) and do reach the check -- but as unassigned
  // codepoints they are already caught by the general Unicode-category check.
  assert.throws(() => saslprep(String.fromCodePoint(0x3130)), /SASLprep/);
  assert.throws(() => saslprep(String.fromCodePoint(0x318f)), /SASLprep/);
});

test("accepts an ordinary space (U+0020) and a mapped non-ASCII space unaffected by the C.2.2 fix", () => {
  assert.deepEqual(saslprep("a b"), "a b");
  assert.equal(saslprep(`a${String.fromCodePoint(0x00a0)}b`), "a b"); // NBSP -> space
});

/* -------------------------------------------------------------------- user password authentication */

test("authenticates a correct user password and recovers the file encryption key from /UE", async () => {
  const password = encode("correct horse battery staple");
  const fileKey = randomBytes(32);
  const { u, ue } = buildUserFixture(password, fileKey);
  const result = await authenticateUserPasswordR6({ password: "correct horse battery staple", u, ue });
  assert.equal(result.success, true);
  assert.equal(hex(result.fileKey), hex(fileKey));
});

test("authenticates a correct EMPTY user password", async () => {
  // An empty password is tried as a genuine Algorithm 2.A/2.B candidate, not assumed
  // "no password" just because a normal reader might open the PDF without prompting.
  const fileKey = randomBytes(32);
  const { u, ue } = buildUserFixture(new Uint8Array(0), fileKey);
  const result = await authenticateUserPasswordR6({ password: "", u, ue });
  assert.equal(result.success, true);
  assert.equal(hex(result.fileKey), hex(fileKey));
});

test("rejects a wrong user password without deriving a usable file key", async () => {
  const fileKey = randomBytes(32);
  const { u, ue } = buildUserFixture(encode("right-password"), fileKey);
  const result = await authenticateUserPasswordR6({ password: "wrong-password", u, ue });
  assert.equal(result.success, false);
  assert.equal(result.fileKey, null);
});

test("rejects malformed /U or /UE lengths explicitly", async () => {
  const fileKey = randomBytes(32);
  const { u, ue } = buildUserFixture(encode("pw"), fileKey);
  await assert.rejects(authenticateUserPasswordR6({ password: "pw", u: u.subarray(0, 40), ue }), /Malformed \/U/);
  await assert.rejects(authenticateUserPasswordR6({ password: "pw", u, ue: ue.subarray(0, 16) }), /Malformed \/UE/);
});

/* ------------------------------------------------------------------- owner password authentication */

test("authenticates a correct owner password and recovers the file encryption key from /OE", async () => {
  const password = encode("owner-secret");
  const userKey48 = randomBytes(48);
  const fileKey = randomBytes(32);
  const { o, oe } = buildOwnerFixture(password, userKey48, fileKey);
  const result = await authenticateOwnerPasswordR6({ password: "owner-secret", o, oe, u: userKey48 });
  assert.equal(result.success, true);
  assert.equal(hex(result.fileKey), hex(fileKey));
});

test("rejects a wrong owner password", async () => {
  const userKey48 = randomBytes(48);
  const fileKey = randomBytes(32);
  const { o, oe } = buildOwnerFixture(encode("right"), userKey48, fileKey);
  const result = await authenticateOwnerPasswordR6({ password: "wrong", o, oe, u: userKey48 });
  assert.equal(result.success, false);
  assert.equal(result.fileKey, null);
});

test("owner authentication with the wrong /U (the mixed-in user key) fails even with the right password", async () => {
  const password = encode("right-owner-password");
  const fileKey = randomBytes(32);
  const { o, oe } = buildOwnerFixture(password, randomBytes(48), fileKey);
  const result = await authenticateOwnerPasswordR6({ password: "right-owner-password", o, oe, u: randomBytes(48) });
  assert.equal(result.success, false);
});

/* ---------------------------------------------------------------------------------- /Perms */

test("validates well-formed /Perms without throwing", () => {
  const fileKey = randomBytes(32);
  const perms = buildPerms(fileKey, -3904, true);
  assert.doesNotThrow(() => validatePerms(fileKey, perms, -3904, true));
});

test("rejects /Perms whose permission bytes do not match /P", () => {
  const fileKey = randomBytes(32);
  const perms = buildPerms(fileKey, -3904, true);
  assert.throws(() => validatePerms(fileKey, perms, -44, true), /permission bytes do not match/);
});

test("rejects /Perms whose /EncryptMetadata byte does not match", () => {
  const fileKey = randomBytes(32);
  const perms = buildPerms(fileKey, -3904, true);
  assert.throws(() => validatePerms(fileKey, perms, -3904, false), /EncryptMetadata mismatch/);
});

test("rejects /Perms with a corrupted 'adb' marker", () => {
  const fileKey = randomBytes(32);
  const perms = Buffer.from(buildPerms(fileKey, -3904, true));
  // Corrupt the marker bytes in the *decrypted* plaintext by re-encrypting a broken block.
  const plain = Buffer.alloc(16);
  plain.writeInt32LE(-3904, 0);
  plain.writeUInt32LE(0xffffffff, 4);
  plain[8] = 0x54;
  plain[9] = 0x78; // corrupted marker
  plain[10] = 0x64;
  plain[11] = 0x62;
  const cipher = createCipheriv("aes-256-ecb", fileKey, null);
  cipher.setAutoPadding(false);
  const corrupted = Buffer.concat([cipher.update(plain), cipher.final()]);
  assert.notEqual(corrupted.toString("hex"), perms.toString("hex"));
  assert.throws(() => validatePerms(fileKey, corrupted, -3904, true), /"adb" marker/);
});

test("rejects /Perms with corrupted reserved bytes", () => {
  const fileKey = randomBytes(32);
  const plain = Buffer.alloc(16);
  plain.writeInt32LE(-3904, 0);
  plain.writeUInt32LE(0x00000000, 4); // should be 0xFFFFFFFF
  plain[8] = 0x54;
  plain[9] = 0x61;
  plain[10] = 0x64;
  plain[11] = 0x62;
  const cipher = createCipheriv("aes-256-ecb", fileKey, null);
  cipher.setAutoPadding(false);
  const perms = Buffer.concat([cipher.update(plain), cipher.final()]);
  assert.throws(() => validatePerms(fileKey, perms, -3904, true), /reserved bytes/);
});

test("rejects a malformed /Perms length", () => {
  const fileKey = randomBytes(32);
  assert.throws(() => validatePerms(fileKey, randomBytes(15), -3904, true), /Malformed \/Perms/);
});
