// Fetches the fallback font used by the font-embedding experiment (see
// docs/experiments/font-embedding-poc.md) into tmp/poc-fonts/, which is not tracked by
// git -- a 4.5 MB binary does not belong in this repository's history.
//
// This runs at development time only. Nothing in src/ ever fetches anything: the engine
// is handed font bytes by its caller. The URL is pinned to an upstream release tag and
// the bytes are verified against a recorded SHA-256, so "the font" always means exactly
// one file and never "whatever is current".
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const POC_FONT = {
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
  file: path.join(root, "tmp/poc-fonts/BIZUDGothic-Regular.ttf"),
  licenseFile: path.join(root, "tmp/poc-fonts/BIZUDGothic-OFL.txt")
};

/** The pinned font's bytes, or null when it has not been fetched yet. */
export function readPocFont() {
  if (!existsSync(POC_FONT.file)) return null;
  const bytes = new Uint8Array(readFileSync(POC_FONT.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== POC_FONT.sha256) throw new Error(`${POC_FONT.file} does not match the pinned SHA-256 (got ${digest}); delete it and re-run \`npm run poc:font\``);
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
  const bytes = await download(POC_FONT.url, POC_FONT.file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== POC_FONT.sha256) throw new Error(`Downloaded font does not match the pinned SHA-256.\n  expected ${POC_FONT.sha256}\n  actual   ${digest}`);
  if (bytes.length !== POC_FONT.bytes) throw new Error(`Downloaded font is ${bytes.length} bytes, expected ${POC_FONT.bytes}`);
  await download(POC_FONT.licenseUrl, POC_FONT.licenseFile);
  console.log(`${POC_FONT.name} ${POC_FONT.version} (${bytes.length} bytes, sha256 ${digest})`);
  console.log(`  font    -> ${path.relative(root, POC_FONT.file)}`);
  console.log(`  license -> ${path.relative(root, POC_FONT.licenseFile)}`);
}
