/**
 * Diagnostic (read-only) analysis of a PDF's `/Encrypt` dictionary.
 *
 * This module identifies *what* encryption a PDF declares — Security Handler,
 * `/V`/`/R`, crypt filters, permission bits — so a human can decide whether adding
 * real decryption support is worth doing. It never decrypts anything: no key
 * derivation, no password handling, no RC4/AES. A value this module cannot read
 * from the dictionary is reported as absent (`null`) rather than guessed.
 *
 * DOM-free and Node-free: `analyzeEncryption()` only needs an object shaped like
 * `PdfStructure` (`encryptReference` plus a synchronous `object(refOrNumber)` that
 * returns `{ dictionary }`), so it works equally against a real PdfStructure or a
 * small fixture built for a test.
 */

import { directInteger } from "./pdf-structure.js";
import { booleanValue, nameValue, namedSubDictionaries, nestedDictionaryText, signedInteger } from "./pdf-dictionary-text.js";

/** Human-readable family for a /CFM crypt filter method. Diagnostic label only. */
function cfmLabel(cfm) {
  switch (cfm) {
    case "None": return "暗号化なし（Crypt Filter経由の平文）";
    case "V2": return "RC4系";
    case "AESV2": return "AES-128系";
    case "AESV3": return "AES-256系";
    default: return null;
  }
}

/**
 * A crypt filter dictionary's own `/Length` is in **bytes** (PDF spec 7.6.5, Table
 * 25) — unlike the Encrypt dictionary's top-level `/Length`, which is in **bits**
 * (7.6.3.2, Table 20). Reporting both units explicitly here avoids a caller ever
 * printing the raw byte count next to a "bit" label, which would understate the key
 * size by 8x (e.g. AESV2's `/Length 16` is a 128-bit key, not a 16-bit one).
 */
export function parseCryptFilters(dictionaryText) {
  const cfText = nestedDictionaryText(dictionaryText, "CF");
  if (!cfText) return [];
  return namedSubDictionaries(cfText).map(({ name, text }) => {
    const method = nameValue(text, "CFM");
    const lengthRaw = directInteger(text, "Length");
    const lengthBytes = Number.isInteger(lengthRaw) ? lengthRaw : null;
    return {
      name,
      method,
      methodLabel: method ? cfmLabel(method) : null,
      lengthBytes,
      lengthBits: lengthBytes === null ? null : lengthBytes * 8,
      authEvent: nameValue(text, "AuthEvent")
    };
  });
}

/**
 * Bit positions from the PDF spec's /P permission table (7.6.3.2, Table 22). Bit N
 * (1-indexed from the LSB) has value 2^(N-1); bits 9-12 only apply from revision 3
 * on — for revision 2 those positions are reserved and must not be interpreted.
 */
const PERMISSION_BITS = {
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  extractForAccessibility: 1 << 9,
  assembleDocument: 1 << 10,
  printHighQuality: 1 << 11
};

/**
 * Decodes /P into named permissions. `p` is read as a signed 32-bit integer (per
 * the spec) so the reserved high bits, which are conventionally all 1, do not need
 * special handling — JavaScript's `&` already treats it as int32. Permissions that
 * only exist from revision 3 onward are `null` ("not applicable") under revision 2,
 * rather than reading bits the spec does not assign a meaning to there.
 */
function decodePermissions(p, revision) {
  if (typeof p !== "number" || !Number.isInteger(p)) return null;
  const has = (mask) => Boolean(p & mask);
  const permissions = {
    print: has(PERMISSION_BITS.print),
    modify: has(PERMISSION_BITS.modify),
    copy: has(PERMISSION_BITS.copy),
    annotate: has(PERMISSION_BITS.annotate),
    fillForms: null,
    extractForAccessibility: null,
    assembleDocument: null,
    printHighQuality: null
  };
  if (Number.isInteger(revision) && revision >= 3) {
    permissions.fillForms = has(PERMISSION_BITS.fillForms);
    permissions.extractForAccessibility = has(PERMISSION_BITS.extractForAccessibility);
    permissions.assembleDocument = has(PERMISSION_BITS.assembleDocument);
    permissions.printHighQuality = has(PERMISSION_BITS.printHighQuality);
  }
  return permissions;
}

/**
 * A best-effort label combining /V, /R, and (for /V 4) the stream crypt filter's
 * /CFM into the encryption family a human would recognise. Kept separate from the
 * dictionary's own fields (filter/version/revision/cryptFilters) so a UI can show
 * "確定できる情報" (what the dictionary actually says) and "推定" (this label)
 * as two distinct things, per the diagnostic's whole point.
 */
function estimateMethod(version, cryptFilters, streamFilterName) {
  if (version === 1) return "Standard Security Handler / RC4-40";
  if (version === 2) return "Standard Security Handler / RC4（可変長鍵）";
  if (version === 4 || version === 5) {
    const streamFilter = cryptFilters.find((filter) => filter.name === streamFilterName);
    if (streamFilter?.methodLabel) return `Standard Security Handler / ${streamFilter.methodLabel}`;
    // /V 5 always means a 256-bit AES key by spec, even when /CF/StmF cannot be
    // read for some reason -- unlike /V 4, where the family genuinely depends on
    // the (here unreadable) crypt filter and nothing can be assumed.
    return version === 5 ? "Standard Security Handler / AES-256系" : null;
  }
  return null;
}

/**
 * Reads and diagnoses `structure`'s `/Encrypt` dictionary, if any. Returns
 * `{ encrypted: false }` when there is none. Never throws for a recognised but
 * unsupported Security Handler — that is reported via `standardHandler: false`
 * with the Standard-only fields left `null`, not an exception. Malformed data
 * that keeps a field from being read also produces `null` there, never a guess.
 */
export function analyzeEncryption(structure) {
  if (!structure.encryptReference) return { encrypted: false };

  const dictionaryText = structure.object(structure.encryptReference).dictionary;
  const filter = nameValue(dictionaryText, "Filter");
  const standardHandler = filter === "Standard";

  const versionRaw = directInteger(dictionaryText, "V");
  const version = Number.isInteger(versionRaw) ? versionRaw : null;
  const revisionRaw = directInteger(dictionaryText, "R");
  const revision = Number.isInteger(revisionRaw) ? revisionRaw : null;
  const lengthRaw = directInteger(dictionaryText, "Length");

  const base = {
    encrypted: true,
    filter,
    subFilter: nameValue(dictionaryText, "SubFilter"),
    standardHandler,
    version,
    revision
  };

  if (!standardHandler) {
    // A non-Standard handler (e.g. /Adobe.PubSec for public-key security) uses a
    // different structure for permissions and crypt filters; interpreting /P or
    // /CF as if they were Standard's would misreport them, so this stops here.
    return {
      ...base,
      lengthBits: Number.isInteger(lengthRaw) ? lengthRaw : null,
      lengthBitsSource: Number.isInteger(lengthRaw) ? "explicit" : "unspecified",
      permissionsRaw: null,
      permissions: null,
      streamFilter: null,
      stringFilter: null,
      encryptMetadata: null,
      cryptFilters: [],
      estimatedMethod: null
    };
  }

  // The top-level /Length's spec default of 40 bits only applies to algorithm codes
  // 1 and 2 (/V 1 or 2, plain RC4). Under /V 4 or 5 the actual key length comes from
  // the crypt filter in /CF (or is fixed at 256 for /V 5), so an absent /Length
  // there means "not stated here", not "40" -- defaulting to 40 regardless of /V
  // would misreport an AES-128/AES-256 key as 40-bit RC4.
  let lengthBits;
  let lengthBitsSource;
  if (Number.isInteger(lengthRaw)) {
    lengthBits = lengthRaw;
    lengthBitsSource = "explicit";
  } else if (version === 1 || version === 2) {
    lengthBits = 40;
    lengthBitsSource = "default";
  } else {
    lengthBits = null;
    lengthBitsSource = "unspecified";
  }

  const permissionsRaw = signedInteger(dictionaryText, "P");
  const cryptFilters = version === 4 || version === 5 ? parseCryptFilters(dictionaryText) : [];
  const streamFilter = nameValue(dictionaryText, "StmF");
  const stringFilter = nameValue(dictionaryText, "StrF");

  return {
    ...base,
    lengthBits,
    lengthBitsSource,
    permissionsRaw,
    permissions: decodePermissions(permissionsRaw, revision),
    streamFilter,
    stringFilter,
    encryptFileFilter: nameValue(dictionaryText, "EFF"),
    encryptMetadata: booleanValue(dictionaryText, "EncryptMetadata", true),
    cryptFilters,
    estimatedMethod: estimateMethod(version, cryptFilters, streamFilter)
  };
}

/**
 * A short, parenthetical summary used to enrich the "encrypted PDF" error message
 * (see src/pdf-document.js) — e.g. "Standard / AESV2 / R4", or for a non-Standard
 * handler, "Standard以外のSecurity Handler: Adobe.PubSec".
 */
export function summarizeEncryption(diagnosis) {
  if (!diagnosis.encrypted) return null;
  if (!diagnosis.standardHandler) {
    return `Standard以外のSecurity Handler: ${diagnosis.filter ?? "不明"}`;
  }
  const parts = ["Standard"];
  const methodLabel = diagnosis.cryptFilters.find((filter) => filter.name === diagnosis.streamFilter)?.methodLabel;
  if (diagnosis.version === 1 || diagnosis.version === 2) parts.push("RC4");
  else if (methodLabel) parts.push(methodLabel.replace("系", ""));
  if (Number.isInteger(diagnosis.revision)) parts.push(`R${diagnosis.revision}`);
  return parts.join(" / ");
}
