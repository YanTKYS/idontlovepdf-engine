/**
 * The glyph widths a PDF reader positions text with -- read from the document's own font
 * dictionaries, not from any font program.
 *
 * This matters for one thing only: replacing text inside a `TJ` array without moving what
 * follows it. To put the following text back exactly where the PDF asked for it, the
 * engine has to know how wide the characters it removed were, and a PDF reader takes that
 * from `/Widths` (simple fonts) or `/W` and `/DW` (CID fonts) -- not from the embedded
 * font program, whose `hmtx` a reader is entitled to ignore. So these are the authoritative
 * numbers, and the only ones that make the arithmetic in pdf-document.js exact rather than
 * approximate.
 *
 * Everything is in glyph space: thousandths of the text-space unit, which is the same unit
 * a `TJ` adjustment is written in. That is what lets the two be compared and cancelled
 * without ever bringing font size or horizontal scaling into it (both multiply the glyph
 * advance and the `TJ` adjustment alike -- see the derivation in pdf-document.js).
 *
 * Nothing here guesses. A font whose widths cannot be read exactly -- no `/Widths` at all,
 * a Type 3 font's own glyph space, a `/Encoding` whose codes are not CIDs, widths written
 * as an indirect object this cannot resolve -- yields null, and the caller refuses the
 * replacement rather than estimating a width. No font parser is involved: these are the
 * PDF's own numbers, read with the same dictionary-text handling the rest of the engine
 * uses.
 */
import { parseReferenceArray, reference } from "./pdf-structure.js";

/** A CID font's default width when `/DW` is absent, per PDF 9.7.4.3. */
const DEFAULT_CID_WIDTH = 1000;

/**
 * A `c_first c_last w` run in `/W` may legitimately cover a large block of CIDs, but not
 * an unbounded one: the CID space a 2-byte code can address is 65536 wide, so anything
 * beyond that is malformed and must not be expanded entry by entry.
 */
const MAX_CID_RANGE = 0x10000;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function directNumber(dictionary, key) {
  const match = new RegExp(`/${key}\\s+([+-]?(?:\\d+\\.?\\d*|\\.\\d+))(?![0-9.])`).exec(dictionary);
  return match ? Number(match[1]) : null;
}

/**
 * The text between the brackets of a direct array value `/Key [ ... ]`, or null when the
 * key is absent, is an indirect reference, or the array never closes. Bracket depth is
 * tracked so `/W [1 [500 600] 4 [700]]` comes back whole; the callers below then reject
 * anything in it that is not a number or a bracket, so no string or name can hide inside.
 */
function directArrayText(dictionary, key) {
  const opener = new RegExp(`/${key}\\s*\\[`).exec(dictionary);
  if (!opener) return null;
  const start = opener.index + opener[0].length;
  let depth = 1;
  for (let index = start; index < dictionary.length; index += 1) {
    if (dictionary[index] === "[") depth += 1;
    else if (dictionary[index] === "]" && (depth -= 1) === 0) return dictionary.slice(start, index);
  }
  return null;
}

/** The tokens of an array of numbers and nested arrays, or null if it holds anything else. */
function numericTokens(text) {
  if (!/^[\s\d+\-.[\]]*$/.test(text)) return null;
  return text.match(/\[|\]|[+-]?(?:\d+\.?\d*|\.\d+)/g) ?? [];
}

/** `/Widths` as a plain array of numbers, or null when it is not one. */
function widthArray(dictionary) {
  const text = directArrayText(dictionary, "Widths");
  if (text === null) return null;
  const tokens = numericTokens(text);
  if (!tokens || tokens.some((token) => !NUMBER.test(token))) return null;
  return tokens.map(Number);
}

/**
 * `/W` as CID -> width. Both forms of the spec's grammar are read: `c [w1 w2 ...]` gives
 * consecutive CIDs from `c`, and `c_first c_last w` gives one width to a whole range.
 * Returns null on anything that does not parse as exactly that, so a `/W` this does not
 * understand refuses the replacement instead of silently falling back to `/DW`.
 */
function cidWidths(dictionary) {
  const text = directArrayText(dictionary, "W");
  if (text === null) return new Map();
  const tokens = numericTokens(text);
  if (!tokens) return null;
  const widths = new Map();
  let index = 0;
  while (index < tokens.length) {
    if (!NUMBER.test(tokens[index])) return null;
    const first = Number(tokens[index]);
    index += 1;
    if (!Number.isInteger(first) || first < 0) return null;
    if (tokens[index] === "[") {
      index += 1;
      let cid = first;
      while (index < tokens.length && tokens[index] !== "]") {
        if (!NUMBER.test(tokens[index])) return null;
        widths.set(cid, Number(tokens[index]));
        cid += 1;
        index += 1;
      }
      if (tokens[index] !== "]") return null;
      index += 1;
      continue;
    }
    if (index + 1 >= tokens.length) return null;
    if (!NUMBER.test(tokens[index]) || !NUMBER.test(tokens[index + 1])) return null;
    const last = Number(tokens[index]);
    const width = Number(tokens[index + 1]);
    index += 2;
    if (!Number.isInteger(last) || last < first || last - first >= MAX_CID_RANGE) return null;
    for (let cid = first; cid <= last; cid += 1) widths.set(cid, width);
  }
  return widths;
}

/**
 * How wide, in glyph-space units, each code of this font is -- or null when that cannot be
 * established exactly.
 *
 * Returns `{ codeBytes, widthOf }`: how many bytes one code takes in a string operand, and
 * the width of a given code. `resolve(reference)` is the caller's object resolver (see
 * loadFontMaps() in pdf-document.js), used for the descendant font of a Type0 and for a
 * simple font's `/FontDescriptor`.
 *
 * Supported, because they are the cases where the mapping from operand bytes to widths is
 * exact and needs nothing this engine does not already read:
 *
 * - a simple font (`/Type1`, `/TrueType`, `/MMType1`) with a direct `/Widths` array: one
 *   byte per code, `/FirstChar` says where the array starts, and `/MissingWidth` (default
 *   0) covers the rest.
 * - a Type0 font with `/Encoding /Identity-H`, whose descendant is a CIDFont: two bytes
 *   per code and the code *is* the CID, so `/W` and `/DW` apply directly.
 *
 * Everything else -- a standard-14 font with no `/Widths`, a Type 3 font (its `/FontMatrix`
 * is its own glyph space), a predefined or embedded CMap that maps codes to CIDs some other
 * way, an indirect `/Widths` or `/W` -- is null. There is no fallback to "probably 1000".
 */
export async function loadFontWidths(fontDictionary, resolve) {
  if (/\/Subtype\s*\/Type0\b/.test(fontDictionary)) {
    // Only /Identity-H makes the code equal the CID. Any other CMap needs the CMap itself
    // to map codes to CIDs, and a width looked up under the wrong CID is a wrong width.
    if (!/\/Encoding\s*\/Identity-H\b/.test(fontDictionary)) return null;
    const [descendantReference] = parseReferenceArray(fontDictionary, "DescendantFonts");
    if (!descendantReference) return null;
    let descendant;
    try {
      descendant = await resolve(descendantReference);
    } catch {
      return null;
    }
    if (!/\/Subtype\s*\/CIDFontType[02]\b/.test(descendant.dictionary)) return null;
    if (reference(descendant.dictionary, "W")) return null;
    const widths = cidWidths(descendant.dictionary);
    if (!widths) return null;
    const defaultWidth = directNumber(descendant.dictionary, "DW") ?? DEFAULT_CID_WIDTH;
    if (!Number.isFinite(defaultWidth)) return null;
    return { codeBytes: 2, widthOf: (code) => widths.get(code) ?? defaultWidth };
  }
  if (!/\/Subtype\s*\/(?:Type1|TrueType|MMType1)\b/.test(fontDictionary)) return null;
  if (reference(fontDictionary, "Widths")) return null;
  const widths = widthArray(fontDictionary);
  if (!widths) return null;
  const firstChar = directNumber(fontDictionary, "FirstChar");
  if (!Number.isInteger(firstChar) || firstChar < 0) return null;
  let missingWidth = 0;
  const descriptorReference = reference(fontDictionary, "FontDescriptor");
  if (descriptorReference) {
    try {
      missingWidth = directNumber((await resolve(descriptorReference)).dictionary, "MissingWidth") ?? 0;
    } catch {
      return null;
    }
  }
  if (!Number.isFinite(missingWidth)) return null;
  return {
    codeBytes: 1,
    widthOf: (code) => {
      const width = widths[code - firstChar];
      return code >= firstChar && width !== undefined ? width : missingWidth;
    }
  };
}

/**
 * The advance of a string operand, in glyph-space units, plus what the text state has to
 * be asked about it: how many glyphs it shows (character spacing is added once per glyph)
 * and how many of them are the single-byte code 32 that word spacing applies to.
 *
 * Returns null when the operand does not divide into whole codes, or when any code's width
 * is not a finite number -- neither of which may be papered over.
 */
export function measureCodes(metrics, bytes) {
  if (bytes.length % metrics.codeBytes !== 0) return null;
  let width = 0;
  let glyphs = 0;
  let spaces = 0;
  for (let index = 0; index < bytes.length; index += metrics.codeBytes) {
    const code = metrics.codeBytes === 2 ? (bytes[index] << 8) | bytes[index + 1] : bytes[index];
    const value = metrics.widthOf(code);
    if (!Number.isFinite(value)) return null;
    width += value;
    glyphs += 1;
    // Word spacing reaches the single-byte code 32 and nothing else (PDF 9.3.3), so a
    // 2-byte encoding never sees it however its glyphs decode.
    if (metrics.codeBytes === 1 && code === 32) spaces += 1;
  }
  return { width, glyphs, spaces };
}
