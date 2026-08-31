import { replaceTextRuns, scanTextRuns } from "./content-stream.js";
import { decodeWithCMap, encodeWithCMap, parseToUnicodeCMap } from "./cmap.js";
import { summarizeEncryption } from "./encryption.js";
import { deflate, decodeStreamBytes, filters } from "./flate.js";
import { PdfStructure, reference } from "./pdf-structure.js";
import { authenticateEncryptedPdf, decryptStreamBytes } from "./security/decrypt.js";

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

/**
 * Decrypts (when `security` is set -- an authenticated encrypted PDF) and then
 * inflates one stream object's bytes. Decryption always runs before FlateDecode:
 * the PDF spec encrypts the *filtered* stream bytes, so a Crypt Filter is
 * conceptually the outermost filter, applied first on read (and would be the last
 * one applied on write, which is exactly why save() refuses encrypted PDFs instead
 * of re-encrypting -- see PdfTextEditor#save()).
 */
async function decodeStream(object, kind, security) {
  const data = security
    ? await decryptStreamBytes(security, { objectNumber: object.number, generation: object.generation, bytes: object.data })
    : object.data;
  return decodeStreamBytes(object.dictionary, data, `${kind} object ${object.number}`);
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

async function loadFontMaps(resources, structure, security) {
  const result = new Map();
  for (const [name, fontReference] of fontReferences(resources, structure)) {
    const font = structure.object(fontReference);
    const toUnicode = reference(font.dictionary, "ToUnicode");
    if (!toUnicode) continue;
    const cmapObject = structure.object(toUnicode);
    result.set(name, parseToUnicodeCMap(await decodeStream(cmapObject, "ToUnicode stream", security)));
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
    // Set once an encrypted PDF has been authenticated (see listTextRuns()); null for
    // an unencrypted PDF or one not yet authenticated. Read by replaceText()/save()
    // to enforce /P permissions and by decodeStream() to decrypt stream bytes.
    this.security = null;
  }

  /**
   * `password` is only consulted the first time this resolves (later calls, e.g.
   * from replaceText()/save(), reuse whatever was already authenticated). Defaults
   * to the empty string, so a caller can always try "no password" first -- most
   * PDFs that a normal reader opens without prompting use an empty user password.
   * A failed attempt leaves `this.streams` unset, so calling this again with a real
   * password retries cleanly.
   */
  async listTextRuns(password) {
    if (!this.streams) {
      // The xref table may live in an xref stream, which needs Flate decompression
      // (async) to read. Resolving it here, on first use, keeps the constructor
      // itself synchronous and free of I/O.
      await this.document.ensureXref();
      // The xref table itself is unaffected by encryption, so it resolves either
      // way. Content extraction only continues once (a) the encryption in use is
      // something this engine actually decrypts (Standard/V4/R4/AESV2 -- anything
      // else throws, non-recoverable, from authenticateEncryptedPdf itself) and
      // (b) the given password authenticates against it (recoverable: a caller can
      // retry with a different password). See src/security/decrypt.js.
      if (this.document.encryptReference) {
        const security = authenticateEncryptedPdf(this.document, password ?? "");
        if (!security.authenticated) {
          const summary = summarizeEncryption(security.diagnosis);
          const error = new Error(`Password required to open this encrypted PDF${summary ? ` (${summary})` : ""}`);
          error.encryptionDiagnosis = security.diagnosis;
          error.passwordRequired = true;
          throw error;
        }
        this.security = security;
      }
      this.streams = [];
      const seen = new Set();
      for (const { object, resources } of this.document.pageContentObjects()) {
        // One content stream can be shared by several pages, and /Contents may even
        // list it twice. Run ids are keyed by object number, so scanning it more than
        // once would hand out duplicate ids and append the object twice on save.
        if (seen.has(object.number)) continue;
        seen.add(object.number);
        const decoded = await decodeStream(object, "content stream", this.security);
        const runs = scanTextRuns(decoded);
        if (runs.length) this.streams.push({ object, decoded, runs, fontMaps: await loadFontMaps(resources, this.document, this.security) });
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
    // /P's modify permission is checked every call, not just once at open time: it
    // is a property of the PDF, not of this session, so nothing here should ever
    // let a caller stage an edit that permission forbids -- decrypting the content
    // is a reading capability, not an editing one. See README for why owner
    // authentication does not bypass this (it recovers the same file key a user
    // login would, nothing more).
    if (this.security && this.security.modifyAllowed === false) {
      throw new Error("Document modification is not permitted: this PDF's /P permissions disallow content changes (modify permission denied)");
    }
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
    // Persisting any edit to an encrypted PDF would need to re-encrypt the new
    // content stream bytes (and, per spec, could touch /O, /U, or the trailer's
    // /ID) -- deliberately out of scope for this PR (see README). This is separate
    // from the /P permission check in replaceText(): a modify-allowed encrypted PDF
    // can still stage an edit there, but cannot be saved here, since it is
    // re-encryption support that is missing, not permission.
    if (this.security) {
      throw new Error("Saving edits to an encrypted PDF is not supported yet (re-encryption is out of scope for this PR); this PDF can be searched but not saved.");
    }
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
