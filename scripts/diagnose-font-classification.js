// Why a real document's Serif/Sans fallback-font choice came out the way it did.
//
//   node scripts/diagnose-font-classification.js <file.pdf> [--password <password>] --text <query> [--match <n>]
//
// v0.5.0 chooses BIZ UD明朝 (serif) or BIZ UDゴシック (sans) as the fallback font for a match,
// from the source run's own FontDescriptor /Flags (see src/font-classification.js). When
// that choice is wrong -- a document that looks serif throughout gets the sans fallback --
// `classification: "unknown"` or `classification: "sans"` alone does not say *why*: whether
// no FontDescriptor could be reached at all, an indirect /Flags could not be resolved, /Flags
// was 0, or /Flags plainly does not set the Serif bit. This prints that reason, plus the
// document structure it came from, so a real PDF's classification can be explained instead
// of guessed about -- exactly as scripts/diagnose-font-metrics.js already does for glyph
// widths.
//
// It reads. It never writes a file, and it makes no network access of any kind.
//
// For the first (or --match-numbered) occurrence of --text, this reports: the source font
// resource name, its /Subtype and /BaseFont, the /DescendantFonts walk and descendant
// /Subtype when it is a Type0 (reusing diagnoseFontMetrics()'s own trace -- the same walk
// classifyFontResourceDetailed() takes), the FontDescriptor this reached (form -- "indirect",
// "inline", or none -- and, for an indirect one, its object reference), /Flags (value and
// whether the Serif bit is set), which embedded font program keys (/FontFile, /FontFile2,
// /FontFile3) the FontDescriptor states, the classification and the developer-facing reason
// it came from (CLASSIFICATION_REASONS in src/font-classification.js), and which fallback
// role that would select given the fallback fonts currently registered on this editor (none,
// unless a caller of this script's exported helpers registers one first).
import { readFileSync } from "node:fs";

import { PdfTextEditor } from "../src/index.js";
import { diagnoseFallbackFontSelection, diagnoseFontMetrics } from "../src/pdf-document.js";

const args = process.argv.slice(2);
const file = args.find((argument) => !argument.startsWith("--"));
const optionOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
};

if (!file || !optionOf("text")) {
  console.error("usage: node scripts/diagnose-font-classification.js <file.pdf> [--password <password>] --text <query> [--match <n>]");
  process.exit(2);
}

const password = optionOf("password");
const query = optionOf("text");
const matchIndex = Number(optionOf("match") ?? "0");

const editor = new PdfTextEditor(new Uint8Array(readFileSync(file)));
const matches = await editor.searchText(query, password ?? undefined);

console.log(`${file}: ${matches.length} match(es) of ${JSON.stringify(query)}\n`);
if (!matches.length) process.exit(1);
if (!(matchIndex >= 0 && matchIndex < matches.length)) {
  console.error(`--match ${matchIndex} is out of range (0..${matches.length - 1})`);
  process.exit(2);
}
const match = matches[matchIndex];

const entry = (dictionary, key) => {
  if (!dictionary) return "(no dictionary)";
  const value = dictionary.match(new RegExp(`/${key}\\s*(<<.*?>>|/[^\\s/<>\\[\\]()]+|\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R|\\([^)]*\\)|[+-]?[\\d.]+)`, "s"))?.[1];
  if (value === undefined) return "(absent)";
  const collapsed = value.replace(/\s+/g, " ");
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}...` : collapsed;
};
const hasKey = (dictionary, key) => Boolean(dictionary) && new RegExp(`/${key}(?![A-Za-z0-9])`).test(dictionary);

const diagnosis = await diagnoseFallbackFontSelection(editor, match.id);
const metrics = await diagnoseFontMetrics(editor);
const font = metrics.find((candidate) => candidate.name === diagnosis.sourceFontName);

console.log(`match: ${matchIndex}`);
console.log(`text: ${JSON.stringify(match.text)}`);
console.log(`sourceFontResource: /${diagnosis.sourceFontName}`);
if (font) {
  console.log(`subtype: ${entry(font.dictionary, "Subtype")}`);
  console.log(`baseFont: ${entry(font.dictionary, "BaseFont")}`);
  if (font.descendant) {
    console.log(`descendantFonts: ${font.descendantObjectNumber === null ? "inline dictionary, no object of its own" : `object ${font.descendantObjectNumber}`}`);
    console.log(`descendantSubtype: ${entry(font.descendant, "Subtype")}`);
  } else {
    console.log("descendantFonts: (not a Type0 font)");
  }
} else {
  console.log("subtype/baseFont/descendantFonts: (font resource not found by diagnoseFontMetrics -- see fontDescriptor/flags below for what could still be reached)");
}
console.log("fontDescriptor:");
console.log(`  form: ${diagnosis.fontDescriptor.form ?? "(none reached)"}`);
console.log(`  object: ${diagnosis.fontDescriptor.object ?? "(none)"}`);
if (diagnosis.fontDescriptor.text) {
  console.log(`  fontName: ${entry(diagnosis.fontDescriptor.text, "FontName")}`);
  console.log(`  fontFamily: ${entry(diagnosis.fontDescriptor.text, "FontFamily")}`);
}
console.log("flags:");
console.log(`  value: ${diagnosis.flags.value ?? "(unreadable)"}`);
console.log(`  serifBit: ${diagnosis.flags.serifBit ?? "(unknown)"}`);
console.log("embeddedFont:");
if (diagnosis.fontDescriptor.text) {
  const kinds = ["FontFile", "FontFile2", "FontFile3"].filter((key) => hasKey(diagnosis.fontDescriptor.text, key));
  console.log(`  present: ${kinds.length > 0}`);
  console.log(`  type: ${kinds.length ? kinds.join(", ") : "(none)"}`);
} else {
  console.log("  present: false (no FontDescriptor reached)");
}
console.log(`classification: ${diagnosis.classification}`);
console.log(`classificationReason: ${diagnosis.reason ?? "(n/a)"}`);
console.log(`selectedFallbackRole: ${diagnosis.selectedRole ?? "(no fallback font registered on this editor)"}`);
console.log(`availableRoles: ${diagnosis.availableRoles.length ? diagnosis.availableRoles.join(", ") : "(none)"}`);
