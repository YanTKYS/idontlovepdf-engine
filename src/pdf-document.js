import { replaceTextRuns, scanTextRuns } from "./content-stream.js";

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

async function transformWithStream(bytes, format, StreamClass) {
  const stream = new Blob([bytes]).stream().pipeThrough(new StreamClass(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("FlateDecode requires the browser DecompressionStream API");
  return transformWithStream(bytes, "deflate", DecompressionStream);
}

async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") throw new Error("FlateDecode requires the browser CompressionStream API");
  return transformWithStream(bytes, "deflate", CompressionStream);
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

function parseDocument(bytes) {
  const source = latin1.decode(bytes);
  if (!source.startsWith("%PDF-")) throw new Error("Input is not a PDF document");
  const objectsByNumber = new Map();
  const pattern = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  for (let match; (match = pattern.exec(source));) {
    const bodyStart = pattern.lastIndex;
    const end = source.indexOf("endobj", bodyStart);
    if (end < 0) throw new Error(`PDF object ${match[1]} is not terminated`);
    const streamKeyword = source.indexOf("stream", bodyStart);
    if (streamKeyword < 0 || streamKeyword > end) continue;
    let streamStart = streamKeyword + 6;
    if (source[streamStart] === "\r" && source[streamStart + 1] === "\n") streamStart += 2;
    else if (source[streamStart] === "\r" || source[streamStart] === "\n") streamStart += 1;
    const streamEnd = source.lastIndexOf("endstream", end);
    if (streamEnd < streamStart) continue;
    let dataEnd = streamEnd;
    if (source[dataEnd - 1] === "\n") dataEnd -= 1;
    if (source[dataEnd - 1] === "\r") dataEnd -= 1;
    objectsByNumber.set(Number(match[1]), {
      number: Number(match[1]), generation: Number(match[2]),
      dictionary: source.slice(bodyStart, streamKeyword).trim(),
      data: bytes.slice(streamStart, dataEnd)
    });
  }
  const starts = [...source.matchAll(/startxref\s+(\d+)\s+%%EOF/g)];
  if (!starts.length) throw new Error("PDF startxref was not found");
  const trailers = [...source.matchAll(/trailer\s*<<(.*?)>>/gs)];
  if (!trailers.length) throw new Error("Cross-reference streams are not supported by this prototype");
  const trailer = trailers.at(-1)[1];
  const root = trailer.match(/\/Root\s+(\d+\s+\d+\s+R)/)?.[1];
  const size = Number(trailer.match(/\/Size\s+(\d+)/)?.[1]);
  if (!root || !size) throw new Error("PDF trailer must contain /Root and /Size");
  if (/\/Encrypt\b/.test(trailer)) throw new Error("Encrypted PDFs are not supported");
  return { objects: [...objectsByNumber.values()], root, size, previousXref: Number(starts.at(-1)[1]) };
}

function filters(dictionary) {
  const array = dictionary.match(/\/Filter\s*\[(.*?)\]/s)?.[1];
  if (array) return [...array.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1]);
  const single = dictionary.match(/\/Filter\s*\/([A-Za-z0-9]+)/)?.[1];
  return single ? [single] : [];
}

async function decodeStream(object) {
  const applied = filters(object.dictionary);
  if (applied.length === 0) return object.data;
  if (applied.length === 1 && applied[0] === "FlateDecode") return inflate(object.data);
  throw new Error(`Unsupported stream filter: ${applied.join(", ")}`);
}

function replacementDictionary(dictionary, length) {
  if (/\/Length\s+\d+\s+\d+\s+R/.test(dictionary)) {
    throw new Error("Indirect stream /Length values are not supported");
  }
  if (/\/Length\s+\d+/.test(dictionary)) return dictionary.replace(/\/Length\s+\d+/, `/Length ${length}`);
  return dictionary.replace(/>>\s*$/, `/Length ${length} >>`);
}

export class PdfTextEditor {
  constructor(input) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.document = parseDocument(this.bytes);
    this.streams = null;
    this.pending = new Map();
  }

  async listTextRuns() {
    if (!this.streams) {
      this.streams = [];
      for (const object of this.document.objects) {
        const decoded = await decodeStream(object);
        const runs = scanTextRuns(decoded);
        if (runs.length) this.streams.push({ object, decoded, runs });
      }
    }
    return this.streams.flatMap((stream) => stream.runs.map((run, runIndex) => ({
      id: `${stream.object.number}:${runIndex}`,
      objectNumber: stream.object.number,
      text: latin1.decode(run.value),
      bytes: run.value.slice()
    })));
  }

  async replaceText(id, replacement) {
    const runs = await this.listTextRuns();
    if (!runs.some((run) => run.id === id)) throw new Error(`Unknown text run: ${id}`);
    const bytes = typeof replacement === "string" ? encodeSingleByte(replacement) : replacement;
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
      `trailer\n<< /Size ${this.document.size} /Root ${this.document.root} /Prev ${this.document.previousXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    ));
    return concat(chunks);
  }
}
