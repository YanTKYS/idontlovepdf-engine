// Fetches the Japanese font the fallback-font tests use, into tmp/test-fonts/, which git
// does not track -- a 4.5 MB binary does not belong in this repository's history.
//
// This is a test fixture, not a dependency of the engine. Nothing in src/ ever fetches
// anything: PdfTextEditor#setFallbackFont() is handed font bytes by its caller, which is
// what keeps the engine free of network access. The URL is pinned to an upstream release
// tag and the bytes are checked against a recorded SHA-256, so "the font" always means
// exactly one file and never "whatever is current".
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const TEST_FONT = {
  name: "BIZ UDGothic Regular",
  version: "1.05",
  // Morisawa's BIZ UD fonts, released by Google Fonts under the SIL Open Font License
  // 1.1. "UD" is Universal Design: the family is drawn for legibility in Japanese public
  // documents, which is the setting this engine is aimed at.
  license: "SIL Open Font License 1.1",
  source: "https://github.com/googlefonts/morisawa-biz-ud-gothic (tag v1.05)",
  url: "https://raw.githubusercontent.com/googlefonts/morisawa-biz-ud-gothic/v1.05/fonts/ttf/BIZUDGothic-Regular.ttf",
  licenseUrl: "https://raw.githubusercontent.com/googlefonts/morisawa-biz-ud-gothic/v1.05/OFL.txt",
  bytes: 4667376,
  sha256: "709fcd41e3209fb765da750472f55ccdf925653e9fa7e1eb007cb65c8f749c75",
  file: path.join(root, "tmp/test-fonts/BIZUDGothic-Regular.ttf"),
  licenseFile: path.join(root, "tmp/test-fonts/BIZUDGothic-OFL.txt")
};

/** The pinned font's bytes, or null when it has not been fetched yet. */
export function readTestFont() {
  if (!existsSync(TEST_FONT.file)) return null;
  const bytes = new Uint8Array(readFileSync(TEST_FONT.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== TEST_FONT.sha256) throw new Error(`${TEST_FONT.file} does not match the pinned SHA-256 (got ${digest}); delete it and re-run \`npm run test:font\``);
  return bytes;
}

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return bytes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bytes = await download(TEST_FONT.url, TEST_FONT.file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== TEST_FONT.sha256) throw new Error(`Downloaded font does not match the pinned SHA-256.\n  expected ${TEST_FONT.sha256}\n  actual   ${digest}`);
  if (bytes.length !== TEST_FONT.bytes) throw new Error(`Downloaded font is ${bytes.length} bytes, expected ${TEST_FONT.bytes}`);
  await download(TEST_FONT.licenseUrl, TEST_FONT.licenseFile);
  console.log(`${TEST_FONT.name} ${TEST_FONT.version} (${bytes.length} bytes, sha256 ${digest})`);
  console.log(`  font    -> ${path.relative(root, TEST_FONT.file)}`);
  console.log(`  license -> ${path.relative(root, TEST_FONT.licenseFile)}`);
}
