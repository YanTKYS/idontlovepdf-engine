/**
 * Byte classification shared by the content-stream scanner and the file-structure
 * parser. Both used to carry their own copies of these predicates, which is how
 * they drifted apart (one used a Set, the other a chain of comparisons).
 */

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([..."()<>[]{}/%"].map((character) => character.charCodeAt(0)));

export function isWhite(byte) {
  return WHITESPACE.has(byte);
}

export function isDelimiter(byte) {
  return DELIMITERS.has(byte);
}

/** Regular characters are everything that can appear inside a name or an operator. */
export function isRegular(byte) {
  return byte !== undefined && !isWhite(byte) && !isDelimiter(byte);
}

/** Skips whitespace and `%` comments, which are equivalent to whitespace in PDF. */
export function skipWhite(bytes, start) {
  let cursor = start;
  while (cursor < bytes.length) {
    if (isWhite(bytes[cursor])) cursor += 1;
    else if (bytes[cursor] === 0x25) {
      while (cursor < bytes.length && bytes[cursor] !== 10 && bytes[cursor] !== 13) cursor += 1;
    } else break;
  }
  return cursor;
}
