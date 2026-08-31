/**
 * PDF Standard Security Handler, revision 3/4 -- password authentication and file
 * encryption key derivation, per PDF 32000-1:2008 §7.6.3 (Algorithms 2, 3, 4/5, and
 * 6/7 in the older 1.7 spec numbering: 3.2 "computing an encryption key", 3.5
 * "computing the /U value (revision 3 or greater)", 3.6 "authenticating the user
 * password", 3.3 "computing the /O value" and 3.7 "authenticating the owner
 * password"), plus Algorithm 1 §7.6.2's per-object key derivation.
 *
 * This module only *authenticates* and *derives keys*. It never decides what to do
 * with permissions (that is the caller's job -- see src/security/decrypt.js) and it
 * never re-derives a key for creating a *new* encrypted PDF (Algorithm 3.3's /O
 * computation is intentionally not implemented -- only checking an existing /O
 * against a candidate owner password is).
 *
 * Revision is accepted as a parameter rather than hard-coded so the algorithm itself
 * stays spec-accurate (it is identical for R3 and R4); the *caller* is responsible
 * for refusing anything other than R4, per this PR's deliberately narrow scope.
 */

import { md5 } from "./md5.js";
import { encodePdfDocPassword } from "./pdfdoc-encoding.js";
import { rc4 } from "./rc4.js";

// PDF spec 7.6.3.3, Algorithm 2, step (a): the fixed 32-byte padding string used to
// pad or truncate a password before hashing.
export const PASSWORD_PADDING = Uint8Array.of(
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
);

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Pads or truncates a password to exactly 32 bytes (PDF spec 7.6.3.3, Algorithm 2
 * step a). Passwords for revision <= 4 are PDFDocEncoding, not UTF-8 (revision 5+
 * uses UTF-8 for its own strings, but is out of this module's scope) -- see
 * src/security/pdfdoc-encoding.js. A character PDFDocEncoding cannot represent
 * throws, since the real password (whatever it is) must itself be representable.
 */
export function padPassword(password) {
  const bytes = encodePdfDocPassword(password ?? "");
  const result = new Uint8Array(32);
  const take = Math.min(bytes.length, 32);
  result.set(bytes.subarray(0, take));
  result.set(PASSWORD_PADDING.subarray(0, 32 - take), take);
  return result;
}

function pBytesLittleEndian(p) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, p, true);
  return bytes;
}

/**
 * Algorithm 2 (computing an encryption key / "file key") from a password already
 * padded to 32 bytes. `keyLengthBytes` is the target file key length (16 for the
 * 128-bit keys this PR's AESV2 scope always uses).
 */
export function computeFileKey({ paddedPassword, o, p, idBytes, revision, keyLengthBytes, encryptMetadata }) {
  const parts = [paddedPassword, o.subarray(0, 32), pBytesLittleEndian(p), idBytes];
  // Step (f): revision 4+ with /EncryptMetadata false hashes in four 0xFF bytes.
  if (revision >= 4 && encryptMetadata === false) parts.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  let hash = md5(concatBytes(parts));
  // Step (g): revision 3+ re-hashes the first keyLengthBytes of the digest 50 times.
  if (revision >= 3) {
    for (let iteration = 0; iteration < 50; iteration += 1) hash = md5(hash.subarray(0, keyLengthBytes));
  }
  return hash.slice(0, keyLengthBytes);
}

/** Algorithm 5 (computing /U, revision 3 or greater) from an already-derived file key. */
function computeUValue({ fileKey, idBytes }) {
  let encrypted = rc4(fileKey, md5(concatBytes([PASSWORD_PADDING, idBytes])));
  for (let iteration = 1; iteration <= 19; iteration += 1) {
    const iterationKey = fileKey.map((byte) => byte ^ iteration);
    encrypted = rc4(iterationKey, encrypted);
  }
  return encrypted; // 16 bytes; the real /U is this padded to 32 with arbitrary bytes.
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/**
 * Algorithm 6 (authenticating the user password, revision 3 or 4): derives a file
 * key from the candidate password and checks it reproduces the first 16 bytes of
 * the Encrypt dictionary's /U. Returns `{ success, fileKey }`; `fileKey` is `null`
 * on failure so a caller can never accidentally use an unauthenticated key.
 */
export function authenticateUserPassword({ password, o, u, p, idBytes, revision, keyLengthBytes, encryptMetadata }) {
  const fileKey = computeFileKey({ paddedPassword: padPassword(password), o, p, idBytes, revision, keyLengthBytes, encryptMetadata });
  const success = constantTimeEqual(computeUValue({ fileKey, idBytes }), u.subarray(0, 16));
  return { success, fileKey: success ? fileKey : null };
}

/** Algorithm 3 steps 1-4: an RC4 key derived from a (padded) owner password candidate. */
function computeOwnerRc4Key({ paddedOwnerPassword, revision, keyLengthBytes }) {
  let hash = md5(paddedOwnerPassword);
  if (revision >= 3) {
    for (let iteration = 0; iteration < 50; iteration += 1) hash = md5(hash.subarray(0, keyLengthBytes));
  }
  return hash.slice(0, keyLengthBytes);
}

/** Algorithm 7 step 2: recovers the padded user password bytes encoded in /O. */
function recoverPaddedUserPassword({ o, ownerRc4Key, revision }) {
  let data = o.slice(0, 32);
  if (revision >= 3) {
    for (let iteration = 19; iteration >= 0; iteration -= 1) {
      const iterationKey = ownerRc4Key.map((byte) => byte ^ iteration);
      data = rc4(iterationKey, data);
    }
  } else {
    data = rc4(ownerRc4Key, data);
  }
  return data;
}

/**
 * Algorithm 7 (authenticating the owner password, revision 3 or 4): recovers the
 * user password /O was built from and authenticates as if that were the user
 * password. Returns `{ success, fileKey }`, same shape as authenticateUserPassword.
 * This does not grant anything beyond that file key -- permission bits still apply
 * exactly as they do for a user-password login; see src/security/decrypt.js for why
 * this PR does not use owner authentication to bypass /P.
 */
export function authenticateOwnerPassword({ password, o, u, p, idBytes, revision, keyLengthBytes, encryptMetadata }) {
  const ownerRc4Key = computeOwnerRc4Key({ paddedOwnerPassword: padPassword(password), revision, keyLengthBytes });
  const recoveredUserPassword = recoverPaddedUserPassword({ o, ownerRc4Key, revision });
  const fileKey = computeFileKey({ paddedPassword: recoveredUserPassword, o, p, idBytes, revision, keyLengthBytes, encryptMetadata });
  const success = constantTimeEqual(computeUValue({ fileKey, idBytes }), u.subarray(0, 16));
  return { success, fileKey: success ? fileKey : null };
}

// PDF spec 7.6.2, Algorithm 1.A step (b): the fixed 4-byte salt AES crypt filters mix
// into the per-object key (ASCII "sAlT"), on top of Algorithm 1's RC4 object key.
const AES_OBJECT_KEY_SALT = Uint8Array.of(0x73, 0x41, 0x6c, 0x54);

/**
 * Algorithm 1 (deriving a per-object encryption key from the file key). `useAesSalt`
 * must be true for an AES crypt filter (AESV2/AESV3) and false for a plain RC4 one
 * -- the extra 4 "sAlT" bytes are AES-specific.
 */
export function deriveObjectKey({ fileKey, objectNumber, generation, useAesSalt }) {
  const extra = new Uint8Array(5 + (useAesSalt ? AES_OBJECT_KEY_SALT.length : 0));
  extra[0] = objectNumber & 0xff;
  extra[1] = (objectNumber >> 8) & 0xff;
  extra[2] = (objectNumber >> 16) & 0xff;
  extra[3] = generation & 0xff;
  extra[4] = (generation >> 8) & 0xff;
  if (useAesSalt) extra.set(AES_OBJECT_KEY_SALT, 5);
  const hash = md5(concatBytes([fileKey, extra]));
  return hash.slice(0, Math.min(fileKey.length + 5, 16));
}
