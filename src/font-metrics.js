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
 * a Type 3 font's own glyph space, an `/Encoding` whose codes are not CIDs, a width array
 * this cannot resolve or cannot read as numbers -- yields no metrics and a reason saying
 * which, and the caller refuses the replacement rather than estimating a width. No font
 * parser is involved: these are the PDF's own numbers, read with the same dictionary-text
 * handling the rest of the engine uses.
 *
 * v0.4.2 widened *which structures can be read*, never what may be assumed about one that
 * cannot. A `/Widths`, `/W`, `/DW`, `/FirstChar` or `/MissingWidth` written as an indirect
 * object is now fetched through the same object resolver the rest of the engine uses and
 * read exactly; if that object is missing, or is not an array of numbers, the answer is
 * still no.
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

/**
 * Why a font's widths could not be read. Internal detail: it reaches the outside only as
 * the `unsafeReason` beside a FALLBACK_FONT_METRICS_UNAVAILABLE refusal, which names the
 * structure and never the document's content. Kept in one place so a real document can be
 * diagnosed (see scripts/diagnose-font-metrics.js) instead of just answering "no".
 */
export const FONT_METRICS_REASONS = Object.freeze([
  /** Not a font kind whose widths this reads: not Type0, Type1, TrueType or MMType1. */
  "unsupported-font-subtype",
  /** A Type 3 font. Its widths are in its own glyph space via /FontMatrix, so /Widths alone does not give them. */
  "unsupported-type3",
  /** A Type0 whose /Encoding is a CMap other than /Identity-H: the code is then not the CID. */
  "non-identity-encoding",
  /** A Type0 whose /Encoding is an embedded CMap stream, which would have to be parsed to map codes to CIDs. */
  "embedded-cmap-encoding",
  /** A Type0 with no /Encoding at all. */
  "missing-encoding",
  /** A Type0 whose indirect /Encoding object could not be read. */
  "encoding-unresolved",
  /** A Type0 with no /DescendantFonts entry: nowhere for a CID font's widths to be stated. */
  "descendant-font-missing",
  /** The descendant font object could not be resolved. */
  "descendant-font-unresolved",
  /** The descendant font is not a CIDFontType0 or CIDFontType2. */
  "unsupported-cid-font",
  /** An indirect /W whose object could not be resolved. */
  "w-unresolved",
  /** An indirect /Widths whose object could not be resolved. */
  "widths-unresolved",
  /** A /W or /Widths that is not an array of numbers (or of numbers and nested arrays). */
  "invalid-width-array",
  /** A simple font with no /Widths at all -- a standard-14 font, whose widths are not in the file. */
  "missing-widths",
  /** A simple font with no /FirstChar, so the /Widths array cannot be indexed. */
  "missing-first-char",
  /** A /FirstChar that is not a non-negative integer, or whose indirect object could not be read. */
  "invalid-first-char",
  /** A /DW that is present but is not a finite number, or whose indirect object could not be read. */
  "invalid-default-width",
  /** A /MissingWidth that is present but is not a finite number. */
  "invalid-missing-width",
  /** An indirect /FontDescriptor whose object could not be resolved. */
  "font-descriptor-unresolved"
]);

function refuse(reason, detail) {
  return { metrics: null, reason, detail: detail ?? null };
}

/** Whether the dictionary states `key` at all, whatever the value turns out to be. */
function hasKey(dictionary, key) {
  return new RegExp(`/${key}(?![A-Za-z0-9])`).test(dictionary);
}

/**
 * A directly written number value, or null when the key is absent or its value is not a
 * number written right there. An indirect reference (`/FirstChar 12 0 R`) is deliberately
 * not matched: its object number is not its value, and reading it as one would be a wrong
 * width from a correct file.
 */
function directNumber(dictionary, key) {
  const match = new RegExp(`/${key}\\s+([+-]?(?:\\d+\\.?\\d*|\\.\\d+))(?![0-9.])(?!\\s+\\d+\\s+R)`).exec(dictionary);
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

/** Resolves an indirect reference through the caller's resolver, or null if it cannot be read. */
async function tryResolve(resolve, target) {
  try {
    return await resolve(target);
  } catch {
    return null;
  }
}

/**
 * The contents of an object that is a bare array (`12 0 obj [ 500 600 ] endobj`), without
 * its brackets -- the same text directArrayText() returns for a direct one, so both go
 * through the identical parsing below. Null for an object that is anything else: a
 * dictionary, a stream, a number, a name.
 */
function arrayObjectText(object) {
  if (!object || object.dictionary) return null;
  const raw = typeof object.rawValue === "string" ? object.rawValue.trim() : null;
  if (!raw || raw[0] !== "[" || raw.at(-1) !== "]") return null;
  return raw.slice(1, -1);
}

/** The finite number an object holds, or null when it holds anything else. */
function numberObjectValue(object) {
  if (!object || object.dictionary) return null;
  if (typeof object.value === "number" && Number.isFinite(object.value)) return object.value;
  const raw = typeof object.rawValue === "string" ? object.rawValue.trim() : null;
  return raw !== null && NUMBER.test(raw) ? Number(raw) : null;
}

/**
 * A number that may be written directly or as an indirect object, both of which PDF
 * allows anywhere a number is expected.
 *
 * `{ value }` -- null when the key is simply absent, so the caller applies its own default
 * -- or `{ reason }` when the key is there but its value cannot be established exactly.
 * "Present but unreadable" is never quietly treated as absent: a `/DW` this cannot read is
 * not a document that meant 1000.
 */
async function resolvedNumber(dictionary, key, resolve, reasons) {
  const direct = directNumber(dictionary, key);
  if (direct !== null) return Number.isFinite(direct) ? { value: direct } : { reason: reasons.invalid };
  const indirect = reference(dictionary, key);
  if (indirect) {
    const object = await tryResolve(resolve, indirect);
    if (!object) return { reason: reasons.unresolved };
    const value = numberObjectValue(object);
    return value === null ? { reason: reasons.invalid } : { value };
  }
  if (hasKey(dictionary, key)) return { reason: reasons.invalid };
  return { value: null };
}

/**
 * A width array that may be written directly or as an indirect object -- the shape real
 * PDF writers produce for anything long, and the one v0.4.1 refused outright.
 *
 * `{ text }` (null when the key is absent) or `{ reason }`. The array's *contents* are
 * still read by the same numeric parsing as a direct one: resolving the object only says
 * where the numbers are, never what they are.
 */
async function resolvedArrayText(dictionary, key, resolve, reasons) {
  const direct = directArrayText(dictionary, key);
  if (direct !== null) return { text: direct };
  const indirect = reference(dictionary, key);
  if (indirect) {
    const object = await tryResolve(resolve, indirect);
    if (!object) return { reason: reasons.unresolved };
    const text = arrayObjectText(object);
    return text === null ? { reason: "invalid-width-array" } : { text };
  }
  // Present, but neither a direct array nor a reference: malformed, not absent.
  if (hasKey(dictionary, key)) return { reason: "invalid-width-array" };
  return { text: null };
}

/** The tokens of an array of numbers and nested arrays, or null if it holds anything else. */
function numericTokens(text) {
  if (!/^[\s\d+\-.[\]]*$/.test(text)) return null;
  return text.match(/\[|\]|[+-]?(?:\d+\.?\d*|\.\d+)/g) ?? [];
}

/** A `/Widths` array's text as a plain array of numbers, or null when it is not one. */
function widthArray(text) {
  const tokens = numericTokens(text);
  if (!tokens || tokens.some((token) => !NUMBER.test(token))) return null;
  return tokens.map(Number);
}

/**
 * A `/W` array's text as CID -> width. Both forms of the spec's grammar are read:
 * `c [w1 w2 ...]` gives consecutive CIDs from `c`, and `c_first c_last w` gives one width
 * to a whole range. Returns null on anything that does not parse as exactly that, so a
 * `/W` this does not understand refuses the replacement instead of silently falling back
 * to `/DW`.
 */
function cidWidths(text) {
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
 * Whether this Type0's `/Encoding` makes a character code equal to a CID -- the only case
 * where `/W` can be looked up with the bytes of the operand.
 *
 * `/Identity-H` does, written directly or as an indirect name object. Nothing else is
 * accepted: a predefined CMap (`/UniJIS-UCS2-H`, `/90ms-RKSJ-H`, ...) is not in the file
 * at all, and an embedded CMap stream would have to be parsed. A width looked up under
 * the wrong CID is a wrong width, so both are refused with a reason that says which.
 */
async function identityEncoding(fontDictionary, resolve) {
  const named = /\/Encoding\s*\/([^\s/<>[\]()]+)/.exec(fontDictionary);
  if (named) return named[1] === "Identity-H" ? null : refuse("non-identity-encoding", `/Encoding /${named[1]}`);
  const indirect = reference(fontDictionary, "Encoding");
  if (!indirect) return refuse("missing-encoding");
  const object = await tryResolve(resolve, indirect);
  if (!object) return refuse("encoding-unresolved", `/Encoding ${indirect.number} ${indirect.generation} R`);
  // A CMap is a stream, so it resolves to an object with a dictionary of its own.
  if (object.dictionary) return refuse("embedded-cmap-encoding", `/Encoding ${indirect.number} ${indirect.generation} R`);
  const raw = typeof object.rawValue === "string" ? object.rawValue.trim() : null;
  if (raw === "/Identity-H") return null;
  if (raw && raw.startsWith("/")) return refuse("non-identity-encoding", raw);
  return refuse("encoding-unresolved", `/Encoding ${indirect.number} ${indirect.generation} R`);
}

/**
 * What an object turned out to be, for the optional trace below. Describes only the shape
 * the resolver itself branches on -- it never parses the value further.
 */
function shapeOfObject(object) {
  if (!object) return { kind: "unresolved", text: null };
  // Branch in the order resolveDescendantFont() itself branches, so `kind` names the
  // path the walk took and not a different reading of the same object: a stream object
  // has a dictionary, and the walk takes it as one (a stream is not a CIDFont, so
  // type0Widths() then refuses it on /Subtype). `stream` records that it was one.
  if (object.dictionary) return { kind: "dictionary", stream: Boolean(object.data), text: object.dictionary };
  if (typeof object.rawValue === "string") {
    const raw = object.rawValue.trim();
    const kind = raw.startsWith("[") ? "array" : raw.startsWith("/") ? "name" : "string-or-other";
    return { kind, text: object.rawValue };
  }
  return { kind: "number-or-boolean", text: String(object.value) };
}

/**
 * A key's value as the dictionary actually writes it -- the following bytes, verbatim and
 * unparsed, so whitespace, comments and line breaks in a real file are visible. For the
 * trace only: nothing is ever resolved or decided from this text.
 */
function rawEntryText(dictionary, key) {
  const found = new RegExp(`/${key}(?![A-Za-z0-9])`).exec(dictionary);
  return found ? dictionary.slice(found.index, found.index + 160) : null;
}

/** tryResolve(), plus a trace entry recording what the hop asked for and what came back. */
async function tracedResolve(resolve, target, trace, step) {
  let object = null;
  let error = null;
  try {
    object = await resolve(target);
  } catch (thrown) {
    error = thrown?.message ?? String(thrown);
  }
  if (trace) trace.push({ step, reference: `${target.number} ${target.generation} R`, error, ...shapeOfObject(object) });
  return object;
}

/**
 * The descendant CIDFont's own dictionary, as `{ dictionary }`, or a refusal saying why it
 * could not be reached. `/DescendantFonts` is an array of exactly one font (PDF 9.7.6.2);
 * the array itself may be written indirectly, which is followed once and no further -- this
 * resolves the structure a real file states, it does not evaluate arbitrary object graphs.
 *
 * Exported so diagnoseFontMetrics() in pdf-document.js reaches the descendant by exactly
 * the same path the measurement does: a diagnosis that stopped a hop short of the real
 * CIDFont would describe a font this can measure as if it stated no widths.
 *
 * `trace`, when an array is passed, is appended with one entry per hop: what was read, what
 * was expected of it, and what actually came back. It is a diagnostic output only -- it
 * changes nothing about which structures resolve, and every caller that measures a font
 * omits it. Its point is that "descendant-font-unresolved" on a real document can be read
 * back as *which* hop failed, from the same code that failed, rather than re-walked by a
 * second implementation that might disagree with this one.
 */
export async function resolveDescendantFont(fontDictionary, resolve, trace = null) {
  const targets = parseReferenceArray(fontDictionary, "DescendantFonts");
  if (trace) {
    const direct = directArrayText(fontDictionary, "DescendantFonts");
    trace.push({
      step: "descendant-fonts-entry",
      // Which shape the entry is written in. "direct-array" and "indirect-reference" are
      // the two parseReferenceArray() distinguishes; it returns the array's elements for
      // the first and the reference itself for the second, so the next hop's meaning
      // differs between them and the trace has to say which one this is.
      form: direct !== null ? "direct-array" : targets.length ? "indirect-reference" : "absent",
      raw: rawEntryText(fontDictionary, "DescendantFonts"),
      references: targets.map((target) => `${target.number} ${target.generation} R`)
    });
  }
  const [target] = targets;
  if (!target) return refuse("descendant-font-missing");
  const unresolved = () => refuse("descendant-font-unresolved", `${target.number} ${target.generation} R`);
  const object = await tracedResolve(resolve, target, trace, "resolve-first-reference");
  if (!object) return unresolved();
  if (object.dictionary) return { dictionary: object.dictionary };
  const inner = arrayObjectText(object);
  const nested = inner === null ? null : /^\s*(\d+)\s+(\d+)\s+R\s*$/.exec(inner);
  if (trace) {
    trace.push({
      step: "nested-array-element",
      // What the object had to be for the second hop to happen: a bare array holding
      // exactly one reference and nothing else.
      expected: "an array object holding exactly one `<num> <gen> R` and nothing else",
      inner,
      matched: Boolean(nested)
    });
  }
  if (!nested) return unresolved();
  const font = await tracedResolve(
    resolve,
    { number: Number(nested[1]), generation: Number(nested[2]) },
    trace,
    "resolve-nested-reference"
  );
  return font?.dictionary ? { dictionary: font.dictionary } : unresolved();
}

async function type0Widths(fontDictionary, resolve) {
  const encoding = await identityEncoding(fontDictionary, resolve);
  if (encoding) return encoding;
  const descendant = await resolveDescendantFont(fontDictionary, resolve);
  if (descendant.reason) return descendant;
  if (!/\/Subtype\s*\/CIDFontType[02]\b/.test(descendant.dictionary)) {
    return refuse("unsupported-cid-font", /\/Subtype\s*\/([^\s/<>[\]()]+)/.exec(descendant.dictionary)?.[0] ?? null);
  }
  const array = await resolvedArrayText(descendant.dictionary, "W", resolve, { unresolved: "w-unresolved" });
  if (array.reason) return refuse(array.reason);
  const widths = array.text === null ? new Map() : cidWidths(array.text);
  if (!widths) return refuse("invalid-width-array", "/W");
  const defaultWidth = await resolvedNumber(descendant.dictionary, "DW", resolve, {
    unresolved: "invalid-default-width",
    invalid: "invalid-default-width"
  });
  if (defaultWidth.reason) return refuse(defaultWidth.reason, "/DW");
  const fallbackWidth = defaultWidth.value ?? DEFAULT_CID_WIDTH;
  return { metrics: { codeBytes: 2, widthOf: (code) => widths.get(code) ?? fallbackWidth }, reason: null, detail: null };
}

async function simpleFontWidths(fontDictionary, resolve) {
  const array = await resolvedArrayText(fontDictionary, "Widths", resolve, { unresolved: "widths-unresolved" });
  if (array.reason) return refuse(array.reason);
  if (array.text === null) return refuse("missing-widths");
  const widths = widthArray(array.text);
  if (!widths) return refuse("invalid-width-array", "/Widths");
  const first = await resolvedNumber(fontDictionary, "FirstChar", resolve, {
    unresolved: "invalid-first-char",
    invalid: "invalid-first-char"
  });
  if (first.reason) return refuse(first.reason, "/FirstChar");
  if (first.value === null) return refuse("missing-first-char");
  const firstChar = first.value;
  if (!Number.isInteger(firstChar) || firstChar < 0) return refuse("invalid-first-char", "/FirstChar");
  let missingWidth = 0;
  const descriptorReference = reference(fontDictionary, "FontDescriptor");
  if (descriptorReference) {
    const descriptor = await tryResolve(resolve, descriptorReference);
    if (!descriptor) return refuse("font-descriptor-unresolved", `${descriptorReference.number} ${descriptorReference.generation} R`);
    const stated = await resolvedNumber(descriptor.dictionary, "MissingWidth", resolve, {
      unresolved: "invalid-missing-width",
      invalid: "invalid-missing-width"
    });
    if (stated.reason) return refuse(stated.reason, "/MissingWidth");
    missingWidth = stated.value ?? 0;
  }
  return {
    metrics: {
      codeBytes: 1,
      widthOf: (code) => {
        const width = widths[code - firstChar];
        return code >= firstChar && width !== undefined ? width : missingWidth;
      }
    },
    reason: null,
    detail: null
  };
}

/**
 * How wide, in glyph-space units, each code of this font is -- or why that cannot be
 * established exactly.
 *
 * Returns `{ metrics, reason, detail }`. `metrics` is `{ codeBytes, widthOf }`: how many
 * bytes one code takes in a string operand, and the width of a given code. It is null
 * exactly when `reason` is set (one of FONT_METRICS_REASONS above), and then the caller
 * refuses the replacement rather than estimating a width. `resolve(reference)` is the
 * caller's object resolver (see loadFontMaps() in pdf-document.js).
 *
 * Supported, because they are the cases where the mapping from operand bytes to widths is
 * exact and needs nothing this engine does not already read:
 *
 * - a simple font (`/Type1`, `/TrueType`, `/MMType1`) with a `/Widths` array: one byte per
 *   code, `/FirstChar` says where the array starts, and `/MissingWidth` (default 0) covers
 *   the rest.
 * - a Type0 font with `/Encoding /Identity-H`, whose descendant is a CIDFont: two bytes
 *   per code and the code *is* the CID, so `/W` and `/DW` apply directly.
 *
 * In both, the array and the numbers around it may be direct or indirect objects.
 *
 * Everything else -- a standard-14 font with no `/Widths`, a Type 3 font (its `/FontMatrix`
 * is its own glyph space), a predefined or embedded CMap that maps codes to CIDs some
 * other way, an object that cannot be resolved or is not an array of numbers -- has no
 * metrics. There is no fallback to "probably 1000".
 */
export async function describeFontWidths(fontDictionary, resolve) {
  if (/\/Subtype\s*\/Type0\b/.test(fontDictionary)) return type0Widths(fontDictionary, resolve);
  if (/\/Subtype\s*\/Type3\b/.test(fontDictionary)) return refuse("unsupported-type3", "/Subtype /Type3");
  if (!/\/Subtype\s*\/(?:Type1|TrueType|MMType1)\b/.test(fontDictionary)) {
    return refuse("unsupported-font-subtype", /\/Subtype\s*\/([^\s/<>[\]()]+)/.exec(fontDictionary)?.[0] ?? null);
  }
  return simpleFontWidths(fontDictionary, resolve);
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
