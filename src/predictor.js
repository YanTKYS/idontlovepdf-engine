/**
 * PDF `/DecodeParms /Predictor` support for FlateDecode streams.
 *
 * Some PDF writers delta-encode stream bytes (TIFF-style or PNG-style) before
 * deflating, as a compression aid. `/Filter /FlateDecode` alone only undoes the
 * deflate step; without also reversing the predictor, the "decoded" bytes are still
 * scrambled and would be misread as PDF syntax or CMap data. This module reverses
 * that delta encoding, independent of what kind of stream it came from (xref stream,
 * page content stream, ToUnicode CMap stream, ...) — callers just hand it the
 * inflated bytes and the stream's own dictionary text.
 */

import { parseStrictInteger, readToken } from "./pdf-dictionary-text.js";

// Sanity bound on a single row's byte count. Real PDF predictor rows are at most a
// few thousand bytes (image width x components x bytes-per-sample); this exists only
// to reject obviously bogus /Columns//Colors/BitsPerComponent combinations before
// they reach array allocation, not to model any real PDF limit.
const MAX_ROW_BYTES = 1 << 24;

function readDecodeParmsText(dictionary) {
  // `/DecodeParms << ... >>` is the common form; `/DecodeParms [ << ... >> ]` (a
  // single-element array) also appears, generally paired with a single-element
  // `/Filter [ /FlateDecode ]`. Only one filter is supported at all (see flate.js),
  // so only the single-dictionary forms need handling here.
  const arrayForm = dictionary.match(/\/DecodeParms\s*\[\s*(<<[\s\S]*?>>)\s*\]/)?.[1];
  return arrayForm ?? dictionary.match(/\/DecodeParms\s*(<<[\s\S]*?>>)/)?.[1] ?? null;
}

/** Reads /Predictor, /Columns, /Colors, /BitsPerComponent, applying the PDF spec's defaults. */
export function parseDecodeParms(dictionary, context = "") {
  const prefix = context ? `${context}: ` : "";
  const text = readDecodeParmsText(dictionary);
  const read = (key, fallback) => {
    const token = readToken(text, key);
    if (token === undefined) return fallback;
    const value = parseStrictInteger(token);
    if (value === null) throw new Error(`${prefix}Predictor has an invalid /${key}`);
    return value;
  };
  return {
    predictor: read("Predictor", 1),
    columns: read("Columns", 1),
    colors: read("Colors", 1),
    bitsPerComponent: read("BitsPerComponent", 8)
  };
}

function requirePositiveInteger(value, name, prefix) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${prefix}Predictor has an invalid /${name}`);
}

// The PDF spec restricts a Predictor's /BitsPerComponent to these values (16 only
// from PDF 1.5 on, which this prototype does not distinguish by version); anything
// else — 3, 5, 24, ... — is not a value real predictor-encoded data would ever use.
const VALID_BITS_PER_COMPONENT = new Set([1, 2, 4, 8, 16]);

function requireValidBitsPerComponent(value, prefix) {
  if (!VALID_BITS_PER_COMPONENT.has(value)) throw new Error(`${prefix}Predictor has an invalid /BitsPerComponent: ${value}`);
}

/** Row byte count from /Columns, /Colors, /BitsPerComponent, rounding up any partial byte. */
function rowByteCount(columns, colors, bitsPerComponent, prefix) {
  const bitsPerRow = columns * colors * bitsPerComponent;
  if (!Number.isSafeInteger(bitsPerRow)) throw new Error(`${prefix}Predictor row size is out of the safe integer range`);
  const bytes = Math.ceil(bitsPerRow / 8);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${prefix}Predictor row size is invalid`);
  if (bytes > MAX_ROW_BYTES) throw new Error(`${prefix}Predictor row size is too large`);
  return bytes;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

/**
 * Reverses PNG-style prediction (Predictor 10-15). Per the PDF spec, every one of
 * these values means the same thing: each row is prefixed with a filter-type byte
 * (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) that says which filter that specific row
 * actually used — the /Predictor number itself is only documentation of what the
 * encoder is expected to have mostly used, never a promise about any single row. A
 * decoder that assumed "/Predictor 12 means every row is Up-filtered" would misread
 * real PDFs; reading the per-row byte, as done here, is what the spec requires for
 * every one of 10 through 15 alike.
 */
function undoPngPredictor(data, rowBytes, pixelBytes, prefix) {
  const stride = rowBytes + 1;
  if (data.length === 0 || data.length % stride !== 0) {
    throw new Error(`${prefix}PNG predictor row length does not match the stream length`);
  }
  const rowCount = data.length / stride;
  const output = new Uint8Array(rowCount * rowBytes);
  let previousRow = new Uint8Array(rowBytes);
  for (let row = 0; row < rowCount; row += 1) {
    const rowStart = row * stride;
    const filterType = data[rowStart];
    const raw = data.subarray(rowStart + 1, rowStart + stride);
    const current = output.subarray(row * rowBytes, (row + 1) * rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= pixelBytes ? current[index - pixelBytes] : 0;
      const up = previousRow[index];
      const upLeft = index >= pixelBytes ? previousRow[index - pixelBytes] : 0;
      let value;
      if (filterType === 0) value = raw[index];
      else if (filterType === 1) value = raw[index] + left;
      else if (filterType === 2) value = raw[index] + up;
      else if (filterType === 3) value = raw[index] + Math.floor((left + up) / 2);
      else if (filterType === 4) value = raw[index] + paeth(left, up, upLeft);
      else throw new Error(`${prefix}Unknown PNG predictor filter type: ${filterType}`);
      current[index] = value & 0xff;
    }
    previousRow = current;
  }
  return output;
}

/**
 * Reverses TIFF Predictor 2, restricted to 8-bit samples: `current = (encoded +
 * previous-sample-of-the-same-color-component) mod 256`. Other bit depths (1, 2, 4,
 * 16) need bit-level (not byte-level) sample packing to locate "the same component's
 * previous sample" and are out of scope here; they fail with a specific error
 * instead of being silently misread as 8-bit.
 */
function undoTiffPredictor(data, rowBytes, colors, bitsPerComponent, prefix) {
  if (bitsPerComponent !== 8) throw new Error(`${prefix}Unsupported TIFF Predictor BitsPerComponent: ${bitsPerComponent}`);
  if (data.length === 0 || data.length % rowBytes !== 0) {
    throw new Error(`${prefix}TIFF predictor row length does not match the stream length`);
  }
  const output = Uint8Array.from(data);
  const rowCount = output.length / rowBytes;
  for (let row = 0; row < rowCount; row += 1) {
    const start = row * rowBytes;
    for (let index = colors; index < rowBytes; index += 1) {
      output[start + index] = (output[start + index] + output[start + index - colors]) & 0xff;
    }
  }
  return output;
}

/**
 * Reverses whatever `/DecodeParms /Predictor` the stream declares, given its already
 * Flate-inflated bytes. `context`, when given, prefixes any error with where the
 * stream came from (e.g. "content stream object 45"), since the same predictor code
 * runs for xref streams, content streams, and ToUnicode CMap streams alike.
 */
export function reversePredictor(data, dictionary, context = "") {
  const prefix = context ? `${context}: ` : "";
  const { predictor, columns, colors, bitsPerComponent } = parseDecodeParms(dictionary, context);
  if (predictor === 1) return data;

  requirePositiveInteger(columns, "Columns", prefix);
  requirePositiveInteger(colors, "Colors", prefix);
  requirePositiveInteger(bitsPerComponent, "BitsPerComponent", prefix);
  requireValidBitsPerComponent(bitsPerComponent, prefix);

  const rowBytes = rowByteCount(columns, colors, bitsPerComponent, prefix);

  if (predictor === 2) {
    return undoTiffPredictor(data, rowBytes, colors, bitsPerComponent, prefix);
  }
  if (predictor >= 10 && predictor <= 15) {
    const pixelBytes = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
    return undoPngPredictor(data, rowBytes, pixelBytes, prefix);
  }
  throw new Error(`${prefix}Unsupported /Predictor value: ${predictor}`);
}
