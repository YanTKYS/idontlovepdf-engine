// Builds the single-file, dependency-free browser ES Module bundle at
// dist/idontlovepdf-engine.js from the formal library entry point (src/index.js).
//
// esbuild is a devDependency only: it runs here, at build time, to produce the
// bundle -- it is never imported by src/ and never ships inside the bundle itself.
// The bundle's only runtime dependencies are browser-native APIs (Uint8Array,
// TextEncoder/TextDecoder, CompressionStream/DecompressionStream, crypto.subtle);
// nothing from Node (node:crypto, node:zlib, Buffer, ...) is reachable from
// src/index.js, so none of it ends up in the bundle. See test/dist-bundle.test.js
// and test/browser/smoke.test.js for the checks that back this up.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncVersion } from "./sync-version.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, "dist/idontlovepdf-engine.js");

const version = syncVersion();
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/index.js")],
  outfile,
  bundle: true,
  platform: "browser",
  format: "esm",
  // BigInt literals/logical-assignment (`??=`) are the newest syntax src/ relies on;
  // es2022 covers those and stays comfortably within what browsers implementing
  // CompressionStream/DecompressionStream and crypto.subtle already support.
  target: ["es2022"],
  legalComments: "none",
  sourcemap: false,
  minify: false,
  logLevel: "info"
});

console.log(`Built dist/idontlovepdf-engine.js (engine version ${version})`);
