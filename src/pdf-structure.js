import { skipWhite as skipSpace } from "./syntax.js";

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

function parseXrefSection(bytes, offset) {
  let cursor = skipSpace(bytes, offset);
  if (!keywordAt(bytes, cursor, "xref")) {
    throw new Error("Cross-reference streams are not supported by this prototype");
  }
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

function collectXref(bytes) {
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
    const section = parseXrefSection(bytes, offset);
    latestTrailer ??= section.trailer;
    for (const entry of section.entries) {
      if (decided.has(entry.number)) continue;
      decided.add(entry.number);
      if (!entry.free) entries.set(entry.number, entry);
    }
    offset = directInteger(section.trailer, "Prev");
    if (!offset) break;
  }
  const root = reference(latestTrailer, "Root");
  const size = directInteger(latestTrailer, "Size");
  if (!root || !size) throw new Error("PDF trailer must contain /Root and /Size");
  if (/\/Encrypt\b/.test(latestTrailer)) throw new Error("Encrypted PDFs are not supported");
  return { entries, root, size, previousXref: startXref };
}

function extractDictionary(bytes, position) {
  const start = skipSpace(bytes, position);
  if (bytes[start] !== 0x3c || bytes[start + 1] !== 0x3c) return null;
  const end = dictionaryEnd(bytes, start);
  return { start, end, text: latin1.decode(bytes.subarray(start, end)) };
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
    const xref = collectXref(bytes);
    Object.assign(this, xref);
    this.cache = new Map();
  }

  object(referenceOrNumber) {
    const number = typeof referenceOrNumber === "number" ? referenceOrNumber : referenceOrNumber.number;
    if (this.cache.has(number)) return this.cache.get(number);
    const entry = this.entries.get(number);
    if (!entry) throw new Error(`PDF object ${number} is missing from the xref table`);
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
