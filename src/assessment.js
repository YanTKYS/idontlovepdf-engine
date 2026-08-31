/**
 * Compatibility assessment shared by the Node CLI (scripts/assess-corpus.js) and the
 * browser PoC (web/poc-core.js).
 *
 * Both used to carry their own copy of this pipeline. They are meant to report the
 * same stages for the same PDF, so the pipeline lives here once; the callers only
 * differ in how they obtain the bytes and where they put the result.
 *
 * Nothing here touches the filesystem, the DOM or the network.
 */

import { PdfTextEditor } from "./index.js";

/** Assessment stages, in the order they run and are displayed. */
export const STAGES = ["load", "extract", "writeback", "save", "reopen"];

/**
 * How the writeback stage exercises replacement: the first run is rewritten with its
 * own original bytes. This checks the replace-to-save path without assuming a subset
 * font holds any glyph beyond the ones already used, so `writeback: true` never means
 * "replacing with different text would succeed".
 */
export const WRITEBACK_MODE = "same-bytes";

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A record for a PDF that failed at `stage`, with every later stage left false. */
export function failedRecord(file, stage, error, partial = {}) {
  return {
    file,
    load: false,
    extract: false,
    writeback: false,
    writebackMode: WRITEBACK_MODE,
    save: false,
    reopen: false,
    readerDisplay: null,
    runCount: 0,
    ...partial,
    error: `${stage}: ${messageOf(error)}`
  };
}

/**
 * Runs load / extract / writeback / save / reopen against one PDF.
 *
 * Never throws: every stage failure becomes a record whose `error` is prefixed with
 * the stage that failed, leaving the later stages false so callers can tell "failed
 * here" from "never attempted". `output` is the edited PDF when save succeeded.
 */
export async function assessPdfBytes(file, bytes) {
  let editor;
  try {
    editor = new PdfTextEditor(bytes);
  } catch (error) {
    return { record: failedRecord(file, "load", error), output: null };
  }

  let runs;
  try {
    runs = await editor.listTextRuns();
  } catch (error) {
    // listTextRuns() attaches a diagnosis (see src/encryption.js) instead of just
    // refusing encrypted PDFs outright; surface a short summary of it on the record
    // so a corpus run can tell "encrypted, and here's what kind" from a bare failure.
    const diagnosis = error?.encryptionDiagnosis;
    const partial = diagnosis?.encrypted
      ? { load: true, encryption: { filter: diagnosis.filter, V: diagnosis.version, R: diagnosis.revision, method: diagnosis.estimatedMethod } }
      : { load: true };
    return { record: failedRecord(file, "extract", error, partial), output: null };
  }
  if (runs.length === 0) {
    return { record: failedRecord(file, "extract", "no editable text-showing operands found", { load: true }), output: null };
  }

  try {
    await editor.replaceText(runs[0].id, runs[0].bytes);
  } catch (error) {
    return {
      record: failedRecord(file, "writeback", error, { load: true, extract: true, runCount: runs.length }),
      output: null
    };
  }

  let output;
  try {
    output = await editor.save();
  } catch (error) {
    return {
      record: failedRecord(file, "save", error, { load: true, extract: true, writeback: true, runCount: runs.length }),
      output: null
    };
  }

  try {
    const reopened = await new PdfTextEditor(output).listTextRuns();
    if (reopened.length === 0) throw new Error("saved PDF contains no editable text runs");
  } catch (error) {
    return {
      record: failedRecord(file, "reopen", error, {
        load: true, extract: true, writeback: true, save: true, runCount: runs.length
      }),
      output: null
    };
  }

  return {
    record: {
      file,
      load: true,
      extract: true,
      writeback: true,
      writebackMode: WRITEBACK_MODE,
      save: true,
      reopen: true,
      // readerDisplay is never decided automatically: only a human opening the saved
      // PDF in an independent reader can answer it.
      readerDisplay: null,
      runCount: runs.length,
      error: null
    },
    output
  };
}

/** Number of records that reached each stage. */
export function summarize(records) {
  return Object.fromEntries(STAGES.map((stage) => [stage, records.filter((record) => record[stage]).length]));
}
