import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessCorpus, assessFile, parseArguments } from "../scripts/assess-corpus.js";

const encode = (value) => new TextEncoder().encode(value);

function minimalPdf(text = "Corpus") {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${text.length + 12} >>\nstream\nBT (${text}) Tj ET\nendstream\nendobj\n`
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
    [success.load, success.extract, success.writeback, success.writebackMode, success.save, success.reopen, success.runCount, success.error],
    [true, true, true, "same-bytes", true, true, 1, null]
  );
  const results = await assessCorpus([directory]);
  assert.equal(results.length, 2);
  assert.match(results.find((result) => result.file === bad).error, /^load: Input is not a PDF/);
});

test("writes same-named source PDFs to distinct stable output paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-corpus-collision-"));
  const word = join(directory, "word");
  const excel = join(directory, "excel");
  const output = join(directory, "assessed");
  await Promise.all([mkdir(word), mkdir(excel)]);
  await Promise.all([
    writeFile(join(word, "sample.pdf"), minimalPdf("Word")),
    writeFile(join(excel, "sample.pdf"), minimalPdf("Excel"))
  ]);

  const results = await assessCorpus([word, excel], output);
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((result) => result.outputFile)).size, 2);
  assert.ok(results.every((result) => /sample\.[a-f0-9]{12}\.assessed\.pdf$/.test(result.outputFile)));
  await Promise.all(results.map((result) => readFile(result.outputFile)));
  const repeated = await assessCorpus([word, excel], output);
  assert.deepEqual(repeated.map((result) => result.outputFile), results.map((result) => result.outputFile));
});

test("parses the CLI arguments without swallowing the first path", () => {
  // `indexOf("--output")` returns -1 when the option is absent, and the old parser
  // then dropped the argument at index 0 as if it were that option's value.
  assert.deepEqual(parseArguments(["corpus"]), { json: false, outputDirectory: null, paths: ["corpus"], error: null });
  assert.deepEqual(parseArguments(["corpus", "--json"]), { json: true, outputDirectory: null, paths: ["corpus"], error: null });
  assert.deepEqual(
    parseArguments(["--output", "out", "word", "excel"]),
    { json: false, outputDirectory: "out", paths: ["word", "excel"], error: null }
  );
  assert.deepEqual(
    parseArguments(["corpus", "--output", "out", "--json"]),
    { json: true, outputDirectory: "out", paths: ["corpus"], error: null }
  );
  assert.equal(parseArguments(["corpus", "--output"]).error, "--output requires a directory");
  assert.match(parseArguments([]).error, /^Usage: /);
  assert.match(parseArguments(["--json"]).error, /^Usage: /);
});

test("records an unreadable file as a load failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-corpus-missing-"));
  const result = await assessFile(join(directory, "absent.pdf"));
  assert.equal(result.load, false);
  assert.equal(result.outputFile, null);
  assert.match(result.error, /^load: /);
});
