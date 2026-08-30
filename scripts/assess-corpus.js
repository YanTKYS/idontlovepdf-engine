#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PdfTextEditor } from "../src/index.js";

function failure(file, stage, error, partial = {}) {
  return {
    file,
    load: false,
    extract: false,
    writeback: false,
    writebackMode: "same-bytes",
    save: false,
    reopen: false,
    readerDisplay: null,
    runCount: 0,
    ...partial,
    error: `${stage}: ${error instanceof Error ? error.message : String(error)}`
  };
}

export async function assessFile(path, outputDirectory = null) {
  const file = resolve(path);
  let editor;
  try {
    editor = new PdfTextEditor(await readFile(file));
  } catch (error) {
    return failure(file, "load", error);
  }

  let runs;
  try {
    runs = await editor.listTextRuns();
  } catch (error) {
    return failure(file, "extract", error, { load: true });
  }
  if (runs.length === 0) {
    return failure(file, "extract", "no editable text-showing operands found", { load: true });
  }

  try {
    // Reusing the original encoded bytes tests the complete replacement path without
    // assuming that a subset font contains any additional glyphs.
    await editor.replaceText(runs[0].id, runs[0].bytes);
  } catch (error) {
    return failure(file, "writeback", error, { load: true, extract: true, runCount: runs.length });
  }

  let output;
  try {
    output = await editor.save();
  } catch (error) {
    return failure(file, "save", error, { load: true, extract: true, writeback: true, runCount: runs.length });
  }

  try {
    const reopenedRuns = await new PdfTextEditor(output).listTextRuns();
    if (reopenedRuns.length === 0) throw new Error("saved PDF contains no editable text runs");
  } catch (error) {
    return failure(file, "reopen", error, {
      load: true, extract: true, writeback: true, save: true, runCount: runs.length
    });
  }

  let outputFile = null;
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    const pathHash = createHash("sha256").update(file).digest("hex").slice(0, 12);
    outputFile = join(resolve(outputDirectory), `${basename(file, extname(file))}.${pathHash}.assessed.pdf`);
    await writeFile(outputFile, output);
  }

  return {
    file,
    load: true,
    extract: true,
    writeback: true,
    writebackMode: "same-bytes",
    save: true,
    reopen: true,
    readerDisplay: null,
    outputFile,
    runCount: runs.length,
    error: null
  };
}

async function pdfFiles(path) {
  const absolute = resolve(path);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
  if (!entries) return extname(absolute).toLowerCase() === ".pdf" ? [absolute] : [];
  const nested = await Promise.all(entries.map((entry) => pdfFiles(resolve(absolute, entry.name))));
  return nested.flat();
}

export async function assessCorpus(paths, outputDirectory = null) {
  const files = [...new Set((await Promise.all(paths.map(pdfFiles))).flat())].sort();
  return Promise.all(files.map((file) => assessFile(file, outputDirectory)));
}

function summary(results) {
  const stages = ["load", "extract", "writeback", "save", "reopen"];
  return Object.fromEntries(stages.map((stage) => [stage, results.filter((result) => result[stage]).length]));
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const outputIndex = args.indexOf("--output");
  const outputDirectory = outputIndex < 0 ? null : args[outputIndex + 1];
  if (outputIndex >= 0 && !outputDirectory) {
    console.error("--output requires a directory");
    process.exitCode = 2;
    return;
  }
  const paths = args.filter((argument, index) => argument !== "--json" && index !== outputIndex && index !== outputIndex + 1);
  if (paths.length === 0) {
    console.error("Usage: npm run assess:corpus -- [--json] [--output DIR] <PDF-or-directory> [...]");
    process.exitCode = 2;
    return;
  }
  const results = await assessCorpus(paths, outputDirectory);
  if (json) console.log(JSON.stringify({ total: results.length, summary: summary(results), results }, null, 2));
  else {
    console.table(results.map(({ file, load, extract, writeback, writebackMode, save, reopen, runCount, error }) => ({
      file, load, extract, writeback, writebackMode, save, reopen, runCount, error: error ?? ""
    })));
    console.log({ total: results.length, ...summary(results) });
    console.log("readerDisplay is intentionally manual: open each saved candidate in Acrobat Reader or another independent reader.");
  }
  if (results.length === 0) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
