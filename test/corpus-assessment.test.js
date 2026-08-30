import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessCorpus, assessFile } from "../scripts/assess-corpus.js";

const encode = (value) => new TextEncoder().encode(value);

function minimalPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 18 >>\nstream\nBT (Corpus) Tj ET\nendstream\nendobj\n"
  ];
  let source = "%PDF-1.4\n";
  const offsets = [];
  for (const object of objects) {
    offsets.push(encode(source).length);
    source += object;
  }
  const xref = encode(source).length;
  source += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(source);
}

test("assesses load through saved-PDF reopen and reports failures by stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-corpus-"));
  const good = join(directory, "good.pdf");
  const bad = join(directory, "bad.pdf");
  await writeFile(good, minimalPdf());
  await writeFile(bad, "not a PDF");

  const success = await assessFile(good);
  assert.deepEqual(
    [success.load, success.extract, success.replace, success.save, success.reopen, success.runCount, success.error],
    [true, true, true, true, true, 1, null]
  );
  const results = await assessCorpus([directory]);
  assert.equal(results.length, 2);
  assert.match(results.find((result) => result.file === bad).error, /^load: Input is not a PDF/);
});
