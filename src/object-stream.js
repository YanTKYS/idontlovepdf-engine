/**
 * Parses a decoded PDF Object Stream (`/Type /ObjStm`, PDF spec 7.5.7) body into its
 * component objects' raw byte ranges.
 *
 * `decodedBytes` is already fully filtered plaintext: FlateDecode/Predictor reversed
 * (and, for an encrypted PDF, AES-decrypted as a whole stream) -- see
 * `PdfStructure#decodeObjectStream()` in pdf-structure.js, which is the only caller
 * and owns all of that. This module knows nothing about encryption, xref, or how
 * the returned byte ranges are subsequently interpreted (as a dictionary, etc.);
 * it only understands the Object Stream's own header format.
 */

import { skipWhite } from "./syntax.js";

// A generous, sanity-only upper bound -- real Object Streams hold at most a few
// thousand objects; this exists to reject an obviously bogus /N before it drives a
// large loop or allocation, not to model any real PDF limit.
const MAX_OBJECT_COUNT = 1_000_000;

function readUnsignedInteger(bytes, position) {
  const start = skipWhite(bytes, position);
  let cursor = start;
  while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1;
  if (cursor === start) return null;
  let value = 0;
  for (let index = start; index < cursor; index += 1) value = value * 10 + (bytes[index] - 0x30);
  return { value, end: cursor };
}

/**
 * Parses the `/N` `objectNumber offset` pairs at the start of an Object Stream and
 * slices out each compressed object's own bytes.
 *
 * `objectCount` is the stream dictionary's `/N` (how many objects it holds) and
 * `firstOffset` its `/First` (byte offset, from the start of `decodedBytes`, where
 * object bodies begin -- everything before that is the header). Both are validated
 * here rather than trusted, since they come directly from the (possibly malformed
 * or hostile) PDF: a bad value is rejected with a specific reason, never guessed at
 * or clamped into something plausible.
 *
 * Returns `[{ objectNumber, index, offset, bytes }, ...]` in header order, where
 * `bytes` is the exact slice of `decodedBytes` for that one object's value (a
 * dictionary, array, number, name, string, null, or boolean -- PDF spec 7.5.7
 * explicitly disallows a stream object here, so callers should treat anything that
 * doesn't parse as one of those as an error, not guess).
 */
export function parseObjectStream(decodedBytes, { objectCount, firstOffset }) {
  if (!Number.isInteger(objectCount) || objectCount <= 0 || objectCount > MAX_OBJECT_COUNT) {
    throw new Error(`Malformed object stream /N: ${objectCount}`);
  }
  if (!Number.isInteger(firstOffset) || firstOffset < 0) {
    throw new Error(`Malformed object stream /First: ${firstOffset}`);
  }
  if (firstOffset > decodedBytes.length) {
    throw new Error("Malformed object stream /First: beyond the end of the decoded stream");
  }

  const header = [];
  let cursor = 0;
  for (let index = 0; index < objectCount; index += 1) {
    const numberField = cursor < firstOffset ? readUnsignedInteger(decodedBytes, cursor) : null;
    if (!numberField || numberField.end > firstOffset) throw new Error("Object stream header is incomplete");
    const offsetField = readUnsignedInteger(decodedBytes, numberField.end);
    if (!offsetField || offsetField.end > firstOffset) throw new Error("Object stream header is incomplete");
    header.push({ objectNumber: numberField.value, offset: offsetField.value });
    cursor = offsetField.end;
  }

  // Validated as its own pass, over every pair, before any byte slicing: a
  // duplicate offset produces a zero-length body (not out of bounds, so the bounds
  // check below would not catch it), and descending offsets would make two header
  // entries claim overlapping bytes -- both are rejected here explicitly, per spec,
  // rather than only catching the subset that also happens to fail on bounds.
  for (let index = 1; index < header.length; index += 1) {
    if (header[index].offset <= header[index - 1].offset) throw new Error("Object stream body offset is invalid: header offsets are not strictly ascending");
  }

  const entries = [];
  for (let index = 0; index < header.length; index += 1) {
    const { objectNumber, offset } = header[index];
    const absoluteStart = firstOffset + offset;
    if (absoluteStart > decodedBytes.length) throw new Error("Object stream body offset is invalid");
    // The last object runs to the end of the decoded stream; every other one runs
    // up to the next object's declared offset. Ascending order (checked above) plus
    // this bound together guarantee absoluteStart <= absoluteEnd for every entry.
    const nextOffset = index + 1 < header.length ? header[index + 1].offset : decodedBytes.length - firstOffset;
    const absoluteEnd = firstOffset + nextOffset;
    if (absoluteEnd > decodedBytes.length) throw new Error("Object stream body offset is invalid");
    entries.push({ objectNumber, index, offset, bytes: decodedBytes.subarray(absoluteStart, absoluteEnd) });
  }
  return entries;
}
