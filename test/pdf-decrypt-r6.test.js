import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

/*
 * Independent fixture-side implementation of the PDF Standard Security Handler
 * revision 6 algorithms (Algorithm 2.A/2.B, /UE //OE recovery, /Perms) and AESV3,
 * used only to BUILD genuinely encrypted PDF fixtures for these tests -- built
 * entirely from node:crypto (SHA-256/384/512, AES-128/256-CBC with
 * setAutoPadding(false) for the no-padding operations, AES-256-CBC with real
 * PKCS#7 padding for actual content/string data), sharing no code with
 * src/security/standard-r6.js or src/security/aes-primitives.js. If those had a
 * sequencing bug, a fixture built the same buggy way would hide it; building
 * fixtures independently is what lets these tests actually catch that -- the same
 * convention test/pdf-decrypt.test.js already uses for R4/AESV2.
 */

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

function independentAlgorithm2B(passwordBytes, salt, userKey48) {
  const initial = userKey48 ? concatBytes([passwordBytes, salt, userKey48]) : concatBytes([passwordBytes, salt]);
  let block = new Uint8Array(createHash("sha256").update(initial).digest());
  let round = 0;
  let lastE;
  while (true) {
    const unit = userKey48 ? concatBytes([passwordBytes, block, userKey48]) : concatBytes([passwordBytes, block]);
    const k1 = Buffer.concat(new Array(64).fill(Buffer.from(unit)));
    const cipher = createCipheriv("aes-128-cbc", block.subarray(0, 16), block.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = new Uint8Array(Buffer.concat([cipher.update(k1), cipher.final()]));
    lastE = e;
    round += 1;
    let sum = 0;
    for (let index = 0; index < 16; index += 1) sum += e[index];
    const algorithm = ["sha256", "sha384", "sha512"][sum % 3];
    block = new Uint8Array(createHash(algorithm).update(e).digest());
    if (round >= 64 && lastE[lastE.length - 1] <= round - 32) break;
  }
  return block.subarray(0, 32);
}

function aesCbcNoPaddingEncryptNode(key, iv, data) {
  const cipher = createCipheriv(key.length === 16 ? "aes-128-cbc" : "aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
}

/** Builds independent /U //UE (user branch) or /O //OE (owner branch, when userKey48 is given). */
function independentR6Fields(passwordBytes, userKey48, fileKey) {
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);
  const validationHash = independentAlgorithm2B(passwordBytes, validationSalt, userKey48);
  const validationEntry = concatBytes([validationHash, validationSalt, keySalt]);
  const intermediateKey = independentAlgorithm2B(passwordBytes, keySalt, userKey48);
  const encryptedFileKey = aesCbcNoPaddingEncryptNode(intermediateKey, new Uint8Array(16), fileKey);
  return { validationEntry, encryptedFileKey };
}

function independentPerms(fileKey, p, encryptMetadata) {
  const buffer = Buffer.alloc(16);
  buffer.writeInt32LE(p, 0);
  buffer.writeUInt32LE(0xffffffff, 4);
  buffer[8] = encryptMetadata ? 0x54 : 0x46;
  buffer[9] = 0x61;
  buffer[10] = 0x64;
  buffer[11] = 0x62;
  randomBytes(4).copy(buffer, 12);
  const cipher = createCipheriv("aes-256-ecb", fileKey, null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(buffer), cipher.final()]));
}

/** Real PDF AESV3 stream/string encryption: IV (16 bytes) || AES-256-CBC ciphertext, real PKCS#7 padding. */
function aesv3Encrypt(fileKey, plaintext) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", fileKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return concatBytes([iv, new Uint8Array(ciphertext)]);
}

function hexString(bytes) {
  return `<${Buffer.from(bytes).toString("hex")}>`;
}

function paethPredict(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  if (du <= dul) return up;
  return upLeft;
}
void paethPredict; // (kept for parity with pdf-decrypt.test.js's helpers; PNG-Up predictor below doesn't need Paeth)

/** PNG-predictor-12 ("Up" filter) encoding. */
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

/**
 * Builds a classic-xref, Standard/V5/R6/AESV3 encrypted PDF: Catalog(1)/Pages(2)/
 * Page(3)/Contents(4)/Encrypt(5), optionally a Font(7)+ToUnicode(8) pair. No
 * trailer /ID is written unless `includeId` is set -- revision 6 key derivation
 * does not use it (unlike revision 4), and this fixture exists partly to prove
 * this engine does not secretly require one for R6 either.
 */
function buildEncryptedPdfR6({
  userPassword = "",
  ownerPassword = "ownersecret",
  p = -1,
  encryptMetadata = true,
  streamFilter = "StdCF",
  stringFilter = "StdCF",
  content = "BT (R6 encrypted content) Tj ET",
  usePredictor = false,
  fontAndCMap = null,
  includeId = false
} = {}) {
  const fileKey = randomBytes(32);
  const userBytes = encode(userPassword);
  const ownerBytes = encode(ownerPassword);

  const userFields = independentR6Fields(userBytes, null, fileKey);
  const u = concatBytes([userFields.validationEntry]); // 48 bytes
  const ue = userFields.encryptedFileKey; // 32 bytes
  const ownerFields = independentR6Fields(ownerBytes, u, fileKey);
  const o = concatBytes([ownerFields.validationEntry]); // 48 bytes
  const oe = ownerFields.encryptedFileKey; // 32 bytes
  const perms = independentPerms(fileKey, p, encryptMetadata);

  function encryptedStreamBytes(plaintext) {
    let filtered = usePredictor ? pngUpEncode(plaintext, 8) : plaintext;
    filtered = deflateSync(filtered);
    if (streamFilter === "Identity") return { data: filtered, filterClause: "/Filter /FlateDecode" };
    return { data: aesv3Encrypt(fileKey, filtered), filterClause: "/Filter /FlateDecode" };
  }

  const contentBytes = encode(content);
  const encryptedContent = encryptedStreamBytes(contentBytes);
  const predictorClause = usePredictor ? " /DecodeParms << /Predictor 12 /Columns 8 >>" : "";

  const header = encode("%PDF-2.0\n");
  const chunks = [header];
  const offsets = new Map();
  let pos = header.length;
  function place(number, dictionary, streamBytes) {
    offsets.set(number, pos);
    let piece;
    if (streamBytes) {
      piece = encode(`${number} 0 obj\n<< ${dictionary} /Length ${streamBytes.length} >>\nstream\n`);
      chunks.push(piece);
      pos += piece.length;
      chunks.push(streamBytes);
      pos += streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece);
      pos += piece.length;
    } else {
      piece = encode(`${number} 0 obj\n${dictionary}\nendobj\n`);
      chunks.push(piece);
      pos += piece.length;
    }
  }

  const fontResourcesClause = fontAndCMap ? " /Resources << /Font << /FJP 7 0 R >> >>" : "";
  place(1, "<< /Type /Catalog /Pages 2 0 R >>");
  place(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  place(3, `<< /Type /Page /Parent 2 0 R /Contents 4 0 R${fontResourcesClause} >>`);
  place(4, `${encryptedContent.filterClause}${predictorClause}`, encryptedContent.data);

  const cfDictionary = streamFilter === "Identity" && stringFilter === "Identity"
    ? ""
    : " /CF << /StdCF << /CFM /AESV3 /Length 32 >> >>";
  const encryptDictionary = "<< /Filter /Standard /V 5 /R 6 /Length 256" +
    ` /O ${hexString(o)} /U ${hexString(u)} /OE ${hexString(oe)} /UE ${hexString(ue)} /Perms ${hexString(perms)}` +
    ` /P ${p} /EncryptMetadata ${encryptMetadata}` +
    ` /StmF /${streamFilter} /StrF /${stringFilter}${cfDictionary} >>`;
  place(5, encryptDictionary);

  if (fontAndCMap) {
    const cmapBytes = encode(fontAndCMap.cmap);
    const encryptedCMap = encryptedStreamBytes(cmapBytes);
    place(7, "<< /Type /Font /Subtype /Type0 /ToUnicode 8 0 R >>");
    place(8, encryptedCMap.filterClause, encryptedCMap.data);
  }

  const xrefOffset = pos;
  const maxNumber = Math.max(...offsets.keys());
  const table = [...offsets.keys()].sort((a, b) => a - b)
    .map((number) => `${number} 1\n${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`)
    .join("");
  const idClause = includeId ? ` /ID [${hexString(randomBytes(16))} ${hexString(randomBytes(16))}]` : "";
  const trailerPiece = encode(
    `xref\n0 1\n0000000000 65535 f \n${table}trailer\n<< /Size ${maxNumber + 1} /Root 1 0 R /Encrypt 5 0 R${idClause} >>` +
    `\nstartxref\n${xrefOffset}\n%%EOF\n`
  );
  chunks.push(trailerPiece);

  return concatBytes(chunks);
}

function bigEndian(value, width) {
  const bytes = [];
  for (let index = width - 1; index >= 0; index -= 1) bytes.push((value >>> (index * 8)) & 0xff);
  return bytes;
}

function concatChunks(chunks) {
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

/**
 * Builds a Standard/V5/R6/AESV3 encrypted PDF whose Catalog/Pages/Page are
 * compressed into an Object Stream (xref type 2 entries, via a cross-reference
 * stream -- classic xref cannot represent type 2), while Contents stays an
 * ordinary encrypted stream (never compressed, per spec). Mirrors
 * test/object-stream-resolve.test.js's buildObjStmPdf(), but AESV3-encrypted: the
 * Object Stream's own raw bytes are AES-256-CBC encrypted with the *file
 * encryption key directly* (never a per-object key derived from the Object
 * Stream's own object number -- see decryptStreamBytes()'s AESV3 branch in
 * src/security/decrypt.js), exactly like any other AESV3 stream.
 */
function buildObjStmPdfR6({ content = "BT (ObjStm R6 content) Tj ET", p = -1 } = {}) {
  const fileKey = randomBytes(32);
  const userFields = independentR6Fields(encode(""), null, fileKey);
  const u = userFields.validationEntry;
  const ue = userFields.encryptedFileKey;
  const ownerFields = independentR6Fields(encode("ownersecret"), u, fileKey);
  const o = ownerFields.validationEntry;
  const oe = ownerFields.encryptedFileKey;
  const perms = independentPerms(fileKey, p, true);

  const header = encode("%PDF-2.0\n");
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

  const encryptedContent = aesv3Encrypt(fileKey, deflateSync(encode(content)));
  place(4, "/Filter /FlateDecode", encryptedContent);

  const compressed = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" }
  ];
  let cursor = 0;
  const bodyOffsets = compressed.map((object) => {
    const offset = cursor;
    cursor += encode(object.dictionary).length;
    return offset;
  });
  const objStmHeader = `${compressed.map((object, index) => `${object.number} ${bodyOffsets[index]}`).join("\n")}\n`;
  const objStmBodyText = compressed.map((object) => object.dictionary).join("");
  const decoded = encode(objStmHeader + objStmBodyText);
  const firstOffset = encode(objStmHeader).length;
  const encryptedObjStm = aesv3Encrypt(fileKey, deflateSync(decoded));
  const objStmNumber = 5;
  place(objStmNumber, `/Type /ObjStm /N ${compressed.length} /First ${firstOffset} /Filter /FlateDecode`, encryptedObjStm);

  const encryptObjNumber = 6;
  const cfDictionary = " /CF << /StdCF << /CFM /AESV3 /Length 32 >> >>";
  const encryptDictionary = "<< /Filter /Standard /V 5 /R 6 /Length 256" +
    ` /O ${hexString(o)} /U ${hexString(u)} /OE ${hexString(oe)} /UE ${hexString(ue)} /Perms ${hexString(perms)}` +
    ` /P ${p} /EncryptMetadata true /StmF /StdCF /StrF /StdCF${cfDictionary} >>`;
  place(encryptObjNumber, encryptDictionary);

  const type1Numbers = [4, objStmNumber, encryptObjNumber];
  const compressedByNumber = new Map(compressed.map((object, index) => [object.number, index]));
  const usedNumbers = [0, ...type1Numbers, ...compressed.map((object) => object.number)].sort((a, b) => a - b);
  const xrefStmNumber = Math.max(...type1Numbers, ...compressed.map((object) => object.number)) + 1;
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
  const dict = `<< /Type /XRef /Size ${xrefStmNumber + 1} /W [${w.join(" ")}] /Index [${indexPairs.flat().join(" ")}]` +
    ` /Root 1 0 R /Encrypt ${encryptObjNumber} 0 R /Filter /FlateDecode /Length ${data.length} >>`;
  const xrefPiece = concatChunks([
    encode(`${xrefStmNumber} 0 obj\n${dict}\nstream\n`),
    data,
    encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
  ]);
  return concatChunks([...chunks, xrefPiece]);
}

/* ------------------------------------------------------------------------------- 10: ObjStm */

test("R6/AESV3: decrypts an Object Stream (keyed by the file encryption key directly, not a per-object key) and resolves a compressed page tree", async () => {
  const pdf = buildObjStmPdfR6({ content: "BT (ObjStm R6 content) Tj ET" });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["ObjStm R6 content"]);
  assert.equal(editor.security.encryptionMethod, "AESV3");
  assert.equal(editor.document.objectStreamCache.size, 1);
});

const JAPANESE_CMAP =
  "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n2 beginbfchar\n<0001> <65E5>\n<0002> <672C>\nendbfchar\nendcmap\nend end";

/* ------------------------------------------------------ 1: empty user password, basic decrypt */

test("R6/AESV3: authenticates with an empty user password and decrypts content", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "" });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["R6 encrypted content"]);
  assert.equal(editor.security.authType, "user");
  assert.equal(editor.security.revision, 6);
  assert.equal(editor.security.encryptionMethod, "AESV3");
});

test("R6/AESV3: does not require a trailer /ID (unlike R4)", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "", includeId: false });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.equal(runs.length, 1);
});

/* -------------------------------------------------------------------------- 2: wrong password */

test("R6/AESV3: rejects a wrong password with passwordRequired, not a crash", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "correct-password" });
  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns("wrong-password"), (error) => {
    assert.equal(error.passwordRequired, true);
    return true;
  });
});

test("R6/AESV3: succeeds on retry with the correct non-empty user password", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "correct-password" });
  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns("wrong"));
  const runs = await editor.listTextRuns("correct-password");
  assert.deepEqual(runs.map((run) => run.text), ["R6 encrypted content"]);
});

/* -------------------------------------------------------------------------- 3: owner password */

test("R6/AESV3: authenticates via owner password when the user password is unknown/wrong", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "user-secret", ownerPassword: "owner-secret" });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns("owner-secret");
  assert.deepEqual(runs.map((run) => run.text), ["R6 encrypted content"]);
  assert.equal(editor.security.authType, "owner");
});

test("R6/AESV3: owner authentication does not bypass /P modify permission", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "user-secret", ownerPassword: "owner-secret", p: -3904 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns("owner-secret");
  assert.equal(editor.security.authType, "owner");
  assert.equal(editor.security.modifyAllowed, false);
  await assert.rejects(editor.replaceText(runs[0].id, "nope"), /modification is not permitted/);
});

/* --------------------------------------------------------------------- 4/5: FlateDecode / Predictor */

test("R6/AESV3: decrypts and inflates a plain FlateDecode content stream", async () => {
  const pdf = buildEncryptedPdfR6({ content: "BT (Flate content) Tj ET" });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Flate content"]);
});

test("R6/AESV3: decrypts, inflates, and reverses a PNG Predictor content stream", async () => {
  const pdf = buildEncryptedPdfR6({ content: "BT (Predictor content) Tj ET", usePredictor: true });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Predictor content"]);
});

/* ---------------------------------------------------------------------------------- 6: Identity */

test("R6/AESV3: /StmF /Identity leaves content bytes unencrypted (not AES-decrypted)", async () => {
  const pdf = buildEncryptedPdfR6({ content: "BT (Identity content) Tj ET", streamFilter: "Identity" });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Identity content"]);
});

/* --------------------------------------------------------------------------- 7: ToUnicode */

test("R6/AESV3: decrypts a Font+ToUnicode pair and decodes Japanese text", async () => {
  const pdf = buildEncryptedPdfR6({
    content: "BT /FJP 12 Tf <00010002> Tj ET",
    fontAndCMap: { cmap: JAPANESE_CMAP }
  });
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "日本");
});

/* -------------------------------------------------------------------------------- 8: /P denial */

test("R6/AESV3: /P modify=false blocks replaceText() but not extraction/search", async () => {
  const pdf = buildEncryptedPdfR6({ p: -3904 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.equal(runs.length, 1);
  assert.equal(editor.security.modifyAllowed, false);
  await assert.rejects(editor.replaceText(runs[0].id, "nope"), /modification is not permitted/);
});

/* ---------------------------------------------------------------------------------- 9: save() */

test("R6/AESV3: save() refuses to persist a staged edit to an encrypted PDF", async () => {
  const pdf = buildEncryptedPdfR6({ p: -1 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  await editor.replaceText(runs[0].id, runs[0].bytes);
  await assert.rejects(editor.save(), /re-encryption is out of scope/);
});

test("R6/AESV3: save() with no staged edits returns the original bytes unchanged", async () => {
  const pdf = buildEncryptedPdfR6({ p: -1 });
  const editor = new PdfTextEditor(pdf);
  await editor.listTextRuns();
  const output = await editor.save();
  assert.deepEqual(output, pdf);
});

/* ------------------------------------------------------------------------------- /Perms failure */

test("R6/AESV3: a /Perms that does not match /P is rejected even after a correct password", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "", p: -1 });
  const text = Buffer.from(pdf).toString("latin1");
  // Corrupt /P in the dictionary text only -- /Perms itself (unaffected by this
  // splice) was built to encode -1, so it will now disagree with the new /P.
  const corruptedText = text.replace("/P -1 /EncryptMetadata", "/P -2 /EncryptMetadata");
  assert.notEqual(corruptedText, text);
  const corrupted = Buffer.from(corruptedText, "latin1");
  const editor = new PdfTextEditor(corrupted);
  await assert.rejects(editor.listTextRuns(""), /Perms validation failed/);
});

/* ------------------------------------------------------------------------------------ scope */

test("R6/AESV3: a /V 5 /R 5 PDF (pre-ISO AES-256, out of scope) is refused, not guessed at", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "" });
  const text = Buffer.from(pdf).toString("latin1").replace("/V 5 /R 6", "/V 5 /R 5");
  const editor = new PdfTextEditor(Buffer.from(text, "latin1"));
  await assert.rejects(editor.listTextRuns(""), /Unsupported encrypted PDF version\/revision/);
});

/* --------------------------------------------------------------------- Crypt Filter /Length */

test("R6/AESV3: rejects a Crypt Filter whose /Length is inconsistent with /CFM /AESV3 (16 instead of 32 bytes)", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "" });
  const text = Buffer.from(pdf).toString("latin1").replace("/CFM /AESV3 /Length 32", "/CFM /AESV3 /Length 16");
  assert.notEqual(text, Buffer.from(pdf).toString("latin1"));
  const editor = new PdfTextEditor(Buffer.from(text, "latin1"));
  await assert.rejects(editor.listTextRuns(""), /Crypt filter \/Length is inconsistent/);
});

test("R6/AESV3: accepts a Crypt Filter with no /Length at all (AESV3's key length is fixed by the CFM)", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "" });
  // Same-length replacement only (padded with spaces, harmless inside a PDF
  // dictionary) -- every byte offset after this point in the fixture (the xref
  // stream's own recorded object offsets, /startxref) was computed from the
  // original text, so a shorter replacement would silently corrupt them instead of
  // just removing /Length.
  const original = "/CFM /AESV3 /Length 32";
  const withoutLength = `/CFM /AESV3${" ".repeat(original.length - "/CFM /AESV3".length)}`;
  assert.equal(withoutLength.length, original.length);
  const text = Buffer.from(pdf).toString("latin1").replace(original, withoutLength);
  const editor = new PdfTextEditor(Buffer.from(text, "latin1"));
  const runs = await editor.listTextRuns("");
  assert.equal(runs.length, 1);
});

/* --------------------------------------------------------------------------- error propagation */

test("R6/AESV3: a password this module's SASLprep profile rejects propagates as an explicit error, not a generic wrong-password prompt", async () => {
  const pdf = buildEncryptedPdfR6({ userPassword: "correct-password" });
  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns("א"), (error) => {
    assert.match(error.message, /SASLprep/);
    // Unlike an ordinary wrong password, this must NOT look like a recoverable
    // "please try another password" case -- retrying the *same* rejected
    // candidate would just fail identically every time.
    assert.notEqual(error.passwordRequired, true);
    return true;
  });
});
