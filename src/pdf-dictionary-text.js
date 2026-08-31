/**
 * Low-level parsing helpers over an already-extracted PDF dictionary's *text* (the
 * `latin1`-decoded string form `PdfStructure` and `src/encryption.js` already work
 * with -- see `extractDictionary()` in pdf-structure.js). These only understand PDF
 * dictionary syntax; they know nothing about encryption, diagnosis, or decryption,
 * which is what lets both `src/encryption.js` (diagnosis) and
 * `src/security/decrypt.js` (authentication/decryption) share one implementation
 * instead of two that could quietly drift apart (as the Crypt Filter `/Length`
 * units bug showed -- a second, separately-written copy of that parsing logic could
 * easily reintroduce the same mistake).
 *
 * A `latin1` decode is a 1:1 byte<->code-point mapping for 0-255, so `charCodeAt()`
 * on this text recovers the exact original byte -- string() below relies on that.
 */

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

function readStringToken(bytes, openIndex) {
  if (bytes[openIndex] === 0x28) {
    // Literal string: track parenthesis depth and backslash escapes, same rules as
    // dictionaryEnd() in pdf-structure.js uses to skip over one without parsing it.
    let depth = 1;
    let cursor = openIndex + 1;
    const value = [];
    while (cursor < bytes.length && depth > 0) {
      const byte = bytes[cursor];
      if (byte === 0x5c && cursor + 1 < bytes.length) {
        value.push(bytes[cursor + 1]);
        cursor += 2;
        continue;
      }
      if (byte === 0x28) depth += 1;
      else if (byte === 0x29) { depth -= 1; if (depth === 0) { cursor += 1; break; } }
      value.push(byte);
      cursor += 1;
    }
    return { end: cursor, value: Uint8Array.from(value) };
  }
  // Hex string: pair up digits, ignoring whitespace, padding a trailing odd digit
  // with an implicit 0 (per PDF spec 7.3.4.3).
  let cursor = openIndex + 1;
  let digits = "";
  while (cursor < bytes.length && bytes[cursor] !== 0x3e) {
    const byte = bytes[cursor];
    if (!(byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c || byte === 0x00)) {
      digits += String.fromCharCode(byte);
    }
    cursor += 1;
  }
  if (digits.length % 2) digits += "0";
  const value = Uint8Array.from(digits.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  return { end: cursor + 1, value };
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
