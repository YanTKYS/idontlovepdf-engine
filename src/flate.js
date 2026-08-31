/**
 * Stream filter handling shared by content streams, ToUnicode CMap streams, and
 * cross-reference streams. Kept in one place so the Flate decompression path isn't
 * duplicated between src/pdf-document.js and src/pdf-structure.js.
 */

/** Filter names listed in a stream dictionary's /Filter, single name or array form. */
export function filters(dictionary) {
  const array = dictionary.match(/\/Filter\s*\[(.*?)\]/s)?.[1];
  if (array) return [...array.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1]);
  const single = dictionary.match(/\/Filter\s*\/([A-Za-z0-9]+)/)?.[1];
  return single ? [single] : [];
}

/**
 * Flate streams may be predictor-encoded through /DecodeParms. Inflating one and
 * treating the result as content would silently yield mangled data, so it is
 * reported as unsupported instead.
 */
export function hasPredictor(dictionary) {
  const parameters = dictionary.match(/\/DecodeParms\s*(?:\[[^\]]*?)?<<(.*?)>>/s)?.[1] ?? "";
  return Number(parameters.match(/\/Predictor\s+(\d+)/)?.[1] ?? 1) > 1;
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
 * filter, or a bare /FlateDecode without a /Predictor; anything else is reported as
 * an explicit unsupported-filter error rather than silently mangling the output.
 */
export async function decodeStreamBytes(dictionary, data) {
  const applied = filters(dictionary);
  if (applied.length === 0) return data;
  if (applied.length === 1 && applied[0] === "FlateDecode") {
    if (hasPredictor(dictionary)) throw new Error("Unsupported stream filter: FlateDecode with a /Predictor");
    return inflate(data);
  }
  throw new Error(`Unsupported stream filter: ${applied.join(", ")}`);
}
