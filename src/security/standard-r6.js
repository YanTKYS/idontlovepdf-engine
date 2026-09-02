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
import { sha2 } from "../sha2.js";

// Algorithm 2.B's three hashes, via src/sha2.js: Web Crypto where the page has it, and
// JavaScript where it does not -- a page served over plain HTTP has no `crypto.subtle`,
// and an encrypted PDF has to open there too. See the note in that module.
const digest = sha2;

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
// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are NOT in this table --
// RFC 3454 lists them under C.2.2 (non-ASCII control characters) instead, so they
// must be *rejected*, not silently turned into a plain space; see
// isProhibitedSaslprepCodepoint() below, which is where they are actually handled
// (as General_Category Zl/Zp, alongside the rest of C.2.2).
const SASLPREP_SPACE_CODEPOINTS = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000
]);

// General Unicode categories that cover, more completely and more reliably than a
// hand-copied RFC 3454 codepoint table would, the bulk of RFC 3454's Appendix C
// prohibited-output categories:
//   Cc - control characters (C.2.1 ASCII + C.2.2 non-ASCII, e.g. U+0080-U+009F)
//   Cf - format characters (most of C.2.2's non-ASCII controls, e.g. U+180E, U+06DD,
//        U+2061-U+2063, U+FFF9-U+FFFB; most of C.8's deprecated/bidi-format
//        characters, e.g. U+200E/U+200F, U+202A-U+202E; all of C.9's tag characters)
//   Co - private use (C.3, all planes)
//   Cs - surrogate codes (C.5)
//   Cn - unassigned, which includes every Unicode noncharacter (C.4) as a subset,
//        plus any codepoint not yet assigned a meaning at all (rejecting those too
//        is conservative, never less strict than RFC 3454 requires)
//   Zl/Zp - U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR (part of C.2.2, but
//        General_Category Zl/Zp rather than Cc/Cf, so not covered by those above)
// Deriving this from the JS engine's own actively-maintained Unicode Character
// Database avoids the risk inherent in hand-transcribing RFC 3454's tables: a
// transcription can silently go stale or miss entries (as an earlier version of
// this file did -- U+2028/U+2029 were wrongly listed as C.1.2 spaces above instead
// of being rejected, and codepoints like U+180E, U+2061-U+2063, and U+1D173-U+1D17A
// were not rejected by the old table-based check at all).
const PROHIBITED_UNICODE_CATEGORY = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u;

/**
 * A codepoint this minimal SASLprep profile refuses to accept at all. Combines the
 * general-category check above (covering RFC 3454 C.2/C.3/C.4/C.5, and the Cf-
 * category members of C.6/C.8/C.9) with the handful of prohibited codepoints that
 * general-category checks cannot catch because Unicode does not classify them as
 * control/format/private-use/surrogate/unassigned:
 *   - U+FFFC OBJECT REPLACEMENT CHARACTER / U+FFFD REPLACEMENT CHARACTER (RFC 3454
 *     C.6; General_Category So, not Cf)
 * This module does not carry the full Unicode Bidi_Class table needed for RFC 3454
 * §6's actual bidirectional rule, so as a conservative stand-in it also rejects any
 * codepoint from a right-to-left script (Hebrew, Arabic, Syriac, Thaana, N'Ko, and
 * their presentation-form blocks) outright, rather than risk a wrong bidi judgement
 * for a password this profile cannot really evaluate -- these RTL blocks are this
 * module's own addition, not part of RFC 3454's C tables. See
 * preprocessR6Password()'s docstring and the README for this module's exact scope:
 * ASCII and general left-to-right-script UTF-8 passwords are handled; anything
 * needing genuine bidi handling throws explicitly instead of silently passing
 * through as UTF-8 bytes.
 *
 * Two RFC 3454 categories need no explicit check here at all, because
 * `.normalize("NFKC")` (applied before this function ever runs) has already made
 * their codepoints unreachable:
 *   - C.8's U+0340/U+0341 (deprecated combining tone marks) each have a canonical
 *     decomposition mapping (to U+0300/U+0301), so NFKC always replaces them.
 *   - C.7, the entire Hangul Compatibility Jamo block U+3131-U+318E ("inappropriate
 *     for canonical representation"): every one of its 94 codepoints has a
 *     compatibility decomposition mapping to the ordinary Hangul Jamo block
 *     (U+1100-U+11FF), so NFKC always replaces them too -- verified directly
 *     (`test/standard-r6.test.js`) rather than assumed. The two unassigned
 *     codepoints at the block's edges, U+3130 and U+318F, have no such mapping and
 *     do reach this function, but are already caught by the `\p{Cn}` (unassigned)
 *     branch of the general-category check above.
 */
function isProhibitedSaslprepCodepoint(codePoint) {
  const character = String.fromCodePoint(codePoint);
  if (PROHIBITED_UNICODE_CATEGORY.test(character)) return true;
  if (codePoint === 0xfffc || codePoint === 0xfffd) return true;
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

// ISO 32000-2 fixes /O and /U at exactly 48 bytes. Some real-world PDF writers
// instead pad them to a fixed, longer buffer size with trailing 0x00 bytes -- a
// PDF this engine has actually needed to open used 127 bytes (48 valid bytes plus
// 79 zero bytes). This is NOT stringprep/SASLprep padding and has nothing to do
// with the password: it is purely a quirk of how some writers serialize these two
// particular fixed-size binary strings. `zeroPaddingCompatibilityLimit` bounds how
// far this compatibility reading extends -- past it, a long /O or /U is malformed,
// never silently truncated.
const R6_VALIDATION_ENTRY_LENGTH = 48;
const R6_VALIDATION_ENTRY_ZERO_PADDING_LIMIT = 128;

/**
 * Normalizes a raw /O or /U value to the spec's 48 bytes, accepting -- and ONLY
 * accepting -- one specific, narrow compatibility form on top of the exact-48-byte
 * case: a longer buffer (49 to 128 bytes) whose bytes from index 48 onward are
 * entirely 0x00. Anything else (shorter than 48, longer than 128, or a 49-128 byte
 * value with even one non-zero trailing byte) is rejected explicitly -- this is
 * deliberately not "trim trailing NUL bytes" as a general string operation, which
 * would risk quietly corrupting a genuinely different value that just happens to
 * end in 0x00; it only ever discards bytes past position 48 once every one of them
 * has already been confirmed to be exactly 0x00.
 *
 * This normalization is intentionally scoped to /O and /U alone (see the docstrings
 * on authenticateUserPasswordR6()/authenticateOwnerPasswordR6() below for where
 * it's applied) -- /OE, /UE, and /Perms keep their own strict, non-negotiable
 * requireLength() checks (32, 32, 16 bytes) elsewhere in this module, R4's /O and
 * /U are a completely different code path (standard-r4.js) this function is never
 * called from, and nothing calls this from the general-purpose PDF string parser
 * (src/pdf-dictionary-text.js) at all -- padding tolerance is a revision-6-specific,
 * /O//U-specific compatibility decision, not a general "trim trailing NUL" rule
 * that every PDF binary string would then silently be subject to.
 *
 * Returns `{ bytes, rawLength, normalizedLength, zeroPaddingCompatibilityApplied }`
 * -- `bytes` is always exactly 48 bytes (a subarray view onto the input, not a
 * copy, and never mutated in place); the other three fields are metadata a caller
 * may surface for diagnostics (e.g. "/U: 127 bytes -> 48 bytes, zero-padding
 * compatibility applied"), not anything security-sensitive on their own.
 */
export function normalizeR6ValidationEntry(bytes, name) {
  if (!bytes || bytes.length < R6_VALIDATION_ENTRY_LENGTH) {
    throw new Error(`Malformed /${name}: expected 48 bytes, got ${bytes ? bytes.length : "none"}`);
  }
  if (bytes.length === R6_VALIDATION_ENTRY_LENGTH) {
    return { bytes, rawLength: 48, normalizedLength: 48, zeroPaddingCompatibilityApplied: false };
  }
  if (bytes.length > R6_VALIDATION_ENTRY_ZERO_PADDING_LIMIT) {
    throw new Error(
      `Malformed /${name}: expected 48 bytes, got ${bytes.length} ` +
      `(exceeds the ${R6_VALIDATION_ENTRY_ZERO_PADDING_LIMIT}-byte zero-padding compatibility limit)`
    );
  }
  const tail = bytes.subarray(R6_VALIDATION_ENTRY_LENGTH);
  if (!tail.every((byte) => byte === 0)) {
    throw new Error(
      `Malformed /${name}: expected 48 bytes, got ${bytes.length} with non-zero trailing bytes ` +
      "(not a recognized zero-padding compatibility form)"
    );
  }
  return {
    bytes: bytes.subarray(0, R6_VALIDATION_ENTRY_LENGTH),
    rawLength: bytes.length,
    normalizedLength: 48,
    zeroPaddingCompatibilityApplied: true
  };
}

/**
 * Authenticates a candidate user password against /U (ISO 32000-2 Algorithm 2.A,
 * user-password branch) and, on success, recovers the 32-byte file encryption key
 * from /UE. `u` is normalized to 48 bytes first (see normalizeR6ValidationEntry()
 * above -- accepting the one specific zero-padded compatibility form some real PDF
 * writers use, on top of the exact-48-byte case); the resulting 48-byte value is
 * then read per spec: [0:32) the validation hash, [32:40) the validation salt,
 * [40:48) the key salt (ISO 32000-2 §7.6.4.4.6/4.7's "Algorithm 8" layout). `ue`
 * keeps its own strict, non-negotiable 32-byte check -- no padding tolerance.
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
  const normalizedU = normalizeR6ValidationEntry(u, "U").bytes;
  requireLength(ue, 32, "UE");
  const passwordBytes = preprocessR6Password(password);
  const validationSalt = normalizedU.subarray(32, 40);
  const keySalt = normalizedU.subarray(40, 48);
  const validationHash = await algorithm2B(passwordBytes, validationSalt, null);
  const success = constantTimeEqual(validationHash, normalizedU.subarray(0, 32));
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
 *
 * Both `o` and `u` go through normalizeR6ValidationEntry() before use -- `u` too,
 * and this matters: a raw, still zero-padded 127/128-byte /U mixed directly into
 * Algorithm 2.B (instead of its normalized 48-byte form) would compute a hash that
 * matches neither this PDF's real /O (owner-hash mismatch, so owner authentication
 * would simply fail even with the right password) nor, via /OE, the right file
 * key. `oe` keeps its own strict 32-byte check, same as the user branch's `ue`.
 */
export async function authenticateOwnerPasswordR6({ password, o, oe, u }) {
  const normalizedO = normalizeR6ValidationEntry(o, "O").bytes;
  const normalizedU = normalizeR6ValidationEntry(u, "U").bytes;
  requireLength(oe, 32, "OE");
  const passwordBytes = preprocessR6Password(password);
  const validationSalt = normalizedO.subarray(32, 40);
  const keySalt = normalizedO.subarray(40, 48);
  const validationHash = await algorithm2B(passwordBytes, validationSalt, normalizedU);
  const success = constantTimeEqual(validationHash, normalizedO.subarray(0, 32));
  if (!success) return { success: false, fileKey: null };
  const intermediateKey = await algorithm2B(passwordBytes, keySalt, normalizedU);
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
