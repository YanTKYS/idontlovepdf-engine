/**
 * Authenticates and decrypts a PDF's Standard Security Handler encryption, strictly
 * scoped to the two configurations this engine has actually needed against a real
 * PDF: `/Filter /Standard /V 4 /R 4` with an `/AESV2` (or `/Identity`) crypt filter,
 * and `/Filter /Standard /V 5 /R 6` with an `/AESV3` (or `/Identity`) crypt filter.
 * Anything else (a different /R, /V, /CFM, or a non-Standard handler) is refused up
 * front with a specific "Unsupported ..." reason, never silently guessed at or
 * forced through either algorithm.
 *
 * This module is the *only* place that decides what to do with a derived key and
 * which revision's algorithm to run: the low-level algorithms live in
 * standard-r4.js (R4 auth/key derivation, MD5 + RC4, no PDF knowledge) and
 * standard-r6.js (R6 auth/key derivation, Algorithm 2.B + AES, no PDF knowledge),
 * md5.js/rc4.js/aes.js/aes-primitives.js (raw crypto primitives, no PDF knowledge),
 * and src/encryption.js (read-only diagnosis, never touches key material).
 * Splitting it this way means a bug in "should this PDF be decrypted at all" cannot
 * hide inside "how is AES-CBC decrypted", and a revision-6-specific bug cannot leak
 * into the still-shipping R4/AESV2 path (standard-r4.js and standard-r6.js share no
 * code and are never called from within each other).
 */

import { directInteger } from "../pdf-structure.js";
import { booleanValue, nameValue, signedInteger, stringValue } from "../pdf-dictionary-text.js";
import { analyzeEncryption, parseCryptFilters } from "../encryption.js";
import { authenticateOwnerPassword, authenticateUserPassword, deriveObjectKey } from "./standard-r4.js";
import { authenticateOwnerPasswordR6, authenticateUserPasswordR6, validatePerms } from "./standard-r6.js";
import { decryptAesCbc } from "./aes.js";

/** An error whose message always starts with the existing "encrypted PDF" prefix, so
 * classifyError() in the browser PoC keeps recognising it as an encryption failure
 * (see web/poc-core.js) without the ad-hoc scope reasons below needing their own
 * separate classification pattern. */
function encryptionError(reason, diagnosis) {
  const error = new Error(`Encrypted PDFs are not supported (${reason})`);
  error.encryptionDiagnosis = diagnosis;
  return error;
}

function readFields(dictionaryText) {
  const filter = nameValue(dictionaryText, "Filter");
  const versionRaw = directInteger(dictionaryText, "V");
  const revisionRaw = directInteger(dictionaryText, "R");
  const o = stringValue(dictionaryText, "O");
  const u = stringValue(dictionaryText, "U");
  const oe = stringValue(dictionaryText, "OE");
  const ue = stringValue(dictionaryText, "UE");
  const perms = stringValue(dictionaryText, "Perms");
  const p = signedInteger(dictionaryText, "P");
  const encryptMetadata = booleanValue(dictionaryText, "EncryptMetadata", true);
  const streamFilterName = nameValue(dictionaryText, "StmF") ?? "Identity";
  const stringFilterName = nameValue(dictionaryText, "StrF") ?? "Identity";
  const cryptFilters = new Map(parseCryptFilters(dictionaryText).map((filterEntry) => [filterEntry.name, filterEntry]));
  return {
    filter,
    version: Number.isInteger(versionRaw) ? versionRaw : null,
    revision: Number.isInteger(revisionRaw) ? revisionRaw : null,
    o, u, oe, ue, perms, p, encryptMetadata, streamFilterName, stringFilterName, cryptFilters
  };
}

/**
 * Runs a candidate password through `authenticate`, treating any thrown error the
 * same as "wrong password" (recoverable: prompt again), never letting it escape as
 * an unrelated crash. For R4 this mainly catches a PDFDocEncoding encoding failure
 * (see src/security/pdfdoc-encoding.js -- a character the candidate password
 * contains that PDFDocEncoding cannot represent: the real password, whatever it is,
 * must itself have been representable, so an unrepresentable candidate cannot be
 * it). For R6 it mainly catches this module's minimal SASLprep profile rejecting a
 * candidate password's characters (see standard-r6.js) -- same reasoning.
 * `authenticate` may be sync (R4) or async (R6, since Algorithm 2.B hashes via
 * `crypto.subtle`); `await`ing either works uniformly.
 */
async function tryAuthenticate(authenticate, authArgs) {
  try {
    return await authenticate(authArgs);
  } catch {
    return { success: false, fileKey: null };
  }
}

/** Which revisions/versions this module actually authenticates, and which crypt
 * filter method each one requires -- deliberately not "any AESV2" or "any AESV3",
 * since e.g. a /V 5 PDF using /R 5 (Adobe's original, pre-ISO AES-256 extension,
 * different key derivation) is out of this scope just as much as a wrong /CFM is. */
const SUPPORTED_CONFIGURATIONS = [
  { version: 4, revision: 4, cfm: "AESV2" },
  { version: 5, revision: 6, cfm: "AESV3" }
];

function matchConfiguration(version, revision) {
  return SUPPORTED_CONFIGURATIONS.find((entry) => entry.version === version && entry.revision === revision) ?? null;
}

/** Throws unless `filterName` is /Identity or a crypt filter using `configuration`'s required /CFM. */
function checkCryptFilterInScope(filterName, cryptFilters, configuration, diagnosis) {
  if (filterName === "Identity") return;
  const filter = cryptFilters.get(filterName);
  if (!filter || filter.method !== configuration.cfm) {
    throw encryptionError(`Unsupported crypt filter method: ${filter?.method ?? filterName ?? "不明"}`, diagnosis);
  }
}

async function authenticateR4({ fields, structure, password, diagnosis }) {
  if (!fields.o || !fields.u) throw encryptionError("Encrypt dictionary is missing /O or /U", diagnosis);
  if (!structure.idBytes) throw encryptionError("PDF trailer is missing /ID (required for Standard Security Handler R4 authentication)", diagnosis);

  // AESV2 is defined as always using a 128-bit (16-byte) file key; when a crypt
  // filter is in use, prefer its own declared /Length (bytes) for robustness, but
  // this scope's AESV2-only reach means it is 16 either way.
  const activeFilter = fields.cryptFilters.get(fields.streamFilterName) ?? fields.cryptFilters.get(fields.stringFilterName);
  const keyLengthBytes = activeFilter?.lengthBytes ?? 16;

  const authArgs = {
    password: password ?? "",
    o: fields.o,
    u: fields.u,
    p: fields.p,
    idBytes: structure.idBytes,
    revision: fields.revision,
    keyLengthBytes,
    encryptMetadata: fields.encryptMetadata
  };

  const userAttempt = await tryAuthenticate(authenticateUserPassword, authArgs);
  if (userAttempt.success) return { authType: "user", fileKey: userAttempt.fileKey };
  const ownerAttempt = await tryAuthenticate(authenticateOwnerPassword, authArgs);
  if (ownerAttempt.success) return { authType: "owner", fileKey: ownerAttempt.fileKey };
  return null;
}

/**
 * Revision 6's /O, /U, /OE, /UE, /Perms are each a fixed, exact byte length (ISO
 * 32000-2 §7.6.4.4.6-4.4.8); a PDF whose Encrypt dictionary has one of these fields
 * at any other length is malformed (or the field is missing outright, read as
 * `null` by stringValue()) -- never truncated or otherwise guessed at to fit.
 */
function requireR6FieldLength(bytes, expectedLength, name, diagnosis) {
  if (!bytes || bytes.length !== expectedLength) {
    throw encryptionError(`Malformed /${name}: expected ${expectedLength} bytes, got ${bytes ? bytes.length : "none"}`, diagnosis);
  }
  return bytes;
}

async function authenticateR6({ fields, password, diagnosis }) {
  const o = requireR6FieldLength(fields.o, 48, "O", diagnosis);
  const u = requireR6FieldLength(fields.u, 48, "U", diagnosis);
  const oe = requireR6FieldLength(fields.oe, 32, "OE", diagnosis);
  const ue = requireR6FieldLength(fields.ue, 32, "UE", diagnosis);
  const perms = requireR6FieldLength(fields.perms, 16, "Perms", diagnosis);

  const userAttempt = await tryAuthenticate(authenticateUserPasswordR6, { password: password ?? "", u, ue });
  const outcome = userAttempt.success
    ? { authType: "user", fileKey: userAttempt.fileKey }
    : await (async () => {
      const ownerAttempt = await tryAuthenticate(authenticateOwnerPasswordR6, { password: password ?? "", o, oe, u });
      return ownerAttempt.success ? { authType: "owner", fileKey: ownerAttempt.fileKey } : null;
    })();
  if (!outcome) return null;

  // A password hash matching /U or /O is not, on its own, proof that the recovered
  // file key is actually the right one for *this* PDF's own recorded permissions --
  // see validatePerms()'s docstring in standard-r6.js. Unlike a wrong password (a
  // recoverable "prompt again" case), a Perms mismatch after successful password
  // authentication means something is inconsistent about the PDF or the recovered
  // key itself; this never silently continues to decrypt content with that key.
  validatePerms(outcome.fileKey, perms, fields.p, fields.encryptMetadata);
  return outcome;
}

/**
 * Authenticates `structure`'s `/Encrypt` dictionary against `password` (default: the
 * empty string, so a caller can always try "no password" first -- most PDFs that
 * open without a prompt in a normal reader use an empty user password). Returns a
 * SecurityContext:
 *
 *   { authenticated, authType: "user" | "owner" | null, fileKey, modifyAllowed,
 *     permissions, streamFilterName, stringFilterName, cryptFilters, diagnosis,
 *     revision, encryptionMethod }
 *
 * `authenticated: false` means the password was wrong -- a caller should prompt for
 * one and retry, not treat it as unsupported. Anything genuinely out of this scope
 * (wrong /V, /R, /Filter, or /CFM) throws instead, since no password can fix that;
 * so does a revision 6 PDF whose /Perms fails to validate after a successful
 * password (see authenticateR6() above) -- also not a "wrong password" case.
 *
 * Async because revision 6 authentication hashes via `crypto.subtle` (Algorithm
 * 2.B); revision 4 authentication itself stays synchronous under the hood
 * (MD5/RC4, no Web Crypto), so this only actually awaits anything on that path.
 */
export async function authenticateEncryptedPdf(structure, password) {
  const diagnosis = analyzeEncryption(structure);
  const dictionaryText = structure.object(structure.encryptReference).dictionary;
  const fields = readFields(dictionaryText);

  if (fields.filter !== "Standard") {
    throw encryptionError(`Standard以外のSecurity Handler: ${fields.filter ?? "不明"}`, diagnosis);
  }
  const configuration = matchConfiguration(fields.version, fields.revision);
  if (!configuration) {
    const supportedList = SUPPORTED_CONFIGURATIONS.map((entry) => `V${entry.version}/R${entry.revision}`).join(", ");
    throw encryptionError(
      `Unsupported encrypted PDF version/revision: V${fields.version ?? "不明"}/R${fields.revision ?? "不明"}（現在は ${supportedList} のみ対応）`,
      diagnosis
    );
  }
  checkCryptFilterInScope(fields.streamFilterName, fields.cryptFilters, configuration, diagnosis);
  checkCryptFilterInScope(fields.stringFilterName, fields.cryptFilters, configuration, diagnosis);

  const outcome = configuration.revision === 4
    ? await authenticateR4({ fields, structure, password, diagnosis })
    : await authenticateR6({ fields, password, diagnosis });

  if (!outcome) return { authenticated: false, authType: null, fileKey: null, diagnosis };

  return {
    authenticated: true,
    authType: outcome.authType,
    fileKey: outcome.fileKey,
    // Password authentication and /P permission are deliberately independent checks:
    // owner authentication recovers the same file key a user login would, and does
    // NOT grant modification rights this engine does not already compute from /P
    // (revision 6 treats user and owner passwords equivalently for *access*, per
    // spec, but that is still not the same thing as this engine choosing to bypass
    // /P for an owner login -- it does not). See README for why owner
    // authentication never bypasses /P here.
    modifyAllowed: diagnosis.permissions?.modify ?? false,
    permissions: diagnosis.permissions,
    streamFilterName: fields.streamFilterName,
    stringFilterName: fields.stringFilterName,
    cryptFilters: fields.cryptFilters,
    diagnosis,
    revision: configuration.revision,
    encryptionMethod: configuration.cfm
  };
}

/**
 * Decrypts one stream/string object's raw bytes via the crypt filter named
 * `filterName` (Identity: unchanged). Dispatches on `security.encryptionMethod`:
 *
 *   AESV2 (R4): derive a *per-object* key from the file key (Algorithm 1 + the AES
 *   salt -- see standard-r4.js's deriveObjectKey()), then AES-CBC decrypt with it.
 *
 *   AESV3 (R6): decrypt directly with the 32-byte file encryption key itself -- ISO
 *   32000-2 no longer derives a per-object key for AESV3 at all; ignoring that and
 *   still calling deriveObjectKey() would silently decrypt every object with the
 *   wrong key and either fail loudly (unlikely -- CBC has no built-in integrity
 *   check) or, worse, "succeed" into corrupted plaintext. Object number/generation
 *   play no role here.
 *
 * Both directions still lay stream/string bytes out the same way on disk (`IV (16
 * bytes) || AES-CBC ciphertext`, real PKCS#7 padding), so both reuse the same
 * decryptAesCbc() (src/security/aes.js, Web Crypto) -- only the *key* differs.
 */
async function decryptWithFilter(security, filterName, { objectNumber, generation, bytes }) {
  if (!filterName || filterName === "Identity") return bytes;
  const filter = security.cryptFilters.get(filterName);
  if (!filter || filter.method !== security.encryptionMethod) {
    throw encryptionError(`Unsupported crypt filter method: ${filter?.method ?? filterName}`, security.diagnosis);
  }
  if (security.encryptionMethod === "AESV3") {
    return decryptAesCbc(security.fileKey, bytes);
  }
  const objectKey = deriveObjectKey({ fileKey: security.fileKey, objectNumber, generation, useAesSalt: true });
  return decryptAesCbc(objectKey, bytes);
}

/** Decrypts one stream object's raw bytes via /StmF, or returns them unchanged under /Identity. */
export function decryptStreamBytes(security, { objectNumber, generation, bytes }) {
  return decryptWithFilter(security, security.streamFilterName, { objectNumber, generation, bytes });
}

/** Decrypts one PDF string object's raw bytes via /StrF, or returns them unchanged under /Identity. */
export function decryptStringBytes(security, { objectNumber, generation, bytes }) {
  return decryptWithFilter(security, security.stringFilterName, { objectNumber, generation, bytes });
}
