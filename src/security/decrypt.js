/**
 * Authenticates and decrypts a PDF's Standard Security Handler encryption, strictly
 * scoped to `/Filter /Standard /V 4 /R 4` with an `/AESV2` (or `/Identity`) crypt
 * filter -- the combination the real-world target PDF for this PR uses. Anything
 * else (a different /R, /V, /CFM, or a non-Standard handler) is refused up front
 * with a specific "Unsupported ..." reason, never silently guessed at or forced
 * through this algorithm.
 *
 * This module is the *only* place that decides what to do with a derived key: the
 * low-level algorithms live in standard-r4.js (auth/key derivation, no PDF
 * knowledge), md5.js/rc4.js/aes.js (raw crypto primitives, no PDF knowledge), and
 * src/encryption.js (read-only diagnosis, never touches key material). Splitting
 * it this way means a bug in "should this PDF be decrypted at all" cannot hide
 * inside "how is AES-CBC decrypted", and vice versa.
 */

import { directInteger } from "../pdf-structure.js";
import { booleanValue, nameValue, signedInteger, stringValue } from "../pdf-dictionary-text.js";
import { analyzeEncryption, parseCryptFilters } from "../encryption.js";
import { authenticateOwnerPassword, authenticateUserPassword, deriveObjectKey } from "./standard-r4.js";
import { decryptAesCbc } from "./aes.js";

const SUPPORTED_VERSION = 4;
const SUPPORTED_REVISION = 4;
const SUPPORTED_CFM = "AESV2";

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
  const p = signedInteger(dictionaryText, "P");
  const encryptMetadata = booleanValue(dictionaryText, "EncryptMetadata", true);
  const streamFilterName = nameValue(dictionaryText, "StmF") ?? "Identity";
  const stringFilterName = nameValue(dictionaryText, "StrF") ?? "Identity";
  const cryptFilters = new Map(parseCryptFilters(dictionaryText).map((filterEntry) => [filterEntry.name, filterEntry]));
  return {
    filter,
    version: Number.isInteger(versionRaw) ? versionRaw : null,
    revision: Number.isInteger(revisionRaw) ? revisionRaw : null,
    o, u, p, encryptMetadata, streamFilterName, stringFilterName, cryptFilters
  };
}

/**
 * Runs a candidate password through `authenticate` (authenticateUserPassword or
 * authenticateOwnerPassword), treating a PDFDocEncoding encoding failure (see
 * src/security/pdfdoc-encoding.js -- a character the candidate password contains
 * that PDFDocEncoding cannot represent) the same as "wrong password": the real
 * password, whatever it is, must itself have been representable when the document
 * was encrypted, so an unrepresentable candidate cannot be it either. This keeps
 * that failure recoverable (prompt again) rather than surfacing as an unrelated
 * crash.
 */
function tryAuthenticate(authenticate, authArgs) {
  try {
    return authenticate(authArgs);
  } catch {
    return { success: false, fileKey: null };
  }
}

/** Throws unless `filterName` is /Identity or an /AESV2 crypt filter -- the only two this PR decrypts. */
function checkCryptFilterInScope(filterName, cryptFilters, diagnosis) {
  if (filterName === "Identity") return;
  const filter = cryptFilters.get(filterName);
  if (!filter || filter.method !== SUPPORTED_CFM) {
    throw encryptionError(`Unsupported crypt filter method: ${filter?.method ?? filterName ?? "不明"}`, diagnosis);
  }
}

/**
 * Authenticates `structure`'s `/Encrypt` dictionary against `password` (default: the
 * empty string, so a caller can always try "no password" first -- most PDFs that
 * open without a prompt in a normal reader use an empty user password). Returns a
 * SecurityContext:
 *
 *   { authenticated, authType: "user" | "owner" | null, fileKey, modifyAllowed,
 *     permissions, streamFilterName, stringFilterName, cryptFilters, diagnosis }
 *
 * `authenticated: false` means the password was wrong -- a caller should prompt for
 * one and retry, not treat it as unsupported. Anything genuinely out of this PR's
 * scope (wrong /V, /R, /Filter, or /CFM) throws instead, since no password can fix
 * that.
 */
export function authenticateEncryptedPdf(structure, password) {
  const diagnosis = analyzeEncryption(structure);
  const dictionaryText = structure.object(structure.encryptReference).dictionary;
  const fields = readFields(dictionaryText);

  if (fields.filter !== "Standard") {
    throw encryptionError(`Standard以外のSecurity Handler: ${fields.filter ?? "不明"}`, diagnosis);
  }
  if (fields.version !== SUPPORTED_VERSION) {
    throw encryptionError(`Unsupported encrypted PDF version: V${fields.version ?? "不明"}（現在は /V ${SUPPORTED_VERSION} のみ対応）`, diagnosis);
  }
  if (fields.revision !== SUPPORTED_REVISION) {
    throw encryptionError(`Unsupported encrypted PDF revision: R${fields.revision ?? "不明"}（現在は /R ${SUPPORTED_REVISION} のみ対応）`, diagnosis);
  }
  checkCryptFilterInScope(fields.streamFilterName, fields.cryptFilters, diagnosis);
  checkCryptFilterInScope(fields.stringFilterName, fields.cryptFilters, diagnosis);
  if (!fields.o || !fields.u) throw encryptionError("Encrypt dictionary is missing /O or /U", diagnosis);
  if (!structure.idBytes) throw encryptionError("PDF trailer is missing /ID (required for Standard Security Handler authentication)", diagnosis);

  // AESV2 is defined as always using a 128-bit (16-byte) file key; when a crypt
  // filter is in use, prefer its own declared /Length (bytes) for robustness, but
  // this PR's AESV2-only scope means it is 16 either way.
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

  const userAttempt = tryAuthenticate(authenticateUserPassword, authArgs);
  const outcome = userAttempt.success ? { authType: "user", fileKey: userAttempt.fileKey } : (() => {
    const ownerAttempt = tryAuthenticate(authenticateOwnerPassword, authArgs);
    return ownerAttempt.success ? { authType: "owner", fileKey: ownerAttempt.fileKey } : null;
  })();

  if (!outcome) return { authenticated: false, authType: null, fileKey: null, diagnosis };

  return {
    authenticated: true,
    authType: outcome.authType,
    fileKey: outcome.fileKey,
    // Password authentication and /P permission are deliberately independent checks:
    // owner authentication recovers the same file key a user login would, and does
    // NOT grant modification rights this PR does not already compute from /P. See
    // README for why this PR does not treat "owner password known" as "editing
    // allowed" -- that would need a real, separate policy decision this PR does not
    // make on its own.
    modifyAllowed: diagnosis.permissions?.modify ?? false,
    permissions: diagnosis.permissions,
    streamFilterName: fields.streamFilterName,
    stringFilterName: fields.stringFilterName,
    cryptFilters: fields.cryptFilters,
    diagnosis
  };
}

async function decryptWithFilter(security, filterName, { objectNumber, generation, bytes }) {
  if (!filterName || filterName === "Identity") return bytes;
  const filter = security.cryptFilters.get(filterName);
  if (!filter || filter.method !== SUPPORTED_CFM) {
    throw encryptionError(`Unsupported crypt filter method: ${filter?.method ?? filterName}`, security.diagnosis);
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
