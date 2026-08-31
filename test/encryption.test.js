import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { analyzeEncryption, summarizeEncryption } from "../src/encryption.js";
import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);

/**
 * A minimal stand-in for PdfStructure: just enough shape (`encryptReference` plus a
 * synchronous `object()`) for analyzeEncryption() to run against, without building a
 * real PDF. This is what makes analyzeEncryption() testable as a pure function, per
 * its own design (see src/encryption.js's module docstring).
 */
function fixture(dictionaryText) {
  return {
    encryptReference: { number: 9, generation: 0 },
    object(ref) {
      assert.equal(ref.number, 9, "analyzeEncryption should look up the Encrypt dictionary by encryptReference");
      return { dictionary: dictionaryText };
    }
  };
}

/* --------------------------------------------------- 1: no /Encrypt at all */

test("reports encrypted: false when there is no /Encrypt reference", () => {
  const structure = { encryptReference: null, object: () => { throw new Error("should not be called"); } };
  assert.deepEqual(analyzeEncryption(structure), { encrypted: false });
});

/* --------------------------------------------------- 2: Standard Handler detection */

test("recognises /Filter /Standard as the Standard Security Handler", () => {
  const diagnosis = analyzeEncryption(fixture("<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 >>"));
  assert.equal(diagnosis.encrypted, true);
  assert.equal(diagnosis.filter, "Standard");
  assert.equal(diagnosis.standardHandler, true);
});

/* --------------------------------------------------- 3: V = 1/2/4/5 */

test("reads /V for each documented value", () => {
  for (const v of [1, 2, 4, 5]) {
    const diagnosis = analyzeEncryption(fixture(`<< /Filter /Standard /V ${v} /R 4 /Length 128 /P -1 >>`));
    assert.equal(diagnosis.version, v);
  }
});

/* --------------------------------------------------- 4: R revision */

test("reads /R independently of /V", () => {
  const diagnosis = analyzeEncryption(fixture("<< /Filter /Standard /V 4 /R 6 /Length 256 /P -1 >>"));
  assert.equal(diagnosis.revision, 6);
});

/* --------------------------------------------------- 5: /Length bits, including its default */

test("reads /Length in bits, defaulting to 40 when the Standard handler omits it", () => {
  const withLength = analyzeEncryption(fixture("<< /Filter /Standard /V 2 /R 3 /Length 128 /P -1 >>"));
  assert.equal(withLength.lengthBits, 128);

  const withoutLength = analyzeEncryption(fixture("<< /Filter /Standard /V 1 /R 2 /P -1 >>"));
  assert.equal(withoutLength.lengthBits, 40);
});

/* --------------------------------------------------- 6: /EncryptMetadata true/false/omitted */

test("reads /EncryptMetadata, defaulting to true when absent (per spec)", () => {
  const explicitTrue = analyzeEncryption(fixture("<< /Filter /Standard /V 4 /R 4 /Length 128 /P -1 /EncryptMetadata true >>"));
  assert.equal(explicitTrue.encryptMetadata, true);

  const explicitFalse = analyzeEncryption(fixture("<< /Filter /Standard /V 4 /R 4 /Length 128 /P -1 /EncryptMetadata false >>"));
  assert.equal(explicitFalse.encryptMetadata, false);

  const omitted = analyzeEncryption(fixture("<< /Filter /Standard /V 4 /R 4 /Length 128 /P -1 >>"));
  assert.equal(omitted.encryptMetadata, true);
});

/* --------------------------------------------------- 7: /CF and /CFM parsing */

test("parses /CF crypt filters and labels each /CFM family", () => {
  const dictionary = `<< /Filter /Standard /V 4 /R 4 /Length 128 /P -1 /StmF /StdCF /StrF /StdCF
    /CF << /StdCF << /CFM /AESV2 /Length 16 /AuthEvent /DocOpen >>
           /Identity << /CFM /None >> >> >>`;
  const diagnosis = analyzeEncryption(fixture(dictionary));
  assert.equal(diagnosis.streamFilter, "StdCF");
  assert.equal(diagnosis.stringFilter, "StdCF");
  assert.deepEqual(diagnosis.cryptFilters.find((f) => f.name === "StdCF"), {
    name: "StdCF", method: "AESV2", methodLabel: "AES-128系", length: 16, authEvent: "DocOpen"
  });
  assert.deepEqual(diagnosis.cryptFilters.find((f) => f.name === "Identity"), {
    name: "Identity", method: "None", methodLabel: "暗号化なし（Crypt Filter経由の平文）", length: null, authEvent: null
  });
});

test("labels /CFM /AESV3 as an AES-256 family", () => {
  const diagnosis = analyzeEncryption(fixture(
    "<< /Filter /Standard /V 5 /R 6 /Length 256 /P -1 /StmF /StdCF /StrF /StdCF /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> >>"
  ));
  assert.equal(diagnosis.cryptFilters[0].methodLabel, "AES-256系");
  assert.equal(diagnosis.estimatedMethod, "Standard Security Handler / AES-256系");
});

test("labels /CFM /V2 as RC4, not as an AES family", () => {
  const diagnosis = analyzeEncryption(fixture(
    "<< /Filter /Standard /V 4 /R 4 /Length 128 /P -1 /StmF /StdCF /StrF /StdCF /CF << /StdCF << /CFM /V2 /Length 16 >> >> >>"
  ));
  assert.equal(diagnosis.cryptFilters[0].method, "V2");
  assert.equal(diagnosis.cryptFilters[0].methodLabel, "RC4系");
});

/* --------------------------------------------------- 8: /P permission bits */

test("decodes /P permission bits, matching a known P = -44, R4 fixture", () => {
  // -44 as int32 has bits 3 (print), 5 (copy), and all of 9-12 set, but not bit 4
  // (modify) or bit 6 (annotate) -- the same worked example the task itself specifies.
  const diagnosis = analyzeEncryption(fixture("<< /Filter /Standard /V 4 /R 4 /Length 128 /P -44 >>"));
  assert.equal(diagnosis.permissionsRaw, -44);
  assert.deepEqual(diagnosis.permissions, {
    print: true,
    modify: false,
    copy: true,
    annotate: false,
    fillForms: true,
    extractForAccessibility: true,
    assembleDocument: true,
    printHighQuality: true
  });
});

test("does not interpret revision-3-only permission bits under revision 2", () => {
  const diagnosis = analyzeEncryption(fixture("<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 >>"));
  assert.equal(diagnosis.revision, 2);
  assert.deepEqual(diagnosis.permissions, {
    print: true,
    modify: false,
    copy: true,
    annotate: false,
    fillForms: null,
    extractForAccessibility: null,
    assembleDocument: null,
    printHighQuality: null
  });
});

/* --------------------------------------------------- 9: non-Standard handler */

test("does not treat /Filter /Adobe.PubSec as the Standard handler, and does not guess its fields", () => {
  const diagnosis = analyzeEncryption(fixture("<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /R 4 >>"));
  assert.equal(diagnosis.encrypted, true);
  assert.equal(diagnosis.filter, "Adobe.PubSec");
  assert.equal(diagnosis.subFilter, "adbe.pkcs7.s5");
  assert.equal(diagnosis.standardHandler, false);
  assert.equal(diagnosis.permissionsRaw, null);
  assert.equal(diagnosis.permissions, null);
  assert.deepEqual(diagnosis.cryptFilters, []);
  assert.equal(diagnosis.estimatedMethod, null);

  assert.equal(summarizeEncryption(diagnosis), "Standard以外のSecurity Handler: Adobe.PubSec");
});

/* --------------------------------------------------- summarizeEncryption() */

test("summarizes a Standard/AES fixture as a short 'Standard / AES-128 / R4' style label", () => {
  const diagnosis = analyzeEncryption(fixture(
    "<< /Filter /Standard /V 4 /R 4 /Length 128 /P -44 /StmF /StdCF /StrF /StdCF /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>"
  ));
  assert.equal(summarizeEncryption(diagnosis), "Standard / AES-128 / R4");
});

/* --------------------------------------------------- integration: real PdfTextEditor fixtures */

/** Places a run of `N 0 obj` bodies one after another, tracking each one's byte offset. */
function placeObjects(headerChunks, headerLength, objects) {
  const chunks = [...headerChunks];
  const offsets = new Map();
  let pos = headerLength;
  for (const object of objects) {
    offsets.set(object.number, pos);
    let piece;
    if (object.streamBytes) {
      const extra = object.dictionary ? `${object.dictionary} ` : "";
      piece = encode(`${object.number} 0 obj\n<< ${extra}/Length ${object.streamBytes.length} >>\nstream\n`);
      chunks.push(piece); pos += piece.length;
      chunks.push(object.streamBytes); pos += object.streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece); pos += piece.length;
    } else {
      piece = encode(`${object.number} 0 obj\n${object.dictionary}\nendobj\n`);
      chunks.push(piece); pos += piece.length;
    }
  }
  return { chunks, pos, offsets };
}

function concatChunks(chunks) {
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

const ENCRYPT_DICTIONARY =
  "<< /Filter /Standard /V 4 /R 4 /Length 128 /P -44 /EncryptMetadata true /StmF /StdCF /StrF /StdCF" +
  " /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>";

/** Catalog(1)/Pages(2)/Page(3)/Contents(4)/Encrypt(5), classic `xref`/`trailer`. */
function classicEncryptedPdf() {
  const header = encode("%PDF-1.6\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode("BT (Should not be reachable) Tj ET") },
    { number: 5, dictionary: ENCRYPT_DICTIONARY }
  ];
  const placed = placeObjects([header], header.length, objects);
  const xrefOffset = placed.pos;
  const table = objects
    .map((object) => `${object.number} 1\n${String(placed.offsets.get(object.number)).padStart(10, "0")} 00000 n \n`)
    .join("");
  const piece = encode(
    `xref\n0 1\n0000000000 65535 f \n${table}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );
  return concatChunks([...placed.chunks, piece]);
}

/* --------------------------------------------------- 10: Encrypt reference from a classic trailer */

test("resolves /Encrypt from a classic trailer without failing xref resolution, and refuses content extraction", async () => {
  const pdf = classicEncryptedPdf();
  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns(), (error) => {
    assert.match(error.message, /^Encrypted PDFs are not supported \(Standard \/ AES-128 \/ R4\)$/);
    assert.equal(error.encryptionDiagnosis.encrypted, true);
    assert.equal(error.encryptionDiagnosis.standardHandler, true);
    assert.equal(error.encryptionDiagnosis.estimatedMethod, "Standard Security Handler / AES-128系");
    return true;
  });
});

function bigEndian(value, width) {
  const bytes = [];
  for (let index = width - 1; index >= 0; index -= 1) bytes.push((value >>> (index * 8)) & 0xff);
  return bytes;
}

/* --------------------------------------------------- 11: Encrypt reference from an xref-stream trailer */

test("resolves /Encrypt from a cross-reference stream's own dictionary", async () => {
  const header = encode("%PDF-1.6\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode("BT (Should not be reachable) Tj ET") },
    { number: 5, dictionary: ENCRYPT_DICTIONARY }
  ];
  const placed = placeObjects([header], header.length, objects);
  const w = [1, 4, 2];
  const rows = [
    Uint8Array.of(0, ...bigEndian(0, w[1]), ...bigEndian(65535, w[2])),
    ...objects.map((object) => Uint8Array.of(1, ...bigEndian(placed.offsets.get(object.number), w[1]), ...bigEndian(0, w[2]))),
    Uint8Array.of(1, ...bigEndian(placed.pos, w[1]), ...bigEndian(0, w[2]))
  ];
  const data = Uint8Array.from(rows.flatMap((row) => [...row]));
  const dict = `<< /Type /XRef /Size 7 /W [${w.join(" ")}] /Root 1 0 R /Encrypt 5 0 R /Length ${data.length} >>`;
  const xrefOffset = placed.pos;
  const piece = concatChunks([
    encode(`6 0 obj\n${dict}\nstream\n`),
    data,
    encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
  ]);
  const pdf = concatChunks([...placed.chunks, piece]);

  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns(), (error) => {
    assert.match(error.message, /^Encrypted PDFs are not supported/);
    assert.equal(error.encryptionDiagnosis.encrypted, true);
    return true;
  });
});

/* --------------------------------------------------- 12: xref stream + Predictor + Encrypt, combined */

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

/** PNG-predictor-12 ("Up" filter, byte 2) encoding of fixed-width xref rows. */
function pngUpEncode(rows) {
  const rowBytes = rows[0].length;
  const out = [];
  let previous = new Uint8Array(rowBytes);
  for (const raw of rows) {
    out.push(2);
    for (let index = 0; index < rowBytes; index += 1) out.push((raw[index] - previous[index]) & 0xff);
    previous = raw;
  }
  return Uint8Array.from(out);
}

test("diagnoses /Encrypt through the same combination the real target PDF uses: xref stream + FlateDecode + PNG Predictor", async () => {
  const header = encode("%PDF-1.6\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode("BT (Should not be reachable) Tj ET") },
    { number: 5, dictionary: ENCRYPT_DICTIONARY }
  ];
  const placed = placeObjects([header], header.length, objects);
  const w = [1, 4, 2];
  const rowBytes = w[0] + w[1] + w[2];
  // No explicit /Index, so /Index defaults to [0, Size] and rows are assigned
  // SEQUENTIAL object numbers 0..6 in array order: rows must therefore be built in
  // ascending object-number order, not construction order.
  const offsetFor = { ...Object.fromEntries(placed.offsets), 6: placed.pos };
  const rows = [0, 1, 2, 3, 4, 5, 6].map((number) =>
    number === 0
      ? Uint8Array.of(0, ...bigEndian(0, w[1]), ...bigEndian(65535, w[2]))
      : Uint8Array.of(1, ...bigEndian(offsetFor[number], w[1]), ...bigEndian(0, w[2]))
  );
  const compressed = deflateSync(pngUpEncode(rows));
  const dict = `<< /Type /XRef /Size 7 /W [${w.join(" ")}] /Root 1 0 R /Encrypt 5 0 R /Filter /FlateDecode` +
    ` /DecodeParms << /Predictor 12 /Columns ${rowBytes} >> /Length ${compressed.length} >>`;
  const xrefOffset = placed.pos;
  const piece = concatChunks([
    encode(`6 0 obj\n${dict}\nstream\n`),
    compressed,
    encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
  ]);
  const pdf = concatChunks([...placed.chunks, piece]);

  const editor = new PdfTextEditor(pdf);
  await assert.rejects(editor.listTextRuns(), (error) => {
    assert.equal(error.message, "Encrypted PDFs are not supported (Standard / AES-128 / R4)");
    const diagnosis = error.encryptionDiagnosis;
    assert.equal(diagnosis.standardHandler, true);
    assert.equal(diagnosis.version, 4);
    assert.equal(diagnosis.revision, 4);
    assert.equal(diagnosis.lengthBits, 128);
    assert.equal(diagnosis.estimatedMethod, "Standard Security Handler / AES-128系");
    assert.deepEqual(diagnosis.permissions, {
      print: true, modify: false, copy: true, annotate: false,
      fillForms: true, extractForAccessibility: true, assembleDocument: true, printHighQuality: true
    });
    return true;
  });
});
