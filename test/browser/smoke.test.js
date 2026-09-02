// Loads the built dist/idontlovepdf-engine.js in a real, headless browser (Chromium,
// via Playwright) and confirms it is actually usable as a browser ES Module: that it
// imports cleanly, exports PdfTextEditor and ENGINE_VERSION, and can load a minimal
// PDF and list its text runs -- all inside the page, with no Node APIs involved. This
// is deliberately not a string search over the bundle's source text.
//
// Run via `npm run test:browser` (its "pretest:browser" hook builds dist/ first).
// This is kept separate from the plain `npm test` (Node-only) suite because it needs
// Playwright's Chromium browser installed, which `npm ci` alone does not provide --
// run `npx playwright install chromium` locally, or see this project's CI workflow
// (.github/workflows/ci.yml) for the exact install step.
import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
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

test("searches and replaces text split across several runs in a real browser", async () => {
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
      const { PdfTextEditor } = await import("/idontlovepdf-engine.js");
      const encode = (value) => new TextEncoder().encode(value);

      // "令和6年度" as five string operands of one TJ array -- the reported structure --
      // plus a /ToUnicode CMap so the browser decodes and re-encodes it through the
      // PDF's own font. Everything here is browser-native: no Node APIs, no network.
      const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        + "6 beginbfchar\n<0001> <4EE4>\n<0002> <548C>\n<0003> <0036>\n<0004> <5E74>\n<0005> <5EA6>\n<0006> <0037>\nendbfchar\n"
        + "endcmap\nend end";
      const content = "BT /FJP 12 Tf 72 700 Td [<0001> 120 <0002> -20 <0003> 0 <0004> 0 <0005>] TJ ET";
      const stream = (number, body) => `${number} 0 obj\n<< /Length ${encode(body).length} >>\nstream\n${body}\nendstream\nendobj\n`;
      const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n",
        stream(4, content),
        "5 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n",
        stream(6, cmap)
      ];
      let source = "%PDF-1.4\n";
      const offsets = [];
      for (const object of objects) {
        offsets.push(encode(source).length);
        source += object;
      }
      const xrefOffset = encode(source).length;
      source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

      const editor = new PdfTextEditor(encode(source));
      const runTexts = (await editor.listTextRuns()).map((run) => run.text);
      // Two-character search across the run split -- the thing v0.2.0 could not do at
      // all. Run first: match ids belong to the most recent search, so the ids used for
      // the replacement below have to come from the search that immediately precedes it.
      const short = await editor.searchText("令和");
      const matches = await editor.searchText("令和6年度");

      await editor.replaceTextMatch(matches[0].id, "令和7年度");
      const reopened = new PdfTextEditor(await editor.save());
      return {
        runTexts,
        matchCount: matches.length,
        matchText: matches[0]?.text ?? null,
        matchRunCount: matches[0]?.runCount ?? null,
        shortMatchCount: short.length,
        reopenedRunTexts: (await reopened.listTextRuns()).map((run) => run.text),
        oldRemaining: (await reopened.searchText("令和6年度")).length,
        newFound: (await reopened.searchText("令和7年度")).length
      };
    });

    assert.deepEqual(pageErrors, []);
    // Five runs in the PDF: run-level search alone could never find the whole word.
    assert.deepEqual(result.runTexts, ["令", "和", "6", "年", "度"]);
    assert.equal(result.matchCount, 1);
    assert.equal(result.matchText, "令和6年度");
    assert.equal(result.matchRunCount, 5);
    assert.equal(result.shortMatchCount, 1, "searchText(\"令和\") must find the two-character substring too");
    assert.deepEqual(result.reopenedRunTexts, ["令", "和", "7", "年", "度"]);
    assert.equal(result.oldRemaining, 0);
    assert.equal(result.newFound, 1);
  } finally {
    await browser.close();
    server.close();
  }
});
