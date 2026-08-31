import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

/* ------------------------------------------------------------- shared PDF fixture helpers */
/* Same patterns as test/xref-stream.test.js (placeObjects/appendXrefStream-style byte
 * assembly), duplicated per this repo's convention of self-contained test files. */

function bigEndian(value, width) {
  const bytes = [];
  for (let index = width - 1; index >= 0; index -= 1) bytes.push((value >>> (index * 8)) & 0xff);
  return bytes;
}

function concatChunks(chunks) {
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

/* ------------------------------------------------------- independent R4/AESV2 crypto helpers */
/* Same independent (node:crypto MD5/AES-CBC + from-spec RC4) fixture-side implementation
 * as test/pdf-decrypt.test.js, duplicated so this file can build encrypted ObjStm
 * fixtures without depending on src/security/*.js for constructing them. */

const PASSWORD_PADDING = Uint8Array.of(
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
);

function md5(bytes) {
  return new Uint8Array(createHash("md5").update(bytes).digest());
}

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) s[index] = index;
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + s[index] + key[index % key.length]) & 0xff;
    [s[index], s[j]] = [s[j], s[index]];
  }
  const output = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    output[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return output;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function pad(passwordBytes) {
  const result = new Uint8Array(32);
  const take = Math.min(passwordBytes.length, 32);
  result.set(passwordBytes.subarray(0, take));
  result.set(PASSWORD_PADDING.subarray(0, 32 - take), take);
  return result;
}

function computeO(ownerPasswordBytes, userPasswordBytes, keyLengthBytes) {
  let hash = md5(pad(ownerPasswordBytes));
  for (let iteration = 0; iteration < 50; iteration += 1) hash = md5(hash.subarray(0, keyLengthBytes));
  const rc4Key = hash.subarray(0, keyLengthBytes);
  let data = pad(userPasswordBytes);
  for (let iteration = 0; iteration < 20; iteration += 1) data = rc4(rc4Key.map((byte) => byte ^ iteration), data);
  return data;
}

function computeFileKey(paddedPassword, o, p, idBytes, keyLengthBytes, encryptMetadata) {
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p, true);
  const parts = [paddedPassword, o.subarray(0, 32), pBytes, idBytes];
  if (!encryptMetadata) parts.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  let hash = md5(concatBytes(parts));
  for (let iteration = 0; iteration < 50; iteration += 1) hash = md5(hash.subarray(0, keyLengthBytes));
  return hash.subarray(0, keyLengthBytes);
}

function computeU(fileKey, idBytes) {
  let encrypted = rc4(fileKey, md5(concatBytes([PASSWORD_PADDING, idBytes])));
  for (let iteration = 1; iteration <= 19; iteration += 1) encrypted = rc4(fileKey.map((byte) => byte ^ iteration), encrypted);
  return encrypted;
}

function deriveObjectKey(fileKey, objectNumber, generation) {
  const extra = new Uint8Array(9);
  extra[0] = objectNumber & 0xff;
  extra[1] = (objectNumber >> 8) & 0xff;
  extra[2] = (objectNumber >> 16) & 0xff;
  extra[3] = generation & 0xff;
  extra[4] = (generation >> 8) & 0xff;
  extra.set(encode("sAlT"), 5);
  return md5(concatBytes([fileKey, extra])).subarray(0, 16);
}

function aesEncrypt(key, plaintext) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return concatBytes([iv, new Uint8Array(ciphertext)]);
}

/* -------------------------------------------------------------------- PNG Predictor helper */

/** PNG-predictor-12 ("Up" filter) encoding, same as test/pdf-decrypt.test.js. */
function pngUpEncode(raw, columns) {
  const padded = new Uint8Array(Math.ceil(raw.length / columns) * columns);
  padded.set(raw);
  const rows = [];
  for (let offset = 0; offset < padded.length; offset += columns) rows.push(padded.subarray(offset, offset + columns));
  const out = [];
  let previous = new Uint8Array(columns);
  for (const row of rows) {
    out.push(2);
    for (let index = 0; index < columns; index += 1) out.push((row[index] - previous[index]) & 0xff);
    previous = row;
  }
  return Uint8Array.from(out);
}

/* -------------------------------------------------------------------------- ObjStm fixture */

/** Builds a decoded ObjStm body (header + object bodies) from `{ number, dictionary }` pairs. */
function buildObjStmBody(compressedObjects) {
  let cursor = 0;
  const offsets = compressedObjects.map((object) => {
    const offset = cursor;
    cursor += encode(object.dictionary).length;
    return offset;
  });
  const header = compressedObjects.map((object, index) => `${object.number} ${offsets[index]}`).join("\n") + "\n";
  const bodies = compressedObjects.map((object) => object.dictionary).join("");
  return { decoded: encode(header + bodies), firstOffset: encode(header).length };
}

/**
 * Builds a full PDF, via a cross-reference stream, with some objects packed into one
 * Object Stream (`compressedObjects`, referenced by xref type 2 entries) and the rest
 * as ordinary indirect objects (`normalObjects`, xref type 1 -- including the Object
 * Stream itself, which is always type 1, and Contents streams, which per spec are
 * never compressed). `encrypt`, when given, makes this a Standard/V4/R4/AESV2
 * encrypted PDF whose Object Stream is itself AES-encrypted as a whole, keyed off its
 * own object number (never the individual compressed objects' numbers -- PDF spec
 * 7.6 encrypts the container, not entries inside it).
 */
function buildObjStmPdf({
  compressedObjects,
  normalObjects,
  objStmNumber,
  rootNumber = 1,
  usePredictor = false,
  encrypt = null
}) {
  const header = encode("%PDF-1.6\n");
  const chunks = [header];
  const offsets = new Map();
  let pos = header.length;

  function place(number, dictionary, streamBytes) {
    offsets.set(number, pos);
    let piece;
    if (streamBytes) {
      piece = encode(`${number} 0 obj\n<< ${dictionary} /Length ${streamBytes.length} >>\nstream\n`);
      chunks.push(piece); pos += piece.length;
      chunks.push(streamBytes); pos += streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece); pos += piece.length;
    } else {
      piece = encode(`${number} 0 obj\n${dictionary}\nendobj\n`);
      chunks.push(piece); pos += piece.length;
    }
  }

  // Compute the encryption key material (if any) before placing normal objects: a
  // real R4/AESV2 PDF encrypts every stream, not just the Object Stream -- each
  // normal stream object below is AES-encrypted with its own object key, exactly
  // like decodeStream()/decryptStreamBytes() in the production code expect.
  const keyLengthBytes = 16;
  let idBytes = null;
  let fileKey = null;
  let o = null;
  let u = null;
  let p = -1;
  let encryptMetadata = true;

  if (encrypt) {
    idBytes = randomBytes(16);
    p = encrypt.p ?? -1;
    encryptMetadata = encrypt.encryptMetadata ?? true;
    const userBytes = encrypt.userPasswordBytes ?? encode(encrypt.userPassword ?? "");
    const ownerBytes = encode(encrypt.ownerPassword ?? "ownersecret");
    o = computeO(ownerBytes, userBytes, keyLengthBytes);
    fileKey = computeFileKey(pad(userBytes), o, p, idBytes, keyLengthBytes, encryptMetadata);
    u = computeU(fileKey, idBytes);
  }

  for (const object of normalObjects) {
    // No /Filter needed here: decodeStream() in pdf-document.js runs decryption
    // first and inflate/predictor second, and with no /Filter the latter is a
    // no-op -- so the AES-encrypted bytes alone (no FlateDecode) round-trip fine.
    const streamBytes = object.streamBytes && encrypt
      ? aesEncrypt(deriveObjectKey(fileKey, object.number, 0), object.streamBytes)
      : object.streamBytes;
    place(object.number, object.dictionary, streamBytes);
  }

  const { decoded, firstOffset } = buildObjStmBody(compressedObjects);
  let filtered = usePredictor ? pngUpEncode(decoded, 8) : decoded;
  filtered = deflateSync(filtered);

  // The Object Stream's own object key -- derived from objStmNumber, never from any
  // object number packed inside it (see this function's own docstring).
  const objStmData = encrypt ? aesEncrypt(deriveObjectKey(fileKey, objStmNumber, 0), filtered) : filtered;

  const predictorClause = usePredictor ? ` /DecodeParms << /Predictor 12 /Columns 8 >>` : "";
  place(objStmNumber, `/Type /ObjStm /N ${compressedObjects.length} /First ${firstOffset} /Filter /FlateDecode${predictorClause}`, objStmData);

  let encryptObjNumber = null;
  if (encrypt) {
    encryptObjNumber = Math.max(objStmNumber, ...normalObjects.map((object) => object.number)) + 1;
    const encryptDictionary = "<< /Filter /Standard /V 4 /R 4 /Length 128" +
      ` /O <${Buffer.from(o).toString("hex")}> /U <${Buffer.from(u).toString("hex")}>` +
      ` /P ${p} /EncryptMetadata ${encryptMetadata} /StmF /StdCF /StrF /StdCF` +
      " /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>";
    place(encryptObjNumber, encryptDictionary);
  }

  // A classic (non-stream) xref table cannot represent a type 2 entry, so the xref
  // itself must be a cross-reference stream. Every used object number gets its own
  // single-entry /Index subsection (proven to work for non-contiguous numbers in
  // test/xref-stream.test.js), avoiding the need to fill in gaps.
  const type1Numbers = [...normalObjects.map((object) => object.number), objStmNumber, ...(encrypt ? [encryptObjNumber] : [])];
  const compressedByNumber = new Map(compressedObjects.map((object, index) => [object.number, index]));
  const usedNumbers = [0, ...type1Numbers, ...compressedObjects.map((object) => object.number)].sort((a, b) => a - b);

  const xrefStmNumber = Math.max(...type1Numbers, ...compressedObjects.map((object) => object.number)) + 1;
  const xrefOffset = pos;
  const w = [1, 4, 2];
  const rows = [xrefStmNumber, ...usedNumbers].sort((a, b) => a - b).map((number) => {
    if (number === 0) return Uint8Array.of(0, ...bigEndian(0, w[1]), ...bigEndian(65535, w[2]));
    if (number === xrefStmNumber) return Uint8Array.of(1, ...bigEndian(xrefOffset, w[1]), ...bigEndian(0, w[2]));
    if (type1Numbers.includes(number)) return Uint8Array.of(1, ...bigEndian(offsets.get(number), w[1]), ...bigEndian(0, w[2]));
    return Uint8Array.of(2, ...bigEndian(objStmNumber, w[1]), ...bigEndian(compressedByNumber.get(number), w[2]));
  });
  const indexPairs = [xrefStmNumber, ...usedNumbers].sort((a, b) => a - b).map((number) => [number, 1]);
  const data = deflateSync(concatChunks(rows));
  const idClause = encrypt
    ? ` /Encrypt ${encryptObjNumber} 0 R /ID [<${Buffer.from(idBytes).toString("hex")}> <${Buffer.from(idBytes).toString("hex")}>]`
    : "";
  const dict = `<< /Type /XRef /Size ${xrefStmNumber + 1} /W [${w.join(" ")}] /Index [${indexPairs.flat().join(" ")}]` +
    ` /Root ${rootNumber} 0 R${idClause} /Filter /FlateDecode /Length ${data.length} >>`;
  const xrefPiece = concatChunks([
    encode(`${xrefStmNumber} 0 obj\n${dict}\nstream\n`),
    data,
    encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
  ]);

  return concatChunks([...chunks, xrefPiece]);
}

/** Catalog(1)/Pages(2)/Page(3)/Contents(4) where `compressedNumbers` names which of
 * 1-3 are packed into the Object Stream instead of being ordinary indirect objects. */
function basicFixture({ compressedNumbers = [], content = "BT (ObjStm content) Tj ET", objStmNumber = 5, encrypt = null, usePredictor = false } = {}) {
  const all = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" }
  ];
  const compressedObjects = all.filter((object) => compressedNumbers.includes(object.number));
  const normalObjects = [
    ...all.filter((object) => !compressedNumbers.includes(object.number)),
    { number: 4, dictionary: "", streamBytes: encode(content) }
  ];
  return buildObjStmPdf({ compressedObjects, normalObjects, objStmNumber, encrypt, usePredictor });
}

/* ----------------------------------------------------------------- 1: basic ObjStm (unencrypted) */

test("resolves a compressed Catalog and extracts text normally", async () => {
  const pdf = basicFixture({ compressedNumbers: [1] });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["ObjStm content"]);
});

test("resolves a compressed Page dictionary and extracts text normally", async () => {
  const pdf = basicFixture({ compressedNumbers: [3] });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["ObjStm content"]);
});

test("resolves Catalog, Pages, and Page all compressed into the same object stream", async () => {
  const pdf = basicFixture({ compressedNumbers: [1, 2, 3] });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["ObjStm content"]);
});

/* ---------------------------------------------------------------- 2: type2 index resolution */

test("resolves the correct object via streamNumber/indexInStream from a multi-object object stream", async () => {
  const pdf = basicFixture({ compressedNumbers: [1, 2, 3] });
  const editor = new PdfTextEditor(pdf);
  await editor.listTextRuns();
  // object 3 (Page) was placed third in the compressed list -> index 2.
  const page = await editor.document.resolveObject(3);
  assert.match(page.dictionary, /\/Type\s*\/Page\b/);
  const catalog = await editor.document.resolveObject(1);
  assert.match(catalog.dictionary, /\/Type\s*\/Catalog\b/);
});

/* --------------------------------------------------------------------- 3: multiple objects */

test("resolves object A, B, and C independently from the same object stream", async () => {
  const pdf = buildObjStmPdf({
    compressedObjects: [
      { number: 100, dictionary: "<< /Marker /A >>" },
      { number: 101, dictionary: "<< /Marker /B >>" },
      { number: 102, dictionary: "<< /Marker /C >>" }
    ],
    normalObjects: [],
    objStmNumber: 5,
    rootNumber: 1
  });
  // No Catalog exists in this fixture; resolve the three objects directly instead of
  // going through listTextRuns()'s page-tree walk.
  const editor = new PdfTextEditor(pdf);
  await editor.document.ensureXref();
  const a = await editor.document.resolveObject(100);
  const b = await editor.document.resolveObject(101);
  const c = await editor.document.resolveObject(102);
  assert.match(a.dictionary, /\/Marker\s*\/A\b/);
  assert.match(b.dictionary, /\/Marker\s*\/B\b/);
  assert.match(c.dictionary, /\/Marker\s*\/C\b/);
});

/* ------------------------------------------------------------------------------- cache */

test("decodes the same object stream only once, even when several of its objects are resolved", async () => {
  const pdf = buildObjStmPdf({
    compressedObjects: [
      { number: 100, dictionary: "<< /Marker /A >>" },
      { number: 101, dictionary: "<< /Marker /B >>" }
    ],
    normalObjects: [],
    objStmNumber: 5,
    rootNumber: 1
  });
  const editor = new PdfTextEditor(pdf);
  await editor.document.ensureXref();
  await editor.document.resolveObject(100);
  assert.equal(editor.document.objectStreamCache.size, 1);
  const entriesBefore = editor.document.objectStreamCache.get(5);
  await editor.document.resolveObject(101);
  assert.equal(editor.document.objectStreamCache.size, 1);
  // Same array instance, not merely equal content -- proves it was not re-decoded.
  assert.equal(editor.document.objectStreamCache.get(5), entriesBefore);
});

/* --------------------------------------------------------------------- index/number errors */

test("rejects an xref type 2 entry whose indexInStream is out of range", async () => {
  const pdf = buildObjStmPdf({
    compressedObjects: [{ number: 100, dictionary: "<< /Marker /A >>" }],
    normalObjects: [],
    objStmNumber: 5,
    rootNumber: 1
  });
  // Rather than hand-decoding the deflated xref stream row bytes to corrupt
  // indexInStream on disk, mutate the already-parsed xref entry directly -- this
  // exercises exactly the same resolveObject() validation from the public API.
  const editor = new PdfTextEditor(pdf);
  await editor.document.ensureXref();
  const entry = editor.document.entries.get(100);
  entry.indexInStream = 9;
  await assert.rejects(editor.document.resolveObject(100), /Object stream index is out of range/);
});

test("rejects an xref type 2 entry whose target object number does not match the object stream's header", async () => {
  const pdf = buildObjStmPdf({
    compressedObjects: [
      { number: 100, dictionary: "<< /Marker /A >>" },
      { number: 101, dictionary: "<< /Marker /B >>" }
    ],
    normalObjects: [],
    objStmNumber: 5,
    rootNumber: 1
  });
  const editor = new PdfTextEditor(pdf);
  await editor.document.ensureXref();
  // xref says object 100 is at index 0, but force it to look at index 1 (object 101).
  const entry = editor.document.entries.get(100);
  entry.indexInStream = 1;
  await assert.rejects(editor.document.resolveObject(100), /Object stream object number mismatch/);
});

test("rejects an object stream whose declared /N does not match how many objects it actually holds", async () => {
  // Build directly (bypassing buildObjStmPdf) so /N can be set inconsistently with
  // the real header pair count.
  const pdf = buildObjStmPdf({
    compressedObjects: [{ number: 100, dictionary: "<< /Marker /A >>" }],
    normalObjects: [],
    objStmNumber: 5,
    rootNumber: 1
  });
  const text = Buffer.from(pdf).toString("latin1");
  const corrupted = Buffer.from(text.replace("/N 1 /First", "/N 3 /First"), "latin1");
  const editor = new PdfTextEditor(corrupted);
  await editor.document.ensureXref();
  await assert.rejects(editor.document.resolveObject(100), /Object stream header is incomplete/);
});

/* --------------------------------------------------------------------- FlateDecode / Predictor */

test("decodes an object stream that is FlateDecode-compressed", async () => {
  const pdf = basicFixture({ compressedNumbers: [3], content: "BT (Flate ObjStm) Tj ET" });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Flate ObjStm"]);
});

test("decodes an object stream that is FlateDecode-compressed with a PNG Predictor", async () => {
  const pdf = basicFixture({ compressedNumbers: [1, 3], content: "BT (Predictor ObjStm) Tj ET", usePredictor: true });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Predictor ObjStm"]);
});

/* -------------------------------------------------------------------------------- AESV2 */

test("decrypts an AESV2-encrypted object stream (keyed off the object stream's own object number) and resolves its objects", async () => {
  const pdf = basicFixture({
    compressedNumbers: [1, 3],
    content: "BT (Encrypted ObjStm content) Tj ET",
    encrypt: { userPassword: "", p: -1 }
  });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["Encrypted ObjStm content"]);
  assert.equal(editor.security.authenticated, true);
});

test("decrypts an AESV2-encrypted, PNG-predictor-encoded object stream", async () => {
  const pdf = basicFixture({
    compressedNumbers: [1, 2, 3],
    content: "BT (AESV2 plus Predictor ObjStm) Tj ET",
    encrypt: { userPassword: "", p: -1 },
    usePredictor: true
  });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["AESV2 plus Predictor ObjStm"]);
});

test("respects /P modify denial for an encrypted PDF whose page tree is compressed", async () => {
  const pdf = basicFixture({
    compressedNumbers: [1, 3],
    content: "BT (Permission check content) Tj ET",
    encrypt: { userPassword: "", p: -44 }
  });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.equal(runs.length, 1);
  assert.equal(editor.security.modifyAllowed, false);
  await assert.rejects(editor.replaceText(runs[0].id, "nope"), /modification is not permitted/);
});

/* ----------------------------------------------------------------------- Font / ToUnicode */

const JAPANESE_CMAP =
  "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n2 beginbfchar\n<0001> <65E5>\n<0002> <672C>\nendbfchar\nendcmap\nend end";

test("resolves a compressed Font dictionary and decodes Japanese text via its /ToUnicode CMap", async () => {
  // Font (object 6) is compressed into the object stream alongside the Catalog;
  // its /ToUnicode target (object 7, a stream) stays a normal indirect object --
  // per spec, a compressed object is never a stream.
  const pdf = buildObjStmPdf({
    compressedObjects: [
      { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
      { number: 6, dictionary: "<< /Type /Font /Subtype /Type0 /ToUnicode 7 0 R >>" }
    ],
    normalObjects: [
      { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /FJP 6 0 R >> >> /Contents 4 0 R >>" },
      { number: 4, dictionary: "", streamBytes: encode("BT /FJP 12 Tf <00010002> Tj ET") },
      { number: 7, dictionary: "", streamBytes: encode(JAPANESE_CMAP) }
    ],
    objStmNumber: 5,
    rootNumber: 1
  });
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "日本");
  assert.equal(run.fontName, "FJP");
});

/* ----------------------------------------------------------------------------- Page tree */

test("walks Catalog -> Pages -> compressed Page -> Contents", async () => {
  const pdf = buildObjStmPdf({
    compressedObjects: [{ number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" }],
    normalObjects: [
      { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
      { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { number: 4, dictionary: "", streamBytes: encode("BT (Page tree content) Tj ET") }
    ],
    objStmNumber: 5,
    rootNumber: 1
  });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Page tree content"]);
});

/* ---------------------------------------------------------------------------- regressions */

test("unencrypted regression: listTextRuns -> replaceText -> save -> reopen still works with a compressed page tree", async () => {
  const pdf = basicFixture({ compressedNumbers: [1, 3], content: "BT (Before save) Tj ET" });
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  await editor.replaceText(run.id, "After save");
  const output = await editor.save();
  const reopened = new PdfTextEditor(output);
  assert.deepEqual((await reopened.listTextRuns()).map((r) => r.text), ["After save"]);
});

test("does not attempt object-stream resolution for plain, fully type-1 PDFs (no behaviour change)", async () => {
  const pdf = basicFixture({ compressedNumbers: [] });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["ObjStm content"]);
  assert.equal(editor.document.objectStreamCache.size, 0);
});
