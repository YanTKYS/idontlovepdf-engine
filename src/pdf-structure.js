import { skipWhite as skipSpace } from "./syntax.js";
import { decodeStreamBytes } from "./flate.js";
import { firstIdBytes } from "./pdf-dictionary-text.js";

const latin1 = new TextDecoder("latin1");

function readInteger(bytes, position) {
  const start = skipSpace(bytes, position);
  let cursor = start;
  while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1;
  if (cursor === start) throw new Error(`Expected an integer at PDF byte ${start}`);
  return { value: Number(latin1.decode(bytes.subarray(start, cursor))), end: cursor };
}

function keywordAt(bytes, position, keyword) {
  return latin1.decode(bytes.subarray(position, position + keyword.length)) === keyword;
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

function extractDictionary(bytes, position) {
  const start = skipSpace(bytes, position);
  if (bytes[start] !== 0x3c || bytes[start + 1] !== 0x3c) return null;
  const end = dictionaryEnd(bytes, start);
  return { start, end, text: latin1.decode(bytes.subarray(start, end)) };
}

function findLastStartXref(bytes) {
  const tailStart = Math.max(0, bytes.length - 8192);
  const tail = latin1.decode(bytes.subarray(tailStart));
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  if (!matches.length) throw new Error("PDF startxref was not found");
  return Number(matches.at(-1)[1]);
}

function parseTrailerDictionary(bytes, position) {
  const start = skipSpace(bytes, position);
  const end = dictionaryEnd(bytes, start);
  return { text: latin1.decode(bytes.subarray(start, end)), end };
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
      const line = latin1.decode(bytes.subarray(cursor, lineEnd));
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

function parseReferenceArray(text, key) {
  const array = text.match(new RegExp(`/${key}\\s*\\[(.*?)\\]`, "s"))?.[1];
  if (array) return [...array.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((match) => ({ number: Number(match[1]), generation: Number(match[2]) }));
  const single = reference(text, key);
  return single ? [single] : [];
}

export class PdfStructure {
  constructor(bytes) {
    this.bytes = bytes;
    this.cache = new Map();
    this._xrefReady = null;
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

  object(referenceOrNumber) {
    const number = typeof referenceOrNumber === "number" ? referenceOrNumber : referenceOrNumber.number;
    if (this.cache.has(number)) return this.cache.get(number);
    const entry = this.entries.get(number);
    if (!entry) throw new Error(`PDF object ${number} is missing from the xref table`);
    if (entry.compressed) {
      throw new Error(`Object streams are not supported (PDF object ${number} is stored in object stream ${entry.streamNumber})`);
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
    const object = { number, generation: generation.value, dictionary: dictionary?.text ?? "", data: null, value: null };
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
    } else {
      const scalar = readInteger(this.bytes, cursor);
      const terminator = skipSpace(this.bytes, scalar.end);
      if (!keywordAt(this.bytes, terminator, "endobj")) throw new Error(`Unsupported non-dictionary PDF object ${number}`);
      object.value = scalar.value;
    }
    this.cache.set(number, object);
    return object;
  }

  pageContentObjects() {
    const catalog = this.object(this.root);
    const pagesReference = reference(catalog.dictionary, "Pages");
    if (!pagesReference) throw new Error("PDF catalog has no /Pages reference");
    const result = [];
    const ancestors = new Set();
    const visited = new Set();
    const visit = (pageReference, inheritedResources = null) => {
      if (ancestors.has(pageReference.number)) throw new Error("Circular /Kids chain in the PDF page tree");
      // A node reachable by more than one path is walked once; without this a page
      // tree that repeats a node would report its content streams several times.
      if (visited.has(pageReference.number)) return;
      visited.add(pageReference.number);
      ancestors.add(pageReference.number);
      const page = this.object(pageReference);
      const resourcesReference = reference(page.dictionary, "Resources");
      const resources = resourcesReference
        ? this.object(resourcesReference)
        : (/\/Resources\s*<</.test(page.dictionary) ? page : inheritedResources);
      if (/\/Type\s*\/Pages\b/.test(page.dictionary)) {
        for (const kid of parseReferenceArray(page.dictionary, "Kids")) visit(kid, resources);
      } else if (/\/Type\s*\/Page\b/.test(page.dictionary)) {
        for (const content of parseReferenceArray(page.dictionary, "Contents")) result.push({
          object: this.object(content),
          resources: resources ?? { dictionary: page.dictionary }
        });
      }
      ancestors.delete(pageReference.number);
    };
    visit(pagesReference);
    return result;
  }
}

export { directInteger, parseReferenceArray, reference };
