/**
 * Low-level parsing helpers over an already-extracted PDF dictionary's *text* (the
 * byte-preserving decoded string form `PdfStructure` and `src/encryption.js`
 * already work with -- see `decodeBinaryString()`/`extractDictionary()` in
 * pdf-structure.js). These only understand PDF dictionary syntax; they know
 * nothing about encryption, diagnosis, or decryption, which is what lets both
 * `src/encryption.js` (diagnosis) and `src/security/decrypt.js`
 * (authentication/decryption) share one implementation instead of two that could
 * quietly drift apart (as the Crypt Filter `/Length` units bug showed -- a second,
 * separately-written copy of that parsing logic could easily reintroduce the same
 * mistake).
 *
 * `textToBytes()` below recovers each character's code point directly via
 * `charCodeAt()`. This is only byte-exact because pdf-structure.js decodes bytes to
 * text with `decodeBinaryString()` (equivalent to `String.fromCharCode` per byte),
 * NOT `TextDecoder("latin1")` -- despite the name, the WHATWG Encoding Standard
 * defines "latin1" as an alias for windows-1252, which remaps bytes 0x80-0x9F to
 * assorted non-ASCII code points instead of passing them through unchanged. Feeding
 * windows-1252-decoded text through `charCodeAt() & 0xff` would silently corrupt
 * any /O, /U, or /ID byte in that range -- exactly the values the Standard Security
 * Handler's authentication depends on being exact.
 */

import { readHex, readLiteral } from "./content-stream.js";

function textToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

export function nameValue(text, key) {
  return text.match(new RegExp(`/${key}\\s*/([A-Za-z0-9_.+-]+)`))?.[1] ?? null;
}

/** `/P` is a signed 32-bit integer (commonly negative -- see decodePermissions() in encryption.js). */
export function signedInteger(text, key) {
  const match = text.match(new RegExp(`/${key}\\s+([+-]?\\d+)(?!\\s+\\d+\\s+R)`, "s"));
  return match ? Number(match[1]) : null;
}

export function booleanValue(text, key, fallback) {
  const match = text.match(new RegExp(`/${key}\\s+(true|false)`));
  return match ? match[1] === "true" : fallback;
}

/**
 * Reads the full token following `/key` -- up to whitespace or a PDF delimiter, not
 * just a leading run of digits. A value like `12.5` or `12foo` must be rejected as a
 * whole rather than silently truncated to whatever digits happen to come first (the
 * more lenient `directInteger()` in pdf-structure.js, used for structural values
 * like /Size and /Prev, does exactly that truncation -- fine for values this parser
 * already trusts, but not for anything a malformed or hostile PDF controls more
 * directly). Returns `undefined` when `/key` is not present at all, so a caller can
 * tell "absent, use a default" apart from "present but malformed, reject" --
 * `parseStrictInteger()` below handles the latter.
 */
export function readToken(text, key) {
  if (!text) return undefined;
  const match = text.match(new RegExp(`/${key}\\s+([^\\s()<>\\[\\]{}/%]*)`));
  return match ? match[1] : undefined;
}

/** A PDF integer is an optionally signed digit sequence -- no decimal point, nothing else. */
export function parseStrictInteger(token) {
  if (!/^[+-]?\d+$/.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Extracts every top-level `/Name << ... >>` entry from `text` (e.g. each named
 * filter inside `/CF`), tracking `<<`/`>>` nesting depth so a filter's own nested
 * dictionaries don't confuse where it ends.
 */
export function namedSubDictionaries(text) {
  if (!text) return [];
  const results = [];
  const nameStart = /\/([A-Za-z0-9_.+-]+)\s*<</g;
  let match;
  while ((match = nameStart.exec(text))) {
    const name = match[1];
    const openIndex = nameStart.lastIndex - 2;
    let depth = 0;
    let cursor = openIndex;
    while (cursor < text.length) {
      if (text.startsWith("<<", cursor)) {
        depth += 1;
        cursor += 2;
      } else if (text.startsWith(">>", cursor)) {
        depth -= 1;
        cursor += 2;
        if (depth === 0) break;
      } else {
        cursor += 1;
      }
    }
    results.push({ name, text: text.slice(openIndex, cursor) });
    nameStart.lastIndex = cursor;
  }
  return results;
}

/** Same nesting-aware extraction as namedSubDictionaries(), but for one specific key. */
export function nestedDictionaryText(text, key) {
  const start = text.match(new RegExp(`/${key}\\s*<<`));
  if (!start) return null;
  const openIndex = start.index + start[0].length - 2;
  let depth = 0;
  let cursor = openIndex;
  while (cursor < text.length) {
    if (text.startsWith("<<", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith(">>", cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) break;
    } else {
      cursor += 1;
    }
  }
  return text.slice(openIndex, cursor);
}

/**
 * Delegates to content-stream.js's readLiteral()/readHex() -- the same PDF string
 * syntax (octal/named escapes, line continuation, hex whitespace) applies whether
 * the string is a Tj operand or an Encrypt/trailer dictionary value like /O, /U, or
 * /ID, and that implementation is exercised far more (by every content-stream
 * string in the existing test suite) than a second copy written only for this
 * module would be.
 */
function readStringToken(bytes, openIndex) {
  return bytes[openIndex] === 0x28 ? readLiteral(bytes, openIndex) : readHex(bytes, openIndex);
}

/**
 * Reads the literal-or-hex PDF string value of `/key ( ... )` or `/key < ... >` from
 * dictionary text, returning its raw bytes (not the decoded/escaped form used for
 * displaying text -- `/O` and `/U` are opaque 32-byte hash outputs, not readable
 * strings). Returns `null` when the key is absent or its value is not a string.
 */
export function stringValue(text, key) {
  const match = text.match(new RegExp(`/${key}\\s*([(<])`));
  if (!match || match[1] === "<" && text[match.index + match[0].length] === "<") return null;
  const bytes = textToBytes(text);
  const openIndex = match.index + match[0].length - 1;
  return readStringToken(bytes, openIndex).value;
}

/**
 * Reads the first element of the trailer's `/ID [ <...> <...> ]` array (the file
 * identifier the Standard Security Handler's key derivation hashes in). Returns
 * `null` when the trailer has no `/ID`.
 */
export function firstIdBytes(trailerText) {
  const match = trailerText.match(/\/ID\s*\[\s*([(<])/);
  if (!match) return null;
  const bytes = textToBytes(trailerText);
  const openIndex = match.index + match[0].length - 1;
  return readStringToken(bytes, openIndex).value;
}
