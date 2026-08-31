/**
 * PDF Standard Security Handler, revision 6 (`/Filter /Standard /V 5 /R 6`) --
 * password preprocessing, Algorithm 2.B (the revision 6 hardened hash), user/owner
 * password authentication and file-encryption-key recovery from /UE and /OE, and
 * /Perms validation. Based on ISO 32000-2:2020 §7.6.4.3 (Algorithm 2.A "Retrieving
 * the file encryption key from an encrypted document in order to decrypt it",
 * Algorithm 2.B "Computing a hash (revision 6 and later)") and §7.6.4.4.7-ish
 * ("Algorithm: Computing the encryption dictionary's Perms entry" -- described here
 * as validation, i.e. the same algorithm run in the decode direction). Cross-checked
 * against MuPDF's independently published implementation
 * (source/pdf/pdf-crypt.c, `pdf_compute_hardened_hash_r6` /
 * `pdf_compute_user_password_r6` / `pdf_compute_owner_password_r6` /
 * `pdf_compute_permissions_r6`) rather than transcribed from memory alone.
 *
 * This module only authenticates and derives keys -- like standard-r4.js, it never
 * decides what to do with permissions (the caller's job, see security/decrypt.js)
 * and never computes a *new* /O, /U, /OE, /UE, or /Perms for creating an encrypted
 * PDF (only verifying existing ones).
 *
 * Revision 6 is a completely different key-derivation scheme from revision 4's
 * (Algorithm 2/5/6/7, MD5 + RC4, trailer /ID-dependent): this module shares no code
 * with standard-r4.js, and deliberately does not import it, so a revision-6-specific
 * bug cannot leak into the still-shipping R4/AESV2 path or vice versa.
 */

import { aesCbcNoPaddingDecrypt, aesCbcNoPaddingEncrypt, aesEcbBlockDecrypt } from "./aes-primitives.js";

function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("Web Crypto API (crypto.subtle) is not available in this environment");
  return value;
}

async function digest(algorithm, bytes) {
  return new Uint8Array(await subtle().digest(algorithm, bytes));
}

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

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/* ------------------------------------------------------------------- password preprocessing */

// RFC 3454 Table B.1, "Commonly mapped to nothing" -- deleted from the password, not
// rejected (soft hyphen, Mongolian vowel separator, variation selectors, zero-width
// characters, ZWNBSP/BOM, ...).
const SASLPREP_MAP_TO_NOTHING = new Set([
  0x00ad, 0x034f, 0x1806, 0x180b, 0x180c, 0x180d, 0x200b, 0x200c, 0x200d, 0x2060,
  0xfe00, 0xfe01, 0xfe02, 0xfe03, 0xfe04, 0xfe05, 0xfe06, 0xfe07, 0xfe08, 0xfe09,
  0xfe0a, 0xfe0b, 0xfe0c, 0xfe0d, 0xfe0e, 0xfe0f, 0xfeff
]);

// RFC 3454 C.1.2, "Non-ASCII space characters" -- mapped to U+0020, not rejected.
const SASLPREP_SPACE_CODEPOINTS = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000
]);

/**
 * A codepoint this minimal SASLprep profile refuses to accept at all -- close to
 * (but not a byte-exact reimplementation of) RFC 3454's prohibited-output tables
 * C.2 (control characters), C.3 (private use), C.4 (noncharacters), C.5 (surrogate
 * codes), C.6 ("inappropriate for plain text", e.g. the replacement/object
 * replacement characters), C.8 (deprecated/bidi-format characters), and C.9
 * (tagging characters). This module does not carry the full Unicode Bidi_Class
 * table needed for RFC 3454 §6's actual bidirectional rule, so as a conservative
 * stand-in it also rejects any codepoint from a right-to-left script (Hebrew,
 * Arabic, Syriac, Thaana, N'Ko, and their presentation-form blocks) outright,
 * rather than risk a wrong bidi judgement for a password this profile cannot
 * really evaluate. See preprocessR6Password()'s docstring and the README for this
 * module's exact scope: ASCII and general left-to-right-script UTF-8 passwords are
 * fully handled; anything needing genuine bidi handling throws explicitly instead
 * of silently passing through as UTF-8 bytes.
 */
function isProhibitedSaslprepCodepoint(codePoint) {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true; // C.2.1/C.2.2 control
  if (codePoint === 0xfffd || codePoint === 0xfffc) return true; // C.6 specials
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true; // C.5 surrogate
  if ((codePoint & 0xfffe) === 0xfffe) return true; // noncharacters *FFFE/*FFFF, every plane
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return true; // C.4 noncharacters
  if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return true; // C.3 private use (BMP)
  if (codePoint >= 0xf0000 && codePoint <= 0xffffd) return true; // C.3 private use plane 15
  if (codePoint >= 0x100000 && codePoint <= 0x10fffd) return true; // C.3 private use plane 16
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true; // C.9 tags
  if (codePoint === 0x200e || codePoint === 0x200f) return true; // C.8 bidi marks
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true; // C.8 bidi embedding/override
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return true; // C.8 bidi isolates
  if (codePoint >= 0x206a && codePoint <= 0x206f) return true; // C.8 deprecated format chars
  if (codePoint >= 0x0590 && codePoint <= 0x08ff) return true; // RTL scripts (Hebrew..Arabic Ext-A)
  if (codePoint >= 0xfb1d && codePoint <= 0xfdff) return true; // Hebrew/Arabic presentation forms A
  if (codePoint >= 0xfe70 && codePoint <= 0xfeff) return true; // Arabic presentation forms B
  return false;
}

/**
 * A minimal SASLprep (RFC 4013) profile of stringprep (RFC 3454), scoped to what
 * ISO 32000-2's revision 6 password preprocessing actually needs to handle safely:
 * Table B.1 deletion, C.1.2 space mapping, Unicode NFKC normalization (via the
 * native `String.prototype.normalize`), then rejection of every prohibited-output
 * category listed on isProhibitedSaslprepCodepoint() above. This is NOT a full
 * RFC 3454 implementation (in particular, no real Bidi_Class-table-driven §6 rule) --
 * see that function's docstring for exactly what is and is not covered. A password
 * this profile cannot confidently handle throws, rather than being passed through
 * as if it had been correctly profiled (never "just UTF-8-encode it").
 */
export function saslprep(password) {
  const withoutMapToNothing = [...password].filter((character) => !SASLPREP_MAP_TO_NOTHING.has(character.codePointAt(0)));
  const spaceMapped = withoutMapToNothing
    .map((character) => (SASLPREP_SPACE_CODEPOINTS.has(character.codePointAt(0)) ? " " : character))
    .join("");
  const normalized = spaceMapped.normalize("NFKC");
  for (const character of normalized) {
    if (isProhibitedSaslprepCodepoint(character.codePointAt(0))) {
      throw new Error(
        "Password contains characters outside this implementation's minimal SASLprep (RFC 4013) profile " +
        "(only ASCII and general left-to-right-script UTF-8 passwords are supported)"
      );
    }
  }
  return normalized;
}

/**
 * Revision 6 password preprocessing (ISO 32000-2 §7.6.4.3.3): SASLprep, UTF-8
 * encode, then truncate to at most 127 bytes. Per spec this is a raw byte-length
 * truncation -- removing trailing bytes until the length is <=127 -- not a
 * codepoint-aware one; a longer password is expected to produce byte-identical
 * results across independent correct implementations only up to that exact byte
 * cut, so this deliberately does not "fix up" a truncation that lands mid-UTF-8
 * sequence.
 */
export function preprocessR6Password(password) {
  const profiled = saslprep(password ?? "");
  const bytes = new TextEncoder().encode(profiled);
  return bytes.length > 127 ? bytes.subarray(0, 127) : bytes;
}

/* --------------------------------------------------------------------------- Algorithm 2.B */

/**
 * Algorithm 2.B (ISO 32000-2 §7.6.4.3.4), the revision 6 hardened password hash.
 *
 * `passwordBytes` is already-preprocessed (preprocessR6Password()'s output, <=127
 * bytes). `salt` is the 8-byte validation or key salt taken from /U or /O.
 * `userKey48`, only for owner-password hashing, is the full 48-byte /U string
 * (never included for user-password hashing).
 *
 *   K = SHA-256(password || salt || [userKey48])
 *   repeat (at least 64 times):
 *     K1 = (password || K || [userKey48]) repeated 64 times
 *     E  = AES-128-CBC-encrypt(key = K[0:16], iv = K[16:32], K1)   -- no padding
 *     K  = SHA-256/384/512(E), selected by (sum of E's first 16 bytes) mod 3
 *   until round >= 64 and E's last byte <= round - 32
 *   return K[0:32]
 *
 * Never simplified to "hash ~64 times" -- the exact AES-128-CBC step (keyed by the
 * *current* K, not a fixed key), the hash-function selection, and the termination
 * condition are all part of what makes this hash "hardened"; approximating any of
 * them would produce a hash that does not match any real revision 6 PDF's /U or /O.
 */
export async function algorithm2B(passwordBytes, salt, userKey48 = null) {
  const initialInput = userKey48 ? [passwordBytes, salt, userKey48] : [passwordBytes, salt];
  let block = await digest("SHA-256", concatBytes(initialInput));
  let round = 0;
  let lastE;
  while (true) {
    const unit = userKey48 ? concatBytes([passwordBytes, block, userKey48]) : concatBytes([passwordBytes, block]);
    const k1 = concatBytes(new Array(64).fill(unit));
    const key = block.subarray(0, 16);
    const iv = block.subarray(16, 32);
    const e = aesCbcNoPaddingEncrypt(key, iv, k1);
    lastE = e;
    round += 1;

    let sum = 0;
    for (let index = 0; index < 16; index += 1) sum += e[index];
    const selector = sum % 3;
    if (selector === 0) block = await digest("SHA-256", e);
    else if (selector === 1) block = await digest("SHA-384", e);
    else block = await digest("SHA-512", e);

    if (round >= 64 && lastE[lastE.length - 1] <= round - 32) break;
  }
  return block.subarray(0, 32);
}

/* ---------------------------------------------------------- authentication + file key recovery */

function requireLength(bytes, expected, name) {
  if (!bytes || bytes.length !== expected) {
    throw new Error(`Malformed /${name}: expected ${expected} bytes, got ${bytes ? bytes.length : "none"}`);
  }
}

/**
 * Authenticates a candidate user password against /U (ISO 32000-2 Algorithm 2.A,
 * user-password branch) and, on success, recovers the 32-byte file encryption key
 * from /UE. /U is 48 bytes: [0:32) the validation hash, [32:40) the validation
 * salt, [40:48) the key salt (ISO 32000-2 §7.6.4.4.6/4.7's "Algorithm 8" layout).
 *
 * Recovering the file key: a second Algorithm 2.B run, keyed by the *key* salt
 * (not the validation salt), produces a 32-byte "intermediate key" used as an
 * AES-256 key -- zero IV, no padding -- to decrypt the 32-byte /UE into the actual
 * file encryption key. Never the reverse: a wrong intermediate key does not fail
 * loudly here (AES-CBC has no integrity check of its own), which is exactly why
 * /Perms is validated separately afterward (see validatePerms() below) rather than
 * this function's success alone being trusted as proof of the *right* key.
 */
export async function authenticateUserPasswordR6({ password, u, ue }) {
  requireLength(u, 48, "U");
  requireLength(ue, 32, "UE");
  const passwordBytes = preprocessR6Password(password);
  const validationSalt = u.subarray(32, 40);
  const keySalt = u.subarray(40, 48);
  const validationHash = await algorithm2B(passwordBytes, validationSalt, null);
  const success = constantTimeEqual(validationHash, u.subarray(0, 32));
  if (!success) return { success: false, fileKey: null };
  const intermediateKey = await algorithm2B(passwordBytes, keySalt, null);
  const fileKey = aesCbcNoPaddingDecrypt(intermediateKey, new Uint8Array(16), ue);
  return { success: true, fileKey };
}

/**
 * Authenticates a candidate owner password against /O and recovers the file
 * encryption key from /OE (ISO 32000-2 Algorithm 2.A, owner-password branch /
 * "Algorithm 9"). Identical structure to the user-password branch above, except
 * every Algorithm 2.B call additionally mixes in the full 48-byte /U string (per
 * spec -- owner-password hashing always includes it, user-password hashing never
 * does), and the salts/ciphertext come from /O/OE instead of /U/UE.
 */
export async function authenticateOwnerPasswordR6({ password, o, oe, u }) {
  requireLength(o, 48, "O");
  requireLength(oe, 32, "OE");
  requireLength(u, 48, "U");
  const passwordBytes = preprocessR6Password(password);
  const validationSalt = o.subarray(32, 40);
  const keySalt = o.subarray(40, 48);
  const validationHash = await algorithm2B(passwordBytes, validationSalt, u);
  const success = constantTimeEqual(validationHash, o.subarray(0, 32));
  if (!success) return { success: false, fileKey: null };
  const intermediateKey = await algorithm2B(passwordBytes, keySalt, u);
  const fileKey = aesCbcNoPaddingDecrypt(intermediateKey, new Uint8Array(16), oe);
  return { success: true, fileKey };
}

/* --------------------------------------------------------------------------------- /Perms */

const PERMS_MARKER = Uint8Array.of(0x61, 0x64, 0x62); // ASCII "adb"

/**
 * Validates /Perms against the recovered file encryption key (ISO 32000-2's
 * permissions-validation algorithm -- the decode direction of the same algorithm
 * MuPDF's `pdf_compute_permissions_r6` implements for encoding). /Perms is a single
 * 16-byte block, AES-256-encrypted with a zero IV and no padding -- since CBC with
 * a zero IV over exactly one block is the same operation as ECB for that block,
 * this is decrypted with a plain single-block AES-256 decrypt (aesEcbBlockDecrypt),
 * not the multi-block CBC-no-padding helper used for /UE and /OE.
 *
 * Decrypted layout (16 bytes): [0:4) /P as a little-endian 32-bit integer,
 * [4:8) the spec's fixed 0xFFFFFFFF extension-to-64-bits padding, [8] 'T'/'F' for
 * /EncryptMetadata, [9:12) the literal ASCII marker "adb", [12:16) random bytes the
 * spec says to ignore. Every field but the last is checked; a mismatch anywhere
 * throws immediately rather than being ignored -- successfully deriving *a* file
 * key (Algorithm 2.A's own hash comparison passing) is not, on its own, proof that
 * key is actually correct for *this* PDF's own recorded permissions, which is
 * exactly the failure mode this second, independent check exists to catch.
 */
export function validatePerms(fileKey, perms, p, encryptMetadata) {
  requireLength(perms, 16, "Perms");
  const decoded = aesEcbBlockDecrypt(fileKey, perms);

  const expectedP = new Uint8Array(4);
  new DataView(expectedP.buffer).setInt32(0, p, true);
  if (!constantTimeEqual(decoded.subarray(0, 4), expectedP)) {
    throw new Error("Authentication succeeded but /Perms validation failed (permission bytes do not match /P)");
  }
  if (decoded[4] !== 0xff || decoded[5] !== 0xff || decoded[6] !== 0xff || decoded[7] !== 0xff) {
    throw new Error("Authentication succeeded but /Perms validation failed (reserved bytes are not 0xFF)");
  }
  const expectedMetadataByte = encryptMetadata ? 0x54 : 0x46; // 'T' : 'F'
  if (decoded[8] !== expectedMetadataByte) {
    throw new Error("Authentication succeeded but /Perms validation failed (/EncryptMetadata mismatch)");
  }
  if (!constantTimeEqual(decoded.subarray(9, 12), PERMS_MARKER)) {
    throw new Error('Authentication succeeded but /Perms validation failed (missing "adb" marker)');
  }
}
