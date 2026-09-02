// Bundles the font-embedding EXPERIMENT for the browser, at
// dist/experimental/font-embedding-poc.js, so test/browser/font-embedding-poc.test.js
// can run the whole flow inside a real browser.
//
// Deliberately a separate entry point from scripts/build.js: the experiment pulls in
// opentype.js, and the shipped dist/idontlovepdf-engine.js must not grow by a font
// parser for a capability it does not expose. Nothing here is released.
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, "dist/experimental/font-embedding-poc.js");
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/experimental/poc-entry.js")],
  outfile,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  legalComments: "none",
  sourcemap: false,
  minify: false,
  logLevel: "info"
});

console.log(`Built dist/experimental/font-embedding-poc.js (${statSync(outfile).size} bytes)`);
