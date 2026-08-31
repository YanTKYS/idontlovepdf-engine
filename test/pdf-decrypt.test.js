import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { assessPdfBytes } from "../src/assessment.js";
import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

/*
 * Independent fixture-side implementation of the PDF Standard Security Handler
 * (R4) algorithms and AES-CBC, used only to BUILD genuinely encrypted PDF fixtures
 * for these tests. Deliberately uses different primitives than src/security/*.js:
 * node:crypto's own MD5 and AES-CBC (not src/security/md5.js or
 * src/security/aes.js's Web Crypto path) plus a small from-spec RC4 (separately
 * verified against public test vectors in test/rc4.test.js). If src/security/*.js
 * had a bug in this algorithm's sequencing, a fixture built the same buggy way
 * would hide it; building fixtures independently is what lets these tests actually
 * catch that.
 */

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
  for (let iteration = 0; iteration < 20; iteration += 1) {
    data = rc4(rc4Key.map((byte) => byte ^ iteration), data);
  }
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
  for (let iteration = 1; iteration <= 19; iteration += 1) {
    encrypted = rc4(fileKey.map((byte) => byte ^ iteration), encrypted);
  }
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

function paethPredict(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  if (du <= dul) return up;
  return upLeft;
}

/** PNG-predictor-15 ("optimal", but every row tagged Up here for simplicity) encoding. */
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
  return { encoded: Uint8Array.from(out), columns };
}

/**
 * Builds a classic-xref, Standard/V4/R4/AESV2 encrypted PDF: Catalog(1)/Pages(2)/
 * Page(3)/Contents(4)/Encrypt(5), optionally a Font(7)+ToUnicode(8) pair. Content
 * (and the CMap, if present) are deflated and, unless `streamFilter: "Identity"`,
 * AES-encrypted with a per-object key -- exactly the on-disk shape a real encrypted
 * PDF has (encrypt the *filtered* bytes; FlateDecode + optional Predictor undoes on
 * read what this undoes here in reverse order).
 */
function buildEncryptedPdf({
  userPassword = "",
  ownerPassword = "ownersecret",
  p = -1,
  encryptMetadata = true,
  streamFilter = "StdCF",
  stringFilter = "StdCF",
  content = "BT (Encrypted secret content) Tj ET",
  usePredictor = false,
  fontAndCMap = null
} = {}) {
  const keyLengthBytes = 16;
  const idBytes = randomBytes(16);
  const o = computeO(encode(ownerPassword), encode(userPassword), keyLengthBytes);
  const fileKey = computeFileKey(pad(encode(userPassword)), o, p, idBytes, keyLengthBytes, encryptMetadata);
  const u = computeU(fileKey, idBytes);

  function encryptedStreamBytes(objectNumber, plaintext) {
    let filtered = usePredictor ? pngUpEncode(plaintext, 8).encoded : plaintext;
    filtered = deflateSync(filtered);
    if (streamFilter === "Identity") return { data: filtered, filterClause: "/Filter /FlateDecode" };
    const objectKey = deriveObjectKey(fileKey, objectNumber, 0);
    return { data: aesEncrypt(objectKey, filtered), filterClause: "/Filter /FlateDecode" };
  }

  const contentBytes = encode(content);
  const encryptedContent = encryptedStreamBytes(4, contentBytes);
  const predictorClause = usePredictor ? " /DecodeParms << /Predictor 12 /Columns 8 >>" : "";

  const objects = [];
  const header = encode("%PDF-1.6\n");
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
    : " /CF << /StdCF << /CFM /AESV2 /Length 16 >> >>";
  const encryptDictionary = "<< /Filter /Standard /V 4 /R 4 /Length 128" +
    ` /O <${Buffer.from(o).toString("hex")}>` +
    ` /U <${Buffer.from(u).toString("hex")}>` +
    ` /P ${p} /EncryptMetadata ${encryptMetadata}` +
    ` /StmF /${streamFilter} /StrF /${stringFilter}${cfDictionary} >>`;
  place(5, encryptDictionary);

  if (fontAndCMap) {
    const cmapBytes = encode(fontAndCMap.cmap);
    const encryptedCMap = encryptedStreamBytes(8, cmapBytes);
    place(7, "<< /Type /Font /Subtype /Type0 /ToUnicode 8 0 R >>");
    place(8, encryptedCMap.filterClause, encryptedCMap.data);
  }

  const xrefOffset = pos;
  const maxNumber = Math.max(...offsets.keys());
  const table = [...offsets.keys()].sort((a, b) => a - b)
    .map((number) => `${number} 1\n${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`)
    .join("");
  const trailerPiece = encode(
    `xref\n0 1\n0000000000 65535 f \n${table}trailer\n<< /Size ${maxNumber + 1} /Root 1 0 R /Encrypt 5 0 R` +
    ` /ID [<${Buffer.from(idBytes).toString("hex")}> <${Buffer.from(idBytes).toString("hex")}>] >>` +
    `\nstartxref\n${xrefOffset}\n%%EOF\n`
  );
  chunks.push(trailerPiece);

  return concatBytes(chunks);
}

const JAPANESE_CMAP =
  "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n2 beginbfchar\n<0001> <65E5>\n<0002> <672C>\nendbfchar\nendcmap\nend end";

/* ------------------------------------------------ 1: empty user password, basic decrypt */

test("authenticates with an empty user password and decrypts AESV2 content to the original text", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "", p: -1 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["Encrypted secret content"]);
});

/* ------------------------------------------------------- 2: wrong password fails */

test("refuses a wrong password, recoverably (passwordRequired), without exposing it in the error", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "realpassword", ownerPassword: "ownersecret", p: -1 });
  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns("totally wrong"), (error) => {
    assert.match(error.message, /Password required/);
    assert.doesNotMatch(error.message, /totally wrong/);
    assert.equal(error.passwordRequired, true);
    assert.equal(error.encryptionDiagnosis.encrypted, true);
    return true;
  });
});

/* --------------------------------------------- 3: explicit correct user password */

test("authenticates with an explicitly supplied correct user password after an initial empty-password failure", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "opensesame", ownerPassword: "ownersecret", p: -1 });
  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns(), /Password required/);
  const runs = await editor.listTextRuns("opensesame");
  assert.deepEqual(runs.map((run) => run.text), ["Encrypted secret content"]);
});

/* ----------------------------------------------------------- 4: owner password */

test("authenticates via the owner password when the user password is unknown, distinguishing authType", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "opensesame", ownerPassword: "theowner", p: -1 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns("theowner");
  assert.deepEqual(runs.map((run) => run.text), ["Encrypted secret content"]);
  assert.equal(editor.security.authType, "owner");
  assert.equal(editor.security.authenticated, true);
});

test("distinguishes user-password authentication from owner-password authentication", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "", ownerPassword: "theowner", p: -1 });
  const editor = new PdfTextEditor(pdf);
  await editor.listTextRuns();
  assert.equal(editor.security.authType, "user");
});

/* ------------------------------------------------------- 5: permission enforcement */

test("blocks replaceText() when /P denies modification, but still allows search (listTextRuns)", async () => {
  // -44 has the modify bit (bit 4) clear -- the same worked example used throughout
  // this PR's diagnosis tests.
  const pdf = buildEncryptedPdf({ userPassword: "", p: -44 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.equal(runs.length, 1);
  assert.equal(editor.security.modifyAllowed, false);
  await assert.rejects(editor.replaceText(runs[0].id, "replacement"), /modification is not permitted/);
});

test("allows replaceText() to stage an edit when /P permits modification, but still refuses to save (re-encryption unimplemented)", async () => {
  // -1 (all bits set, including modify) is the simplest unambiguous "everything permitted" value.
  const pdf = buildEncryptedPdf({ userPassword: "", p: -1 });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.equal(editor.security.modifyAllowed, true);
  await editor.replaceText(runs[0].id, "replaced!");
  await assert.rejects(editor.save(), /Saving edits to an encrypted PDF is not supported/);
});

test("does not refuse save() on an authenticated encrypted PDF when nothing was actually edited", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "", p: -44 });
  const editor = new PdfTextEditor(pdf);
  await editor.listTextRuns();
  const output = await editor.save();
  assert.deepEqual(output, pdf);
});

/* --------------------------------------------------------------- 6: Identity */

test("does not attempt to decrypt a stream declared under /StmF /Identity", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "", streamFilter: "Identity", stringFilter: "Identity" });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["Encrypted secret content"]);
});

/* ---------------------------------------------------- 7/8: FlateDecode / Predictor */

test("decrypts AESV2 content that was also PNG-predictor-encoded before being deflated (decrypt -> inflate -> unpredict)", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "", usePredictor: true, content: "BT (Predictor plus AES) Tj ET" });
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["Predictor plus AES"]);
});

/* ------------------------------------------------------------- 9: ToUnicode */

test("decrypts an AESV2-encrypted ToUnicode CMap stream and recovers Japanese text", async () => {
  const pdf = buildEncryptedPdf({
    userPassword: "",
    content: "BT /FJP 12 Tf <00010002> Tj ET",
    fontAndCMap: { cmap: JAPANESE_CMAP }
  });
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  assert.equal(run.text, "日本");
  assert.equal(run.fontName, "FJP");
});

/* --------------------------------------------------------------- 10: PKCS#7 */

test("raises an explicit error for corrupted AES ciphertext instead of returning garbage", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "" });
  // AES-CBC decryption only scrambles the *specific* 16-byte plaintext block whose
  // ciphertext is corrupted (each block decrypts independently, XORed with the
  // previous ciphertext block only afterwards) -- so corrupting an early block
  // leaves the final block, where PKCS#7 padding lives, decrypting perfectly fine
  // and produces merely garbled *content* (a zlib error later), not a padding
  // failure. To reliably exercise the padding check itself, corrupt a byte in the
  // LAST 16-byte ciphertext block, immediately before "endstream".
  const marker = encode("\nendstream");
  const endIndex = Buffer.from(pdf).indexOf(Buffer.from(marker));
  const corrupted = Uint8Array.from(pdf);
  corrupted[endIndex - 1] ^= 0xff;
  const editor = new PdfTextEditor(corrupted);
  await assert.rejects(editor.listTextRuns(), /AES-CBC decryption failed/);
});

/* --------------------------------------------------------- 21: corpus assessment */

test("attaches an encryption summary (never the password) to the assessment record, without treating it as a success", async () => {
  const pdf = buildEncryptedPdf({ userPassword: "", p: -44 });
  const { record } = await assessPdfBytes("encrypted-r4-aesv2.pdf", pdf);
  assert.equal(record.load, true);
  assert.equal(record.extract, true);
  assert.equal(record.writeback, false);
  assert.match(record.error, /^writeback: Document modification is not permitted/);
  assert.deepEqual(record.encryption, {
    filter: "Standard", V: 4, R: 4, method: "AESV2", authenticated: true, authType: "user", modifyAllowed: false
  });
  assert.doesNotMatch(JSON.stringify(record), /password/i);
});
