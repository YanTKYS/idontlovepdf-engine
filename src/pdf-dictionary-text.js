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

import { isRegular, skipWhite } from "./syntax.js";
import { readHex, readLiteral, skipArray, skipDictionary } from "./content-stream.js";

function textToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function bytesToText(bytes, start, end) {
  let result = "";
  for (let index = start; index < end; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

/**
 * Skips exactly one PDF object value starting at `start` (which must already be
 * past any leading whitespace/comments): a name, a literal or hex string, an
 * array, a dictionary, or a number -- including the three-token `N G R` indirect
 * reference form, which is a single value even though it is not a single token.
 * Used only by topLevelValueOffset() below, to advance past a key's value when
 * that value is NOT the key being searched for, so the next name token read is
 * always genuinely the *next key*, never mistaken for one just because it happens
 * to look like a name (e.g. a value of `/Length` for some unrelated key `/Foo`).
 */
function skipOneValue(bytes, start) {
  if (bytes[start] === 0x3c && bytes[start + 1] === 0x3c) return skipDictionary(bytes, start);
  if (bytes[start] === 0x5b) return skipArray(bytes, start);
  if (bytes[start] === 0x28) return readLiteral(bytes, start).end;
  if (bytes[start] === 0x3c) return readHex(bytes, start).end;
  if (bytes[start] === 0x2f) {
    let cursor = start + 1;
    while (isRegular(bytes[cursor])) cursor += 1;
    return cursor;
  }
  if (isRegular(bytes[start])) {
    let cursor = start;
    while (cursor < bytes.length && isRegular(bytes[cursor])) cursor += 1;
    // Only a bare non-negative integer can be the object-number half of an
    // indirect reference ("5 0 R") -- check whether this token is followed by a
    // second integer and then the literal "R" keyword; if so, the whole
    // three-token sequence is one value, not just the first number.
    if (/^\d+$/.test(bytesToText(bytes, start, cursor))) {
      const secondStart = skipWhite(bytes, cursor);
      let secondEnd = secondStart;
      while (secondEnd < bytes.length && isRegular(bytes[secondEnd])) secondEnd += 1;
      if (/^\d+$/.test(bytesToText(bytes, secondStart, secondEnd))) {
        const rStart = skipWhite(bytes, secondEnd);
        if (bytes[rStart] === 0x52 && !isRegular(bytes[rStart + 1])) return rStart + 1; // 'R'
      }
    }
    return cursor;
  }
  // A delimiter where a value was expected (malformed dictionary text) -- advance
  // by one byte so the scan can never get stuck rather than trying to recover a
  // meaningful value from it.
  return start + 1;
}

/**
 * Locates the byte offset where `/key`'s value begins, considering only an
 * occurrence that appears directly inside `text` itself as a genuine key -- depth
 * 0 relative to `text`'s own outer `<< >>`, and, within that depth, only a name
 * token in *key position* (immediately followed by exactly one value, per PDF
 * dictionary syntax), never a name that happens to appear as some other key's
 * *value* (e.g. `/Foo /Length` -- the `/Length` there is /Foo's value, not a key
 * named /Length). Achieves this by walking the dictionary strictly as alternating
 * key/value pairs: read a name (the key), skip exactly one value (skipOneValue()
 * above) unless that key is the one being searched for, repeat. Also skips over
 * anything nested one level deeper regardless of key/value position: a nested
 * dictionary (e.g. a Crypt Filter sub-dictionary), an array, a literal string, or
 * a hex string.
 *
 * This is what makes a key like /Length safe to read from an Encrypt dictionary
 * that also has a /CF sub-dictionary with its own /Length: a plain whole-text
 * search finds whichever `/Length` happens to come first in the raw bytes, nested
 * or not -- which silently returns the Crypt Filter's key length in *bytes*
 * instead of the Encrypt dictionary's own top-level /Length in *bits* whenever the
 * sub-dictionary happens to be written first, as a real PDF this engine needed to
 * open does (`/CF << /StdCF << ... /Length 32 >> >> /Length 256`).
 *
 * `text` must be a full dictionary including its own outer `<< >>`, as
 * PdfStructure#object()'s `.dictionary` and this module's own
 * nestedDictionaryText()/namedSubDictionaries() results always are. Returns
 * `undefined` when `/key` does not appear at the top level at all (whether or not
 * it appears nested, or as some other key's value, somewhere) -- the caller reads
 * the value itself starting from the returned offset (a full integer token for
 * topLevelInteger() below, or any other shape a future caller needs).
 */
export function topLevelValueOffset(text, key) {
  const bytes = textToBytes(text);
  if (bytes[0] !== 0x3c || bytes[1] !== 0x3c) return undefined;
  const keyToken = `/${key}`;
  let cursor = 2;
  while (true) {
    cursor = skipWhite(bytes, cursor);
    if (cursor >= bytes.length || (bytes[cursor] === 0x3e && bytes[cursor + 1] === 0x3e)) return undefined; // this dictionary's own end
    if (bytes[cursor] !== 0x2f) {
      // Not a name where a key was expected (malformed dictionary text) -- skip
      // one value defensively and keep scanning rather than getting stuck.
      cursor = skipOneValue(bytes, cursor);
      continue;
    }
    const nameStart = cursor;
    cursor += 1;
    while (isRegular(bytes[cursor])) cursor += 1;
    const name = bytesToText(bytes, nameStart, cursor);
    const valueStart = skipWhite(bytes, cursor);
    if (name === keyToken) return valueStart;
    cursor = skipOneValue(bytes, valueStart);
  }
}

/**
 * Reads `/key`'s value as a direct (non-indirect-reference) integer, but only a
 * top-level (depth-0), key-position occurrence of `/key` -- see
 * topLevelValueOffset() above. Unlike pdf-structure.js's directInteger() (used for
 * structural values this parser already trusts, e.g. /Size, /Prev, a stream's own
 * /Length -- none of which share a key name with anything that can legitimately be
 * nested one level deeper, or appear as another key's value, the way an Encrypt
 * dictionary's /Length and its Crypt Filter's /Length can), this requires the
 * FULL token at that position to be a clean PDF integer (via parseStrictInteger()
 * below) -- `256foo` or `6.5` are rejected outright, not silently truncated to
 * `256`/`6`, and a leading `+` (valid PDF integer syntax) is accepted. Returns
 * `null` when `/key` is absent at the top level, or its value is not a valid
 * integer token.
 */
export function topLevelInteger(text, key) {
  const offset = topLevelValueOffset(text, key);
  if (offset === undefined) return null;
  const bytes = textToBytes(text);
  let end = offset;
  while (end < bytes.length && isRegular(bytes[end])) end += 1;
  return parseStrictInteger(bytesToText(bytes, offset, end));
}

/**
 * The top-level elements of `/key`'s array value in a dictionary, each read whole
 * via skipOneValue() above -- an indirect reference, a direct dictionary, or
 * anything else PDF allows as an array element -- rather than by searching the
 * array's raw text for a pattern. That distinction is what lets this tell "this
 * array's own second element" apart from "a reference nested three levels inside
 * this array's first element's own dictionary": a plain regex over the array's text
 * cannot, and reading `/DescendantFonts [ << ... /W 25 0 R ... >> ]` that way is
 * exactly what used to count `/W 25 0 R` (and every other reference inside the
 * inline CIDFont dictionary) as if it were an element of the array itself, instead
 * of the array's one genuine element -- the dictionary -- with an entry inside it.
 *
 * Returns null when `/key` is absent at the top level (see topLevelValueOffset()
 * above), when its value is not a direct array (an indirect array object, `/key 11
 * 0 R`, is the caller's to resolve and then re-read through this same function),
 * or when the array's own `[`/`]` cannot be walked to a close -- a malformed array
 * is not the same as an empty one, and must not be read as zero elements. Never
 * throws: a malformed element inside the array (an unterminated nested dictionary,
 * array, or string) is reported the same way, as null, rather than propagating a
 * parse error out of what every caller here treats as a read that can safely fail.
 */
export function topLevelArrayElements(text, key) {
  const offset = topLevelValueOffset(text, key);
  if (offset === undefined) return null;
  const bytes = textToBytes(text);
  if (bytes[offset] !== 0x5b) return null;
  try {
    const elements = [];
    let cursor = skipWhite(bytes, offset + 1);
    while (cursor < bytes.length && bytes[cursor] !== 0x5d) {
      const elementStart = cursor;
      cursor = skipOneValue(bytes, cursor);
      elements.push(bytesToText(bytes, elementStart, cursor));
      cursor = skipWhite(bytes, cursor);
    }
    return bytes[cursor] === 0x5d ? elements : null;
  } catch {
    return null;
  }
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
