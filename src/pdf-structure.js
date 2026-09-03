import { isRegular, skipWhite as skipSpace } from "./syntax.js";
import { readHex, readLiteral } from "./content-stream.js";
import { decodeStreamBytes } from "./flate.js";
import { firstIdBytes, parseStrictInteger, readToken } from "./pdf-dictionary-text.js";
import { parseObjectStream } from "./object-stream.js";

/**
 * A byte-preserving "binary string" codec: unlike `TextDecoder("latin1")` (which
 * the WHATWG Encoding Standard defines as an alias for windows-1252, not true
 * ISO-8859-1/binary passthrough -- bytes 0x80-0x9F decode to assorted non-ASCII
 * code points instead of themselves), this maps each byte 0-255 to the identical
 * UTF-16 code unit, so `charCodeAt()` on the result always recovers the exact
 * original byte. Dictionary/trailer text below is parsed with ASCII-only regexes
 * (names, integers, references, keywords), which either codec would get right --
 * but /O, /U, and /ID inside it are real 8-bit binary data extracted from this
 * same text (see pdf-dictionary-text.js's stringValue()/firstIdBytes()), and the
 * Standard Security Handler's authentication depends on those being byte-exact.
 */
function decodeBinaryString(bytes) {
  // Chunked to stay well under engines' call-argument-count limits for very large
  // spreads (a dictionary/trailer is small, but this defends against pathological
  // input reaching a huge single subarray).
  const CHUNK = 0x2000;
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return result;
}

function readInteger(bytes, position) {
  const start = skipSpace(bytes, position);
  let cursor = start;
  while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1;
  if (cursor === start) throw new Error(`Expected an integer at PDF byte ${start}`);
  return { value: Number(decodeBinaryString(bytes.subarray(start, cursor))), end: cursor };
}

function keywordAt(bytes, position, keyword) {
  return decodeBinaryString(bytes.subarray(position, position + keyword.length)) === keyword;
}

function skipLiteral(bytes, position) {
  let cursor = position + 1;
  let depth = 1;
  while (cursor < bytes.length && depth) {
    if (bytes[cursor] === 0x5c) cursor += 2;
    else {
      if (bytes[cursor] === 0x28) depth += 1;
      if (bytes[cursor] === 0x29) depth -= 1;
      cursor += 1;
    }
  }
  if (depth) throw new Error("Unterminated PDF literal string");
  return cursor;
}

function dictionaryEnd(bytes, position) {
  if (bytes[position] !== 0x3c || bytes[position + 1] !== 0x3c) throw new Error("Expected a PDF dictionary");
  let cursor = position + 2;
  let depth = 1;
  while (cursor < bytes.length && depth) {
    if (bytes[cursor] === 0x25) cursor = skipSpace(bytes, cursor);
    else if (bytes[cursor] === 0x28) cursor = skipLiteral(bytes, cursor);
    else if (bytes[cursor] === 0x3c && bytes[cursor + 1] === 0x3c) {
      depth += 1;
      cursor += 2;
    } else if (bytes[cursor] === 0x3e && bytes[cursor + 1] === 0x3e) {
      depth -= 1;
      cursor += 2;
    } else if (bytes[cursor] === 0x3c) {
      cursor += 1;
      while (cursor < bytes.length && bytes[cursor] !== 0x3e) cursor += 1;
      cursor += 1;
    } else cursor += 1;
  }
  if (depth) throw new Error("Unterminated PDF dictionary");
  return cursor;
}

/**
 * Finds the end of a PDF array `[ ... ]`, tracking `[`/`]` depth (arrays can nest)
 * while skipping over literal strings, nested dictionaries, and hex strings the same
 * way dictionaryEnd() does -- an unescaped `]` inside a string, or one that closes a
 * nested array/dictionary, must not be mistaken for this array's own end. Used to
 * find the boundary of an object whose value is an array rather than a dictionary --
 * an Object Stream entry (interpretCompressedObject()) or an ordinary indirect object
 * (object()); either way the array's contents are kept as raw text, not parsed
 * element by element.
 */
function arrayEnd(bytes, position) {
  if (bytes[position] !== 0x5b) throw new Error("Expected a PDF array");
  let cursor = position + 1;
  let depth = 1;
  while (cursor < bytes.length && depth) {
    if (bytes[cursor] === 0x25) cursor = skipSpace(bytes, cursor);
    else if (bytes[cursor] === 0x28) cursor = skipLiteral(bytes, cursor);
    else if (bytes[cursor] === 0x3c && bytes[cursor + 1] === 0x3c) cursor = dictionaryEnd(bytes, cursor);
    else if (bytes[cursor] === 0x3c) {
      cursor += 1;
      while (cursor < bytes.length && bytes[cursor] !== 0x3e) cursor += 1;
      cursor += 1;
    } else if (bytes[cursor] === 0x5b) {
      depth += 1;
      cursor += 1;
    } else if (bytes[cursor] === 0x5d) {
      depth -= 1;
      cursor += 1;
    } else cursor += 1;
  }
  if (depth) throw new Error("Unterminated PDF array");
  return cursor;
}

function extractDictionary(bytes, position) {
  const start = skipSpace(bytes, position);
  if (bytes[start] !== 0x3c || bytes[start + 1] !== 0x3c) return null;
  const end = dictionaryEnd(bytes, start);
  return { start, end, text: decodeBinaryString(bytes.subarray(start, end)) };
}

function findLastStartXref(bytes) {
  const tailStart = Math.max(0, bytes.length - 8192);
  const tail = decodeBinaryString(bytes.subarray(tailStart));
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  if (!matches.length) throw new Error("PDF startxref was not found");
  return Number(matches.at(-1)[1]);
}

function parseTrailerDictionary(bytes, position) {
  const start = skipSpace(bytes, position);
  const end = dictionaryEnd(bytes, start);
  return { text: decodeBinaryString(bytes.subarray(start, end)), end };
}

function directInteger(dictionary, key) {
  return Number(dictionary.match(new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`, "s"))?.[1]);
}

function reference(dictionary, key) {
  const match = dictionary.match(new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`, "s"));
  return match ? { number: Number(match[1]), generation: Number(match[2]) } : null;
}

/** Parses a classic `xref ... trailer << ... >>` section. `cursor` points at "xref". */
function parseClassicXrefSection(bytes, cursor) {
  cursor += 4;
  const entries = [];
  while (true) {
    cursor = skipSpace(bytes, cursor);
    if (keywordAt(bytes, cursor, "trailer")) {
      const trailer = parseTrailerDictionary(bytes, cursor + 7).text;
      return { entries, trailer };
    }
    const first = readInteger(bytes, cursor);
    const count = readInteger(bytes, first.end);
    cursor = count.end;
    for (let index = 0; index < count.value; index += 1) {
      cursor = skipSpace(bytes, cursor);
      const lineEnd = (() => {
        let end = cursor;
        while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end += 1;
        return end;
      })();
      const line = decodeBinaryString(bytes.subarray(cursor, lineEnd));
      const match = line.match(/^(\d{10})\s+(\d{5})\s+([nf])/);
      if (!match) throw new Error(`Malformed xref entry for object ${first.value + index}`);
      entries.push({
        number: first.value + index,
        generation: Number(match[2]),
        offset: Number(match[1]),
        free: match[3] === "f"
      });
      cursor = lineEnd;
    }
  }
}

/**
 * Reads one indirect object's header, dictionary, and raw (still filtered) stream
 * bytes directly from a byte offset, without consulting an xref table. Used only to
 * bootstrap a cross-reference stream, before any xref table exists to look one up in.
 *
 * Per the PDF spec, a cross-reference stream's own /Length must be a direct integer
 * — an indirect /Length couldn't be resolved this early — so unlike
 * `PdfStructure#object()`, this never chases an indirect /Length.
 */
function readRawStreamObject(bytes, offset) {
  let cursor = skipSpace(bytes, offset);
  const objectNumber = readInteger(bytes, cursor);
  const generation = readInteger(bytes, objectNumber.end);
  cursor = skipSpace(bytes, generation.end);
  if (!keywordAt(bytes, cursor, "obj")) throw new Error(`PDF byte ${offset} does not start an indirect object`);
  cursor += 3;
  const dictionary = extractDictionary(bytes, cursor);
  if (!dictionary) throw new Error("Cross-reference stream object has no dictionary");
  cursor = skipSpace(bytes, dictionary.end);
  if (!keywordAt(bytes, cursor, "stream")) throw new Error("Cross-reference stream object has no stream data");
  cursor += 6;
  if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2;
  else if (bytes[cursor] === 10) cursor += 1;
  else throw new Error("Cross-reference stream must start after an EOL marker");
  const length = directInteger(dictionary.text, "Length");
  if (!Number.isInteger(length) || length < 0) throw new Error("Cross-reference stream has no direct /Length");
  const data = bytes.slice(cursor, cursor + length);
  const afterStream = skipSpace(bytes, cursor + length);
  if (!keywordAt(bytes, afterStream, "endstream")) throw new Error("Cross-reference stream length does not end at endstream");
  return { number: objectNumber.value, generation: generation.value, dictionary: dictionary.text, data };
}

// A generous upper bound on an individual /W field width, in bytes. Real xref streams
// use 1-5 byte fields; this only exists to reject obviously bogus values before they
// reach arithmetic below, not to model a real PDF limit.
const MAX_XREF_FIELD_WIDTH = 8;

function parseFieldWidths(dictionaryText) {
  const raw = dictionaryText.match(/\/W\s*\[([^\]]*)\]/s)?.[1];
  if (raw === undefined) throw new Error("Cross-reference stream has no /W");
  const widths = raw.trim() ? raw.trim().split(/\s+/).map(Number) : [];
  const valid = widths.length === 3 && widths.every((width) => Number.isInteger(width) && width >= 0 && width <= MAX_XREF_FIELD_WIDTH);
  if (!valid || widths[0] + widths[1] + widths[2] === 0) throw new Error("Cross-reference stream has an invalid /W");
  return widths;
}

function parseIndexPairs(dictionaryText, size) {
  const raw = dictionaryText.match(/\/Index\s*\[([^\]]*)\]/s)?.[1];
  if (raw === undefined) return [[0, size]];
  const numbers = raw.trim() ? raw.trim().split(/\s+/).map(Number) : [];
  if (numbers.length % 2 !== 0 || numbers.some((value) => !Number.isInteger(value))) {
    throw new Error("Cross-reference stream has an invalid /Index");
  }
  const pairs = [];
  let previousEnd = 0;
  for (let cursor = 0; cursor < numbers.length; cursor += 2) {
    const [start, count] = [numbers[cursor], numbers[cursor + 1]];
    const end = start + count;
    // The PDF spec requires /Index subsections to be ascending, non-overlapping, and
    // within [0, /Size). A subsection whose end exceeds /Size claims object numbers
    // the file's own /Size says do not exist (e.g. /Size 5 with /Index [4 2] reaches
    // object 5); one that starts before the previous subsection's end is out of order
    // or overlapping. Both are rejected rather than silently accepted.
    if (start < 0 || count < 0 || end > size || start < previousEnd) {
      throw new Error("Cross-reference stream has an invalid /Index");
    }
    pairs.push([start, count]);
    previousEnd = end;
  }
  return pairs;
}

function readBigEndianUint(bytes, offset, width) {
  let value = 0;
  for (let index = 0; index < width; index += 1) value = value * 256 + bytes[offset + index];
  return value;
}

/**
 * Decodes the fixed-width binary rows of a cross-reference stream into entries.
 * `decoded.length` must exactly match what /W and /Index imply; this is what keeps a
 * malformed /Index (or a stream that is too short) from reading out of bounds or
 * silently producing garbage entries instead of a clear error.
 */
function decodeXrefStreamEntries(decoded, widths, indexPairs) {
  const [typeWidth, field2Width, field3Width] = widths;
  const entrySize = typeWidth + field2Width + field3Width;
  const totalEntries = indexPairs.reduce((sum, [, count]) => sum + count, 0);
  if (decoded.length !== totalEntries * entrySize) {
    throw new Error("Cross-reference stream length does not match /W and /Index");
  }
  const entries = [];
  let cursor = 0;
  for (const [start, count] of indexPairs) {
    for (let offset = 0; offset < count; offset += 1) {
      // A zero-width type field defaults to type 1, per the PDF spec's entry table.
      const type = typeWidth === 0 ? 1 : readBigEndianUint(decoded, cursor, typeWidth);
      const field2 = readBigEndianUint(decoded, cursor + typeWidth, field2Width);
      const field3 = readBigEndianUint(decoded, cursor + typeWidth + field2Width, field3Width);
      cursor += entrySize;
      const number = start + offset;
      if (type === 1) entries.push({ number, free: false, offset: field2, generation: field3 });
      else if (type === 2) entries.push({ number, free: false, compressed: true, streamNumber: field2, indexInStream: field3 });
      // Type 0 (free), and any type this prototype does not recognise, are treated as
      // a free/null reference — the spec allows readers to treat unknown types this way.
      else entries.push({ number, free: true });
    }
  }
  return entries;
}

async function parseXrefStreamSection(bytes, offset) {
  const object = readRawStreamObject(bytes, offset);
  if (!/\/Type\s*\/XRef\b/.test(object.dictionary)) throw new Error("Expected a cross-reference stream");
  const decoded = await decodeStreamBytes(object.dictionary, object.data, `xref stream object ${object.number}`);
  const size = directInteger(object.dictionary, "Size");
  if (!Number.isInteger(size) || size < 0) throw new Error("Cross-reference stream has an invalid /Size");
  const widths = parseFieldWidths(object.dictionary);
  const indexPairs = parseIndexPairs(object.dictionary, size);
  const entries = decodeXrefStreamEntries(decoded, widths, indexPairs);
  return { entries, trailer: object.dictionary };
}

/** Dispatches to a classic `xref` table or an xref stream at `offset`, whichever is there. */
async function parseXrefSection(bytes, offset) {
  const cursor = skipSpace(bytes, offset);
  if (keywordAt(bytes, cursor, "xref")) return parseClassicXrefSection(bytes, cursor);
  return parseXrefStreamSection(bytes, cursor);
}

function mergeEntries(entries, decided, sectionEntries) {
  for (const entry of sectionEntries) {
    if (decided.has(entry.number)) continue;
    decided.add(entry.number);
    if (!entry.free) entries.set(entry.number, entry);
  }
}

async function collectXref(bytes) {
  const entries = new Map();
  // Sections are walked newest first, so the first entry seen for an object wins —
  // including a free one, which deletes the object instead of exposing the stale
  // offset that an older section still carries for it.
  const decided = new Set();
  const visited = new Set();
  const startXref = findLastStartXref(bytes);
  let offset = startXref;
  let latestTrailer;
  while (offset || !visited.size) {
    if (visited.has(offset)) throw new Error("Circular /Prev chain in PDF trailer");
    visited.add(offset);
    const section = await parseXrefSection(bytes, offset);
    latestTrailer ??= section.trailer;
    mergeEntries(entries, decided, section.entries);
    // A classic section's trailer may point to a companion xref stream (/XRefStm) that
    // covers objects the classic table omits, for hybrid-reference files. It is merged
    // at the same priority as the section that named it, and does not extend /Prev.
    const hybridOffset = directInteger(section.trailer, "XRefStm");
    if (Number.isInteger(hybridOffset) && hybridOffset >= 0) {
      const hybridSection = await parseXrefStreamSection(bytes, hybridOffset);
      mergeEntries(entries, decided, hybridSection.entries);
    }
    offset = directInteger(section.trailer, "Prev");
    if (!offset) break;
  }
  const root = reference(latestTrailer, "Root");
  const size = directInteger(latestTrailer, "Size");
  if (!root || !size) throw new Error("PDF trailer must contain /Root and /Size");
  // The xref table itself is not affected by encryption (object offsets, /Root, and
  // /Size are always readable), so resolving it succeeds either way. Editing is
  // refused later, once the Encrypt dictionary has been read for diagnosis — see
  // PdfTextEditor#listTextRuns() in pdf-document.js.
  const encryptReference = reference(latestTrailer, "Encrypt");
  // The Standard Security Handler's key derivation hashes in the trailer's first
  // /ID element (PDF spec 7.6.3.3, Algorithm 2 step e) -- see src/security/decrypt.js.
  const idBytes = firstIdBytes(latestTrailer);
  return { entries, root, size, previousXref: startXref, encryptReference, idBytes };
}

/**
 * Reads `/key` from an Object Stream's dictionary as a strict PDF integer -- the
 * whole token, not just a leading run of digits (unlike directInteger(), used
 * elsewhere in this file for structural values this parser already trusts more,
 * e.g. /Size or /Prev). `/N 3.5` or `/First 12foo` must be rejected outright, not
 * silently read as 3 or 12: a compressed object's byte range is computed directly
 * from these two values, so a truncated misread here would not just misreport a
 * diagnostic field, it would slice the wrong bytes out of the stream. Throws
 * immediately (naming the actual offending token) rather than returning something
 * parseObjectStream() would have to reject a second time with a vaguer message.
 */
function strictObjectStreamInteger(dictionaryText, key, streamNumber) {
  const token = readToken(dictionaryText, key);
  if (token === undefined) throw new Error(`Object stream ${streamNumber} has no /${key}`);
  const value = parseStrictInteger(token);
  if (value === null) throw new Error(`Malformed object stream /${key}: ${token}`);
  return value;
}

function parseReferenceArray(text, key) {
  const array = text.match(new RegExp(`/${key}\\s*\\[(.*?)\\]`, "s"))?.[1];
  if (array) return [...array.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((match) => ({ number: Number(match[1]), generation: Number(match[2]) }));
  const single = reference(text, key);
  return single ? [single] : [];
}

/**
 * Interprets one Object Stream entry's raw bytes (see parseObjectStream() in
 * object-stream.js) as a PDF object, in a shape compatible with what object()
 * returns for a type 1 object (`{ number, generation, dictionary, data, value }`),
 * plus `rawValue` for the value shapes that model doesn't otherwise have a field
 * for. Per PDF spec 7.5.7, a compressed object is never a stream (and, in practice,
 * never a bare indirect reference on its own either -- a reference is only ever a
 * component of some other value); every other ordinary object shape -- dictionary,
 * array, name, string, number, boolean, null -- is legal here and handled below.
 * This codebase's own resolution needs (Catalog/Pages/Page/Resources/Font -- see
 * pageContentObjects() and pdf-document.js's font/resource lookups) only ever
 * exercise the dictionary case, but a compressed object that happens to be
 * something else is still resolved correctly rather than rejected as unsupported;
 * only a genuinely disallowed shape (a stream) is rejected, and explicitly.
 */
/**
 * An Object Stream entry's byte range holds exactly one PDF value (its bounds come
 * from the header's offsets, not from any terminator of its own -- see
 * parseObjectStream() in object-stream.js). Reading a value only from its start
 * would silently accept trailing garbage after it (`42 /Foo`, `trueX`, `[1 2] /Foo`)
 * as if the entry were merely `42`/`true`/`[1 2]` with an ignored remainder -- an
 * unintended value taken from a malformed or hostile PDF. Called once per branch of
 * interpretCompressedObject() below, after that branch has located its value's own
 * end, to confirm nothing but whitespace/comments (skipWhite() already skips both)
 * remains before the entry's byte range runs out.
 */
function requireObjectEnd(bytes, valueEnd, streamNumber, objectNumber) {
  if (skipSpace(bytes, valueEnd) !== bytes.length) {
    throw new Error(`Object stream ${streamNumber}: compressed object ${objectNumber} has trailing tokens after its value`);
  }
}

function interpretCompressedObject(entry, streamNumber) {
  const base = { number: entry.objectNumber, generation: 0, dictionary: "", data: null, value: null, rawValue: null };
  const bytes = entry.bytes;
  const start = skipSpace(bytes, 0);
  const byte = bytes[start];
  const end = (valueEnd) => requireObjectEnd(bytes, valueEnd, streamNumber, entry.objectNumber);

  if (byte === 0x3c && bytes[start + 1] === 0x3c) {
    const dictionary = extractDictionary(bytes, start);
    if (!dictionary) throw new Error(`Object stream ${streamNumber}: malformed dictionary for compressed object ${entry.objectNumber}`);
    // A dictionary immediately followed by "stream" would be a stream object, which
    // PDF spec 7.5.7 explicitly disallows inside an Object Stream -- rejected here
    // rather than silently treated as if the stream keyword were not there.
    if (keywordAt(bytes, skipSpace(bytes, dictionary.end), "stream")) {
      throw new Error(`Object stream ${streamNumber}: compressed object ${entry.objectNumber} is a stream object, which is not permitted inside an Object Stream`);
    }
    end(dictionary.end);
    return { ...base, dictionary: dictionary.text };
  }
  if (byte === 0x5b) {
    const cursor = arrayEnd(bytes, start);
    end(cursor);
    return { ...base, rawValue: decodeBinaryString(bytes.subarray(start, cursor)) };
  }
  if (byte === 0x2f) {
    let cursor = start + 1;
    while (isRegular(bytes[cursor])) cursor += 1;
    end(cursor);
    return { ...base, rawValue: decodeBinaryString(bytes.subarray(start, cursor)) };
  }
  if (byte === 0x28) {
    const literal = readLiteral(bytes, start);
    end(literal.end);
    return { ...base, rawValue: literal.value };
  }
  if (byte === 0x3c) {
    const hex = readHex(bytes, start);
    end(hex.end);
    return { ...base, rawValue: hex.value };
  }
  if (keywordAt(bytes, start, "true")) {
    end(start + 4);
    return { ...base, value: true };
  }
  if (keywordAt(bytes, start, "false")) {
    end(start + 5);
    return { ...base, value: false };
  }
  if (keywordAt(bytes, start, "null")) {
    end(start + 4);
    return { ...base, value: null, rawValue: "null" };
  }
  if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
    let cursor = start + (bytes[start] === 0x2b || bytes[start] === 0x2d ? 1 : 0);
    while ((bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) || bytes[cursor] === 0x2e) cursor += 1;
    const value = Number(decodeBinaryString(bytes.subarray(start, cursor)));
    if (!Number.isFinite(value)) throw new Error(`Object stream ${streamNumber}: malformed number for compressed object ${entry.objectNumber}`);
    // A PDF number is only digits/sign/decimal point -- never exponent notation
    // ("1e3"), which the digit scan above stops at ("1"), leaving "e3" as trailing
    // tokens for the check below to reject.
    end(cursor);
    return { ...base, value };
  }
  throw new Error(
    `Object stream ${streamNumber}: compressed object ${entry.objectNumber} has an unsupported or malformed value ` +
    "(a stream object is never valid inside an Object Stream)"
  );
}

export class PdfStructure {
  constructor(bytes) {
    this.bytes = bytes;
    this.cache = new Map();
    this._xrefReady = null;
    // ObjStm object number -> parseObjectStream()'s entries for it (decode once per
    // Object Stream per instance; see decodeObjectStream()). Never touches password
    // or file-key material itself -- only the already-decoded plaintext bytes.
    this.objectStreamCache = new Map();
  }

  /**
   * Resolves the xref table (classic, an xref stream, or a /Prev-chained mix of
   * both), populating `entries` / `root` / `size` / `previousXref`. An xref stream
   * needs Flate decompression to read, which is asynchronous, so this is lazy:
   * nothing here runs until the first thing that actually needs the table asks for
   * it — keeping `new PdfTextEditor(bytes)` itself synchronous and free of I/O.
   */
  ensureXref() {
    if (!this._xrefReady) {
      this._xrefReady = collectXref(this.bytes).then((xref) => {
        Object.assign(this, xref);
      });
    }
    return this._xrefReady;
  }

  /**
   * Resolves a type 1 (normal indirect) object only -- synchronous, since reading
   * one straight out of `this.bytes` needs no I/O. A type 2 (compressed) object
   * needs its Object Stream decoded first (FlateDecode, Predictor, and possibly
   * AES -- see decodeObjectStream()), which is why that path is async: use
   * resolveObject() instead when a reference might be compressed.
   */
  object(referenceOrNumber) {
    const number = typeof referenceOrNumber === "number" ? referenceOrNumber : referenceOrNumber.number;
    if (this.cache.has(number)) return this.cache.get(number);
    const entry = this.entries.get(number);
    if (!entry) throw new Error(`PDF object ${number} is missing from the xref table`);
    if (entry.compressed) {
      throw new Error(`PDF object ${number} is a compressed object stored in object stream ${entry.streamNumber}; use resolveObject() instead of object() to resolve it`);
    }
    let cursor = skipSpace(this.bytes, entry.offset);
    const objectNumber = readInteger(this.bytes, cursor);
    const generation = readInteger(this.bytes, objectNumber.end);
    cursor = skipSpace(this.bytes, generation.end);
    if (objectNumber.value !== number || !keywordAt(this.bytes, cursor, "obj")) {
      throw new Error(`xref offset for PDF object ${number} is invalid`);
    }
    cursor += 3;
    const dictionary = extractDictionary(this.bytes, cursor);
    const object = { number, generation: generation.value, dictionary: dictionary?.text ?? "", data: null, value: null, rawValue: null };
    if (dictionary) {
      cursor = skipSpace(this.bytes, dictionary.end);
      if (keywordAt(this.bytes, cursor, "stream")) {
        cursor += 6;
        if (this.bytes[cursor] === 13 && this.bytes[cursor + 1] === 10) cursor += 2;
        else if (this.bytes[cursor] === 10) cursor += 1;
        else throw new Error(`PDF stream ${number} must start after an EOL marker`);
        let length = directInteger(dictionary.text, "Length");
        if (!Number.isInteger(length)) {
          const lengthReference = reference(dictionary.text, "Length");
          if (!lengthReference) throw new Error(`PDF stream ${number} has no valid /Length`);
          const lengthObject = this.object(lengthReference);
          if (!Number.isInteger(lengthObject.value) || lengthObject.value < 0) throw new Error(`Indirect /Length for stream ${number} is invalid`);
          length = lengthObject.value;
        }
        object.data = this.bytes.slice(cursor, cursor + length);
        const afterStream = skipSpace(this.bytes, cursor + length);
        if (!keywordAt(this.bytes, afterStream, "endstream")) throw new Error(`PDF stream ${number} length does not end at endstream`);
      }
    } else if (this.bytes[skipSpace(this.bytes, cursor)] === 0x2f) {
      // A bare name object -- how a PDF may write, for instance, a Type0 font's
      // `/Encoding /Identity-H` indirectly. Kept as its own text, like the array below.
      const start = skipSpace(this.bytes, cursor);
      let valueEnd = start + 1;
      while (isRegular(this.bytes[valueEnd])) valueEnd += 1;
      if (!keywordAt(this.bytes, skipSpace(this.bytes, valueEnd), "endobj")) {
        throw new Error(`PDF name object ${number} does not end at endobj`);
      }
      object.rawValue = decodeBinaryString(this.bytes.subarray(start, valueEnd));
    } else if (this.bytes[skipSpace(this.bytes, cursor)] === 0x5b) {
      // A bare array object -- what a PDF writer produces for a long /Widths or /W (see
      // font-metrics.js), and legal wherever an array is expected. Its text is kept whole,
      // exactly as interpretCompressedObject() keeps a compressed one's; whoever asked for
      // it parses its elements, and only the shapes they accept are ever read.
      const start = skipSpace(this.bytes, cursor);
      const valueEnd = arrayEnd(this.bytes, start);
      if (!keywordAt(this.bytes, skipSpace(this.bytes, valueEnd), "endobj")) {
        throw new Error(`PDF array object ${number} does not end at endobj`);
      }
      object.rawValue = decodeBinaryString(this.bytes.subarray(start, valueEnd));
    } else {
      const scalar = readInteger(this.bytes, cursor);
      const terminator = skipSpace(this.bytes, scalar.end);
      if (!keywordAt(this.bytes, terminator, "endobj")) throw new Error(`Unsupported non-dictionary PDF object ${number}`);
      object.value = scalar.value;
    }
    this.cache.set(number, object);
    return object;
  }

  /**
   * Resolves any object -- type 1 (a normal indirect object, via the synchronous
   * object() above, which this shares its cache with) or type 2 (compressed inside
   * an Object Stream). Kept separate from object() rather than making the whole
   * object model async: only Object Streams need decoding (FlateDecode, Predictor,
   * and possibly AES -- see decodeObjectStream()), so only the call sites that can
   * actually hit a type 2 entry (pageContentObjects() below, and
   * pdf-document.js's font/resource lookups) need to await this instead.
   *
   * `security`/`decrypt` are only consulted for a type 2 entry, and only when the
   * PDF is encrypted: `decrypt` is the same decryptStreamBytes()-shaped function
   * pdf-document.js already uses for content streams, passed in rather than
   * imported here so this module stays unaware of what encryption even is (as it
   * already was before this) -- it just calls what it's given.
   */
  async resolveObject(referenceOrNumber, security, decrypt) {
    const number = typeof referenceOrNumber === "number" ? referenceOrNumber : referenceOrNumber.number;
    if (this.cache.has(number)) return this.cache.get(number);
    const entry = this.entries.get(number);
    if (!entry) throw new Error(`PDF object ${number} is missing from the xref table`);
    if (!entry.compressed) return this.object(number);
    const objectStreamEntries = await this.decodeObjectStream(entry.streamNumber, security, decrypt);
    if (entry.indexInStream < 0 || entry.indexInStream >= objectStreamEntries.length) {
      throw new Error(
        `Object stream index is out of range: object ${number} references index ${entry.indexInStream}` +
        ` in object stream ${entry.streamNumber}, which holds ${objectStreamEntries.length} object(s)`
      );
    }
    const found = objectStreamEntries[entry.indexInStream];
    if (found.objectNumber !== number) {
      throw new Error(
        `Object stream object number mismatch: xref expected object ${number}, ` +
        `object stream ${entry.streamNumber} index ${entry.indexInStream} contains object ${found.objectNumber}`
      );
    }
    const object = interpretCompressedObject(found, entry.streamNumber);
    this.cache.set(number, object);
    return object;
  }

  /**
   * Decodes Object Stream `streamNumber` into its component objects' byte ranges
   * (see parseObjectStream() in object-stream.js), decoding it at most once per
   * instance (objectStreamCache) regardless of how many of its compressed objects
   * are actually resolved.
   *
   * Decode order, per PDF spec 7.6 (encryption applies to the Object Stream itself
   * as a whole, before anything inside it is interpreted -- individual compressed
   * objects are never separately encrypted, so their generation number, always 0
   * per spec, plays no part in this): raw stream bytes -> AES decrypt (using the
   * Object Stream object's own number/generation, when `security` is set) ->
   * FlateDecode -> Predictor (both via the same decodeStreamBytes() every other
   * stream in this codebase uses) -> header/object parsing. This is exactly the
   * same pipeline decodeStream() in pdf-document.js applies to a content stream;
   * only the last step (interpreting the plaintext) differs.
   */
  async decodeObjectStream(streamNumber, security, decrypt) {
    if (this.objectStreamCache.has(streamNumber)) return this.objectStreamCache.get(streamNumber);
    const objectStream = this.object(streamNumber);
    if (!/\/Type\s*\/ObjStm\b/.test(objectStream.dictionary)) {
      throw new Error(`PDF object ${streamNumber} is not an object stream (expected /Type /ObjStm)`);
    }
    const objectCount = strictObjectStreamInteger(objectStream.dictionary, "N", streamNumber);
    const firstOffset = strictObjectStreamInteger(objectStream.dictionary, "First", streamNumber);
    const rawData = security
      ? await decrypt(security, { objectNumber: objectStream.number, generation: objectStream.generation, bytes: objectStream.data })
      : objectStream.data;
    const decoded = await decodeStreamBytes(objectStream.dictionary, rawData, `object stream ${streamNumber}`);
    const entries = parseObjectStream(decoded, { objectCount, firstOffset });
    this.objectStreamCache.set(streamNumber, entries);
    return entries;
  }

  /**
   * `security`/`decrypt`: see resolveObject() above. Both are optional and only
   * matter when the Catalog, a Pages/Page node, or a Resources dictionary happens
   * to be a compressed (type 2) object -- Contents (always a stream) never is, per
   * spec, so that lookup stays on the synchronous object() unchanged.
   */
  async pageContentObjects(security, decrypt) {
    const catalog = await this.resolveObject(this.root, security, decrypt);
    const pagesReference = reference(catalog.dictionary, "Pages");
    if (!pagesReference) throw new Error("PDF catalog has no /Pages reference");
    const result = [];
    const ancestors = new Set();
    const visited = new Set();
    const visit = async (pageReference, inheritedResources = null) => {
      if (ancestors.has(pageReference.number)) throw new Error("Circular /Kids chain in the PDF page tree");
      // A node reachable by more than one path is walked once; without this a page
      // tree that repeats a node would report its content streams several times.
      if (visited.has(pageReference.number)) return;
      visited.add(pageReference.number);
      ancestors.add(pageReference.number);
      const page = await this.resolveObject(pageReference, security, decrypt);
      const resourcesReference = reference(page.dictionary, "Resources");
      const resources = resourcesReference
        ? await this.resolveObject(resourcesReference, security, decrypt)
        : (/\/Resources\s*<</.test(page.dictionary) ? page : inheritedResources);
      if (/\/Type\s*\/Pages\b/.test(page.dictionary)) {
        for (const kid of parseReferenceArray(page.dictionary, "Kids")) await visit(kid, resources);
      } else if (/\/Type\s*\/Page\b/.test(page.dictionary)) {
        for (const content of parseReferenceArray(page.dictionary, "Contents")) result.push({
          object: this.object(content),
          resources: resources ?? { dictionary: page.dictionary }
        });
      }
      ancestors.delete(pageReference.number);
    };
    await visit(pagesReference);
    return result;
  }
}

export { directInteger, parseReferenceArray, reference };
