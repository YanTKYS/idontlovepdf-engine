import { replaceTextRuns, scanTextRuns } from "./content-stream.js";
import { decodeWithCMap, encodeWithCMap, parseToUnicodeCMap } from "./cmap.js";
import { deflate, decodeStreamBytes, filters } from "./flate.js";
import { PdfStructure, reference } from "./pdf-structure.js";

const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

function encodeSingleByte(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) throw new Error("String replacements are limited to single-byte characters; pass encoded Uint8Array data for composite fonts");
    bytes[index] = code;
  }
  return bytes;
}

function concat(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function decodeStream(object, kind) {
  return decodeStreamBytes(object.dictionary, object.data, `${kind} object ${object.number}`);
}

function replacementDictionary(dictionary, length) {
  // save() re-deflates the decoded (already predictor-reversed) content directly,
  // without re-applying any predictor (see save()'s comment). A /DecodeParms carried
  // over from the original stream would tell a reader reopening this file to reverse
  // a predictor that the new bytes were never encoded with, so it is dropped here.
  const withoutDecodeParms = dictionary
    .replace(/\/DecodeParms\s*\[\s*<<[\s\S]*?>>\s*\]/, "")
    .replace(/\/DecodeParms\s*<<[\s\S]*?>>/, "");
  if (/\/Length\s+\d+\s+\d+\s+R/.test(withoutDecodeParms)) return withoutDecodeParms.replace(/\/Length\s+\d+\s+\d+\s+R/, `/Length ${length}`);
  if (/\/Length\s+\d+/.test(withoutDecodeParms)) return withoutDecodeParms.replace(/\/Length\s+\d+/, `/Length ${length}`);
  return withoutDecodeParms.replace(/>>\s*$/, `/Length ${length} >>`);
}

function fontReferences(resources, structure) {
  const indirect = reference(resources.dictionary, "Font");
  const fontDictionary = indirect ? structure.object(indirect).dictionary : resources.dictionary.match(/\/Font\s*<<(.*?)>>/s)?.[1] ?? "";
  return new Map([...fontDictionary.matchAll(/\/([^\s/<>{}\[\]()]+)\s+(\d+)\s+(\d+)\s+R/g)].map((match) => [
    match[1], { number: Number(match[2]), generation: Number(match[3]) }
  ]));
}

async function loadFontMaps(resources, structure) {
  const result = new Map();
  for (const [name, fontReference] of fontReferences(resources, structure)) {
    const font = structure.object(fontReference);
    const toUnicode = reference(font.dictionary, "ToUnicode");
    if (!toUnicode) continue;
    const cmapObject = structure.object(toUnicode);
    result.set(name, parseToUnicodeCMap(await decodeStream(cmapObject, "ToUnicode stream")));
  }
  return result;
}

export class PdfTextEditor {
  constructor(input) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (latin1.decode(this.bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Input is not a PDF document");
    this.document = new PdfStructure(this.bytes);
    this.streams = null;
    this.pending = new Map();
  }

  async listTextRuns() {
    if (!this.streams) {
      // The xref table may live in an xref stream, which needs Flate decompression
      // (async) to read. Resolving it here, on first use, keeps the constructor
      // itself synchronous and free of I/O.
      await this.document.ensureXref();
      this.streams = [];
      const seen = new Set();
      for (const { object, resources } of this.document.pageContentObjects()) {
        // One content stream can be shared by several pages, and /Contents may even
        // list it twice. Run ids are keyed by object number, so scanning it more than
        // once would hand out duplicate ids and append the object twice on save.
        if (seen.has(object.number)) continue;
        seen.add(object.number);
        const decoded = await decodeStream(object, "content stream");
        const runs = scanTextRuns(decoded);
        if (runs.length) this.streams.push({ object, decoded, runs, fontMaps: await loadFontMaps(resources, this.document) });
      }
    }
    return this.streams.flatMap((stream) => stream.runs.map((run, runIndex) => ({
      id: `${stream.object.number}:${runIndex}`,
      objectNumber: stream.object.number,
      textObjectId: run.textObjectId,
      text: decodeWithCMap(run.value, stream.fontMaps.get(run.fontName)),
      fontName: run.fontName,
      bytes: run.value.slice()
    })));
  }

  async replaceText(id, replacement) {
    const runs = await this.listTextRuns();
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`Unknown text run: ${id}`);
    const stream = this.streams.find((candidate) => candidate.object.number === run.objectNumber);
    const mappings = stream.fontMaps.get(run.fontName);
    const bytes = typeof replacement === "string"
      ? (mappings ? encodeWithCMap(replacement, mappings) : encodeSingleByte(replacement))
      : replacement;
    this.pending.set(id, Uint8Array.from(bytes));
    return this;
  }

  async save() {
    await this.listTextRuns();
    if (!this.pending.size) return this.bytes.slice();
    const updates = [];
    for (const stream of this.streams) {
      const replacements = stream.runs.flatMap((_, runIndex) => {
        const bytes = this.pending.get(`${stream.object.number}:${runIndex}`);
        return bytes ? [{ runIndex, bytes }] : [];
      });
      if (!replacements.length) continue;
      let data = replaceTextRuns(stream.decoded, replacements);
      // stream.decoded is already predictor-reversed (see decodeStreamBytes()); the
      // edited bytes are re-deflated as plain FlateDecode without reapplying a
      // predictor. replacementDictionary() drops any /DecodeParms accordingly.
      if (filters(stream.object.dictionary)[0] === "FlateDecode") data = await deflate(data);
      updates.push({ ...stream.object, dictionary: replacementDictionary(stream.object.dictionary, data.length), data });
    }
    const chunks = [this.bytes, encoder.encode(this.bytes.at(-1) === 10 ? "" : "\n")];
    const offsets = [];
    let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    for (const update of updates) {
      const head = encoder.encode(`${update.number} ${update.generation} obj\n${update.dictionary}\nstream\n`);
      const tail = encoder.encode("\nendstream\nendobj\n");
      offsets.push({ number: update.number, generation: update.generation, offset });
      chunks.push(head, update.data, tail);
      offset += head.length + update.data.length + tail.length;
    }
    const xrefOffset = offset;
    chunks.push(encoder.encode("xref\n"));
    offsets.sort((a, b) => a.number - b.number);
    for (const entry of offsets) {
      chunks.push(encoder.encode(`${entry.number} 1\n${String(entry.offset).padStart(10, "0")} ${String(entry.generation).padStart(5, "0")} n \n`));
    }
    chunks.push(encoder.encode(
      `trailer\n<< /Size ${this.document.size} /Root ${this.document.root.number} ${this.document.root.generation} R /Prev ${this.document.previousXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    ));
    return concat(chunks);
  }
}
