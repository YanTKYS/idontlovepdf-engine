/**
 * Stream filter handling shared by content streams, ToUnicode CMap streams, and
 * cross-reference streams. Kept in one place so the Flate decompression path isn't
 * duplicated between src/pdf-document.js and src/pdf-structure.js.
 */

import { reversePredictor } from "./predictor.js";

/** Filter names listed in a stream dictionary's /Filter, single name or array form. */
export function filters(dictionary) {
  const array = dictionary.match(/\/Filter\s*\[(.*?)\]/s)?.[1];
  if (array) return [...array.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1]);
  const single = dictionary.match(/\/Filter\s*\/([A-Za-z0-9]+)/)?.[1];
  return single ? [single] : [];
}

async function transformWithStream(bytes, format, StreamClass) {
  const stream = new Blob([bytes]).stream().pipeThrough(new StreamClass(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("FlateDecode requires the browser DecompressionStream API");
  return transformWithStream(bytes, "deflate", DecompressionStream);
}

export async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") throw new Error("FlateDecode requires the browser CompressionStream API");
  return transformWithStream(bytes, "deflate", CompressionStream);
}

/**
 * Applies a stream dictionary's /Filter to its raw bytes. Currently handles no
 * filter, or a bare /FlateDecode (optionally TIFF- or PNG-predictor-encoded via
 * /DecodeParms /Predictor); anything else is reported as an explicit
 * unsupported-filter error rather than silently mangling the output.
 *
 * `context`, when given, prefixes any error with where the stream came from (e.g.
 * "content stream object 45"), since the same code path is shared by xref streams,
 * content streams, and ToUnicode CMap streams — see src/pdf-structure.js and
 * src/pdf-document.js for how each names itself.
 */
export async function decodeStreamBytes(dictionary, data, context = "") {
  const applied = filters(dictionary);
  if (applied.length === 0) return data;
  if (applied.length === 1 && applied[0] === "FlateDecode") {
    const inflated = await inflate(data);
    return reversePredictor(inflated, dictionary, context);
  }
  const prefix = context ? `${context}: ` : "";
  throw new Error(`${prefix}Unsupported stream filter: ${applied.join(", ")}`);
}
