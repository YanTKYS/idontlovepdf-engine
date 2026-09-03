// Why a document's fonts can, or cannot, be measured.
//
//   node scripts/diagnose-font-metrics.js <file.pdf> [--password <password>] [--text 令和]
//
// A `TJ` fallback replacement is refused with FALLBACK_FONT_METRICS_UNAVAILABLE when the
// engine cannot read the glyph widths a PDF reader positions the text with. That refusal
// is deliberately vague to the user -- it says nothing about the file's internals -- which
// makes it useless for working out what a real document actually looks like. This prints
// the internals, for exactly that purpose.
//
// It reads. It never writes a file, and it makes no network access of any kind.
//
// For each page's font resources it reports the font object, its /Subtype, /BaseFont and
// /Encoding, the descendant CIDFont if there is one, which of the width-bearing entries
// are direct values and which are indirect objects (and what those objects turn out to
// be), and the verdict: how many bytes a character code takes, or the reason no widths
// could be established. With --text it also shows the exact operand bytes the query is
// drawn with, and the width this font gives each of those codes.
import { readFileSync } from "node:fs";

import { PdfTextEditor, diagnoseFontMetrics } from "../src/pdf-document.js";

const args = process.argv.slice(2);
const file = args.find((argument) => !argument.startsWith("--"));
const optionOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
};

if (!file) {
  console.error("usage: node scripts/diagnose-font-metrics.js <file.pdf> [--password <password>] [--text <query>]");
  process.exit(2);
}

const password = optionOf("password");
const query = optionOf("text");

const editor = new PdfTextEditor(new Uint8Array(readFileSync(file)));
const runs = await editor.listTextRuns(password ?? undefined);
const report = await diagnoseFontMetrics(editor);

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const entry = (dictionary, key) => {
  const value = dictionary.match(new RegExp(`/${key}\\s*(<<.*?>>|/[^\\s/<>\\[\\]()]+|\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R|\\([^)]*\\)|[+-]?[\\d.]+)`, "s"))?.[1];
  if (value === undefined) return "(absent)";
  const collapsed = value.replace(/\s+/g, " ");
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}...` : collapsed;
};

console.log(`${file}: ${report.length} font resource(s) on ${new Set(report.map((font) => font.contentStream)).size} content stream(s)\n`);

for (const font of report) {
  console.log(`/${font.name}  (object ${font.objectNumber}, content stream ${font.contentStream})`);
  console.log(`  /Subtype    ${entry(font.dictionary, "Subtype")}`);
  console.log(`  /BaseFont   ${entry(font.dictionary, "BaseFont")}`);
  console.log(`  /Encoding   ${entry(font.dictionary, "Encoding")}`);
  console.log(`  /ToUnicode  ${entry(font.dictionary, "ToUnicode")}`);
  console.log(`  writing     ${font.writingMode}`);
  if (font.descendant) {
    console.log("  descendant font:");
    for (const key of ["Subtype", "BaseFont", "CIDSystemInfo", "CIDToGIDMap", "DW", "W"]) {
      console.log(`    /${key.padEnd(12)} ${entry(font.descendant, key)}`);
    }
  } else {
    for (const key of ["FirstChar", "LastChar", "Widths", "FontDescriptor"]) {
      console.log(`  /${key.padEnd(11)} ${entry(font.dictionary, key)}`);
    }
  }
  if (font.related.length) {
    console.log("  indirect objects it depends on:");
    for (const item of font.related) {
      console.log(`    /${item.key} -> ${item.reference}  [${item.kind}]  ${item.detail.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  if (font.metrics) {
    console.log(`  VERDICT     widths readable, ${font.codeBytes} byte(s) per character code`);
  } else {
    console.log(`  VERDICT     no widths: ${font.reason}${font.detail ? ` (${font.detail})` : ""}`);
    console.log("              a TJ fallback replacement with text after it is refused as FALLBACK_FONT_METRICS_UNAVAILABLE");
  }

  if (query) {
    const drawn = runs.filter((run) => run.fontName === font.name && run.text.includes(query));
    for (const run of drawn.slice(0, 5)) {
      const codes = [];
      if (font.metrics) {
        for (let index = 0; index < run.bytes.length; index += font.codeBytes) {
          const code = font.codeBytes === 2 ? (run.bytes[index] << 8) | run.bytes[index + 1] : run.bytes[index];
          codes.push(`${code.toString(16).padStart(font.codeBytes * 2, "0")}=${font.metrics.widthOf(code)}`);
        }
      }
      console.log(`  run ${run.id}  ${JSON.stringify(run.text)}  <${hex(run.bytes)}>`);
      if (codes.length) console.log(`    code=width  ${codes.join(" ")}`);
    }
    if (!drawn.length) console.log(`  (no run of this font contains ${JSON.stringify(query)})`);
  }
  console.log("");
}
