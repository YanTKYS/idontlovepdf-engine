// EXPERIMENT -- see docs/experiments/font-embedding-poc.md.
//
// The Node tests prove the engine can write, save and re-read a character the document's
// own font has no code for. They cannot prove a PDF reader agrees. This runs the whole
// flow inside a real browser and then hands the saved bytes to Chromium's PDF viewer --
// an implementation with nothing in common with this engine -- and checks that the page
// actually draws something where the replaced text is.
//
// Needs the fallback font (`npm run poc:font`) and the experiment's own bundle
// (`npm run poc:build`); skips cleanly without them.
import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { POC_FONT, readPocFont } from "../../scripts/fetch-poc-font.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const bundle = path.join(root, "dist/experimental/font-embedding-poc.js");
const fontBytes = readPocFont();

const skip = !fontBytes
  ? `${POC_FONT.name} is not present -- run \`npm run poc:font\``
  : (!existsSync(bundle) ? "dist/experimental/font-embedding-poc.js is missing -- run `npm run poc:build`" : false);

/** Serves the experiment's bundle, the fallback font, and whatever PDF the test produced. */
function serve(state) {
  const server = http.createServer((request, response) => {
    const url = request.url.split("?")[0];
    if (url === "/font-embedding-poc.js") {
      response.setHeader("Content-Type", "text/javascript");
      return createReadStream(bundle).pipe(response);
    }
    if (url === "/fallback.ttf") {
      response.setHeader("Content-Type", "font/ttf");
      return response.end(Buffer.from(fontBytes));
    }
    if (url === "/saved.pdf") {
      response.setHeader("Content-Type", "application/pdf");
      return response.end(Buffer.from(state.saved ?? []));
    }
    response.setHeader("Content-Type", "text/html");
    response.end(url === "/viewer"
      ? `<!doctype html><style>html,body{margin:0;background:#fff}</style><embed id="v" style="width:640px;height:220px" type="application/pdf" src="/saved.pdf?${Date.now()}">`
      : "<!doctype html><title>font embedding poc</title>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("embeds a Japanese font in the browser and Chromium's PDF viewer renders the result", { skip }, async () => {
  const state = {};
  const server = await serve(state);
  const { port } = server.address();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto(`http://127.0.0.1:${port}/`);

    const result = await page.evaluate(async () => {
      const { PdfTextEditor, loadFallbackFont, replaceTextMatchWithFallbackFont, checkTextMatchReplacementWithFallback } =
        await import("/font-embedding-poc.js");
      const fallback = loadFallbackFont(new Uint8Array(await (await fetch("/fallback.ttf")).arrayBuffer()));
      const encode = (value) => new TextEncoder().encode(value);

      // A document whose font knows 令 和 で す and nothing else, so 昭 cannot be written
      // through it -- the shape of a real PDF carrying a subsetted embedded font.
      const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        + "4 beginbfchar\n<0001> <4EE4>\n<0002> <548C>\n<0003> <3067>\n<0004> <3059>\nendbfchar\nendcmap\nend end";
      const content = "BT /FJP 36 Tf 20 60 Td <00010002> Tj ET BT /FJP 36 Tf 190 60 Td <00030004> Tj ET";
      const stream = (number, body) => `${number} 0 obj\n<< /Length ${encode(body).length} >>\nstream\n${body}\nendstream\nendobj\n`;
      const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 140] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n",
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
      const original = encode(source);

      const editor = new PdfTextEditor(original);
      const [match] = await editor.searchText("令和");
      const refused = await editor.checkTextMatchReplacement(match.id, "昭和");
      const allowed = await checkTextMatchReplacementWithFallback(editor, match.id, "昭和", { font: fallback });
      await replaceTextMatchWithFallbackFont(editor, match.id, "昭和", { font: fallback });
      const saved = await editor.save();

      const reopened = new PdfTextEditor(saved);
      return {
        refusedCode: refused.code,
        allowed,
        reopenedRunTexts: (await reopened.listTextRuns()).map((run) => run.text),
        found: (await reopened.searchText("昭和")).length,
        gone: (await reopened.searchText("令和")).length,
        originalBytes: original.length,
        savedBytes: saved.length,
        saved: [...saved]
      };
    });

    assert.deepEqual(pageErrors, []);
    // The engine's own path refuses; the experiment's path accepts.
    assert.equal(result.refusedCode, "FONT_ENCODING_UNSUPPORTED");
    assert.deepEqual(result.allowed, { allowed: true, mode: "fallback-font-whole-run", usesFallbackFont: true });
    assert.deepEqual(result.reopenedRunTexts, ["昭和", "です"]);
    assert.equal(result.found, 1);
    assert.equal(result.gone, 0);
    assert.ok(result.savedBytes > result.originalBytes + 1_000_000, "the font should have been embedded");

    // Now the part the engine cannot vouch for: does a PDF reader draw it?
    state.saved = result.saved;
    const viewer = await browser.newPage({ viewport: { width: 660, height: 240 } });
    const viewerErrors = [];
    viewer.on("pageerror", (error) => viewerErrors.push(error));
    await viewer.goto(`http://127.0.0.1:${port}/viewer`);
    await viewer.waitForSelector("embed#v");
    await viewer.waitForTimeout(4000);
    const shot = await viewer.screenshot();
    await viewer.close();

    assert.deepEqual(viewerErrors, []);
    // A PNG of a blank page compresses to very little; a page with glyphs on it does not.
    // This is a coarse "something was drawn" check, not a pixel comparison -- the visual
    // confirmation that the glyphs are the right ones is recorded in the PoC document.
    assert.ok(shot.length > 3000, `Chromium appears to have rendered a blank page (${shot.length} byte screenshot)`);
  } finally {
    await browser.close();
    server.close();
  }
});
