// Runs the fallback-font path inside a real browser, from the SHIPPED bundle
// (dist/idontlovepdf-engine.js) rather than any test-only build, and then hands the saved
// PDF to Chromium's own PDF viewer -- an implementation with nothing in common with this
// engine -- to confirm it is a file a reader accepts.
//
// Needs the test font (`npm run test:font`); skips cleanly without it.
import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { TEST_FONT, readTestFont } from "../../scripts/fetch-test-font.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const bundle = path.join(root, "dist/idontlovepdf-engine.js");
const fontBytes = readTestFont();

const skip = !fontBytes
  ? `${TEST_FONT.name} is not present -- run \`npm run test:font\``
  : (!existsSync(bundle) ? "dist/idontlovepdf-engine.js is missing -- run `npm run build`" : false);

/** Serves the shipped bundle, the test font, and whatever PDF the test produced. */
function serve(state) {
  const server = http.createServer((request, response) => {
    const url = request.url.split("?")[0];
    if (url === "/idontlovepdf-engine.js") {
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
      : "<!doctype html><title>fallback font</title>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("writes text the document's font cannot express, in a browser, from the shipped bundle", { skip }, async () => {
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
      const { PdfTextEditor } = await import("/idontlovepdf-engine.js");
      const fontBytes = new Uint8Array(await (await fetch("/fallback.ttf")).arrayBuffer());
      const encode = (value) => new TextEncoder().encode(value);

      // A document whose font knows 申請は令和です and nothing else -- the shape of a real
      // PDF carrying a subsetted embedded font. None of しょうわ can be written through it.
      const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        + "7 beginbfchar\n<0001> <7533>\n<0002> <8ACB>\n<0003> <306F>\n<0004> <4EE4>\n<0005> <548C>\n<0006> <3067>\n<0007> <3059>\nendbfchar\nendcmap\nend end";
      const content = "BT /FJP 28 Tf 20 60 Td <0001000200030004000500060007> Tj ET";
      const stream = (number, body) => `${number} 0 obj\n<< /Length ${encode(body).length} >>\nstream\n${body}\nendstream\nendobj\n`;
      const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n",
        stream(4, content),
        "5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n",
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

      // Without a fallback font this is refused, exactly as it was before this existed.
      const plain = new PdfTextEditor(original);
      const [plainMatch] = await plain.searchText("令和");
      const refused = await plain.checkTextMatchReplacement(plainMatch.id, "しょうわ");

      const editor = new PdfTextEditor(original);
      await editor.setFallbackFont(fontBytes);
      const [match] = await editor.searchText("令和");
      const allowed = await editor.checkTextMatchReplacement(match.id, "しょうわ");
      await editor.replaceTextMatch(match.id, "しょうわ");
      const saved = await editor.save();

      const reopened = new PdfTextEditor(saved);
      return {
        refused,
        allowed,
        reopenedRunTexts: (await reopened.listTextRuns()).map((run) => run.text),
        found: (await reopened.searchText("しょうわ")).length,
        gone: (await reopened.searchText("令和")).length,
        originalBytes: original.length,
        savedBytes: saved.length,
        saved: [...saved]
      };
    });

    assert.deepEqual(pageErrors, []);
    assert.equal(result.refused.code, "FONT_ENCODING_UNSUPPORTED");
    assert.deepEqual(result.refused.characters, ["し", "ょ", "う", "わ"]);
    assert.deepEqual(result.allowed, { allowed: true, mode: "fallback-font-partial" });
    // The prefix and suffix stay in the document's own font; the replacement is embedded.
    assert.deepEqual(result.reopenedRunTexts, ["申請は", "しょうわ", "です"]);
    assert.equal(result.found, 1);
    assert.equal(result.gone, 0);
    assert.ok(result.savedBytes > result.originalBytes + 1_000_000, "the font should have been embedded");

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
    // A PNG of a blank page compresses to very little; one with glyphs on it does not.
    // A coarse "something was drawn" check -- that the glyphs are the right ones is
    // recorded, with renders, in docs/experiments/font-embedding-poc.md.
    assert.ok(shot.length > 3000, `Chromium appears to have rendered a blank page (${shot.length} byte screenshot)`);
  } finally {
    await browser.close();
    server.close();
  }
});
