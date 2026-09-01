// Loads the built dist/idontlovepdf-engine.js in a real, headless browser (Chromium,
// via Playwright) and confirms it is actually usable as a browser ES Module: that it
// imports cleanly, exports PdfTextEditor and ENGINE_VERSION, and can load a minimal
// PDF and list its text runs -- all inside the page, with no Node APIs involved. This
// is deliberately not a string search over the bundle's source text.
//
// Run `npm run build` first (the "pretest" npm script does this automatically for
// `npm test`). Playwright's Chromium browser must be available locally -- see
// PLAYWRIGHT_BROWSERS_PATH in this project's CI workflow (.github/workflows/ci.yml)
// or run `npx playwright install chromium` locally.
import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distFile = path.join(root, "dist/idontlovepdf-engine.js");

/** Serves dist/idontlovepdf-engine.js and an inline HTML harness over plain HTTP,
 * since `import()` of a module needs a real origin (file:// URLs hit CORS/MIME
 * restrictions in Chromium for ES Modules). */
function serveDist() {
  const server = http.createServer((request, response) => {
    if (request.url === "/idontlovepdf-engine.js") {
      response.setHeader("Content-Type", "text/javascript");
      createReadStream(distFile).pipe(response);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>smoke</title>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("dist/idontlovepdf-engine.js loads and runs in a real browser", async () => {
  assert.ok(existsSync(distFile), "dist/idontlovepdf-engine.js is missing -- run `npm run build` first");

  const server = await serveDist();
  const { port } = server.address();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(`http://127.0.0.1:${port}/`);
    const result = await page.evaluate(async () => {
      const module = await import("/idontlovepdf-engine.js");
      const { PdfTextEditor, ENGINE_VERSION } = module;

      const hasEditor = typeof PdfTextEditor === "function";
      const hasVersion = typeof ENGINE_VERSION === "string" && ENGINE_VERSION.length > 0;

      // A minimal single-page PDF with one Tj text-showing operand, built with only
      // browser-native APIs (Uint8Array/TextEncoder) -- exactly as a real caller would.
      const encode = (value) => new TextEncoder().encode(value);
      const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
        "4 0 obj\n<< /Length 24 >>\nstream\nBT (Hello browser) Tj ET\nendstream\nendobj\n"
      ];
      let source = "%PDF-1.4\n";
      const offsets = [];
      for (const object of objects) {
        offsets.push(encode(source).length);
        source += object;
      }
      const xrefOffset = encode(source).length;
      source += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

      const editor = new PdfTextEditor(encode(source));
      const runs = await editor.listTextRuns();

      return {
        hasEditor,
        hasVersion,
        engineVersion: ENGINE_VERSION,
        runCount: runs.length,
        firstRunText: runs[0]?.text ?? null
      };
    });

    assert.deepEqual(pageErrors, []);
    assert.equal(result.hasEditor, true, "PdfTextEditor is not exported as a function");
    assert.equal(result.hasVersion, true, "ENGINE_VERSION is not exported as a non-empty string");
    assert.match(result.engineVersion, /^\d+\.\d+\.\d+/);
    assert.equal(result.runCount, 1);
    assert.equal(result.firstRunText, "Hello browser");
  } finally {
    await browser.close();
    server.close();
  }
});
