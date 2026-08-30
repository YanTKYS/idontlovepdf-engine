#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STAGES, assessPdfBytes, failedRecord, summarize } from "../src/assessment.js";

/**
 * Assesses one PDF and, when an output directory is given, writes the edited result
 * next to a hash of the source path so that same-named PDFs from different folders
 * keep distinct, stable output names.
 */
export async function assessFile(path, outputDirectory = null) {
  const file = resolve(path);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    return { ...failedRecord(file, "load", error), outputFile: null };
  }

  const { record, output } = await assessPdfBytes(file, bytes);
  if (!output || !outputDirectory) return { ...record, outputFile: null };

  await mkdir(outputDirectory, { recursive: true });
  const pathHash = createHash("sha256").update(file).digest("hex").slice(0, 12);
  const outputFile = join(resolve(outputDirectory), `${basename(file, extname(file))}.${pathHash}.assessed.pdf`);
  await writeFile(outputFile, output);
  return { ...record, outputFile };
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
  // Sequential on purpose: a corpus can be large, and each file holds its original
  // bytes, the inflated streams and the edited result in memory while it is assessed.
  const results = [];
  for (const file of files) results.push(await assessFile(file, outputDirectory));
  return results;
}

/**
 * Splits `[--json] [--output DIR] <path>...`. The option indices are collected first
 * so that an absent `--output` cannot make `indexOf` return -1 and silently consume
 * the argument at index 0 as if it were the option's value.
 */
export function parseArguments(args) {
  const consumed = new Set();
  let json = false;
  let outputDirectory = null;
  for (const [index, argument] of args.entries()) {
    if (consumed.has(index)) continue;
    if (argument === "--json") {
      json = true;
      consumed.add(index);
    } else if (argument === "--output") {
      outputDirectory = args[index + 1] ?? null;
      consumed.add(index);
      if (outputDirectory !== null) consumed.add(index + 1);
    }
  }
  const paths = args.filter((argument, index) => !consumed.has(index));
  const error = args.includes("--output") && !outputDirectory
    ? "--output requires a directory"
    : (paths.length === 0 ? "Usage: npm run assess:corpus -- [--json] [--output DIR] <PDF-or-directory> [...]" : null);
  return { json, outputDirectory, paths, error };
}

async function main() {
  const { json, outputDirectory, paths, error } = parseArguments(process.argv.slice(2));
  if (error) {
    console.error(error);
    process.exitCode = 2;
    return;
  }
  const results = await assessCorpus(paths, outputDirectory);
  if (json) console.log(JSON.stringify({ total: results.length, summary: summarize(results), results }, null, 2));
  else {
    console.table(results.map(({ file, load, extract, writeback, writebackMode, save, reopen, runCount, error: reason }) => ({
      file, load, extract, writeback, writebackMode, save, reopen, runCount, error: reason ?? ""
    })));
    console.log({ total: results.length, ...summarize(results) });
    console.log(`stages: ${STAGES.join(" -> ")}`);
    console.log("readerDisplay is intentionally manual: open each saved candidate in Acrobat Reader or another independent reader.");
  }
  if (results.length === 0) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
