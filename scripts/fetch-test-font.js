// Fetches the Japanese fonts the fallback-font tests use, into tmp/test-fonts/, which git
// does not track -- multi-megabyte binaries do not belong in this repository's history.
//
// These are test fixtures, not a dependency of the engine. Nothing in src/ ever fetches
// anything: PdfTextEditor#setFallbackFont()/setFallbackFonts() are handed font bytes by
// their caller, which is what keeps the engine free of network access. Each URL is pinned
// to an upstream release tag and the bytes are checked against a recorded SHA-256, so "the
// font" always means exactly one file and never "whatever is current".
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Morisawa's BIZ UD fonts, released by Google Fonts under the SIL Open Font License 1.1.
// "UD" is Universal Design: the family is drawn for legibility in Japanese public
// documents, which is the setting this engine is aimed at. Gothic (sans-serif) is the
// v0.4.x fallback font; Mincho (serif) is the second one this PoC adds, so a document whose
// own font is serif can be given a serif-looking fallback instead of always Gothic (see
// src/font-classification.js and PdfTextEditor#setFallbackFonts()).
export const TEST_FONT = {
  name: "BIZ UDGothic Regular",
  version: "1.05",
  license: "SIL Open Font License 1.1",
  source: "https://github.com/googlefonts/morisawa-biz-ud-gothic (tag v1.05)",
  url: "https://raw.githubusercontent.com/googlefonts/morisawa-biz-ud-gothic/v1.05/fonts/ttf/BIZUDGothic-Regular.ttf",
  licenseUrl: "https://raw.githubusercontent.com/googlefonts/morisawa-biz-ud-gothic/v1.05/OFL.txt",
  bytes: 4667376,
  sha256: "709fcd41e3209fb765da750472f55ccdf925653e9fa7e1eb007cb65c8f749c75",
  file: path.join(root, "tmp/test-fonts/BIZUDGothic-Regular.ttf"),
  licenseFile: path.join(root, "tmp/test-fonts/BIZUDGothic-OFL.txt")
};

export const TEST_FONT_SERIF = {
  name: "BIZ UDMincho Regular",
  version: "1.06",
  license: "SIL Open Font License 1.1",
  source: "https://github.com/googlefonts/morisawa-biz-ud-mincho (tag v1.06)",
  url: "https://raw.githubusercontent.com/googlefonts/morisawa-biz-ud-mincho/v1.06/fonts/ttf/BIZUDMincho-Regular.ttf",
  licenseUrl: "https://raw.githubusercontent.com/googlefonts/morisawa-biz-ud-mincho/v1.06/OFL.txt",
  bytes: 6153932,
  sha256: "468ee6d9b149ca144809e03841bf18740ecf014e055a00da6ecaf1aaf4165af2",
  file: path.join(root, "tmp/test-fonts/BIZUDMincho-Regular.ttf"),
  licenseFile: path.join(root, "tmp/test-fonts/BIZUDMincho-OFL.txt")
};

/** `font`'s pinned bytes, or null when it has not been fetched yet. */
function readPinnedFont(font) {
  if (!existsSync(font.file)) return null;
  const bytes = new Uint8Array(readFileSync(font.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== font.sha256) throw new Error(`${font.file} does not match the pinned SHA-256 (got ${digest}); delete it and re-run \`npm run test:font\``);
  return bytes;
}

/** The pinned Gothic (sans-serif) font's bytes, or null when it has not been fetched yet. */
export function readTestFont() {
  return readPinnedFont(TEST_FONT);
}

/** The pinned Mincho (serif) font's bytes, or null when it has not been fetched yet. */
export function readTestFontSerif() {
  return readPinnedFont(TEST_FONT_SERIF);
}

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return bytes;
}

async function fetchPinned(font) {
  const bytes = await download(font.url, font.file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== font.sha256) throw new Error(`Downloaded ${font.name} does not match the pinned SHA-256.\n  expected ${font.sha256}\n  actual   ${digest}`);
  if (bytes.length !== font.bytes) throw new Error(`Downloaded ${font.name} is ${bytes.length} bytes, expected ${font.bytes}`);
  await download(font.licenseUrl, font.licenseFile);
  console.log(`${font.name} ${font.version} (${bytes.length} bytes, sha256 ${digest})`);
  console.log(`  font    -> ${path.relative(root, font.file)}`);
  console.log(`  license -> ${path.relative(root, font.licenseFile)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchPinned(TEST_FONT);
  await fetchPinned(TEST_FONT_SERIF);
}
