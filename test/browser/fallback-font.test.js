// Runs the fallback-font path inside a real browser, from the SHIPPED bundle
// (dist/idontlovepdf-engine.js) rather than any test-only build, and then hands the saved
// PDF to Chromium's own PDF viewer -- an implementation with nothing in common with this
// engine -- to confirm it is a file a reader accepts.
//
// Needs the test font (`npm run test:font`); skips cleanly without it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
/** What the engine must record on the embedded font, computed here by OpenSSL. */
const FONT_DIGEST = fontBytes && createHash("sha256").update(fontBytes).digest("hex");

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

/**
 * Everything the browser does, as one closure-free function so both tests below run
 * exactly the same code -- once normally, once with Web Crypto taken away. Playwright
 * ships this to the page by source, so it may not capture anything from this module.
 */
async function fallbackFlowInPage({ includeSaved }) {
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
    // The digest recorded on the embedded font, so the two tests can be compared: the
    // same font must be identified the same way whether or not Web Crypto was there.
    digest: new TextDecoder("latin1").decode(saved).match(/\/ILPFallbackFont\s*<\s*([0-9a-f]+)\s*>/)?.[1],
    hadWebCrypto: Boolean(globalThis.crypto?.subtle),
    // Only the first test hands the file to Chromium's PDF viewer; shipping several
    // megabytes back as an array of numbers is slow enough to be worth asking for.
    saved: includeSaved ? [...saved] : null
  };
}

/**
 * The v0.4.1 case: text drawn by a `TJ` array with a real kern in it, replaced through the
 * fallback font, with the year after the era expected to stay exactly where it was. Written
 * as its own page function for the same reason as the one above -- Playwright ships it to
 * the browser by source, so it captures nothing from this module.
 */
async function tjFlowInPage() {
  const { PdfTextEditor } = await import("/idontlovepdf-engine.js");
  const fontBytes = new Uint8Array(await (await fetch("/fallback.ttf")).arrayBuffer());
  const encode = (value) => new TextEncoder().encode(value);

  // 令和8年度, drawn as one TJ array. The font knows those five characters and no others,
  // and its widths are not all 1000 -- 和 is 950 and 8 is 500 -- so the rewrite has to do
  // the arithmetic rather than assume full-width glyphs.
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
    + "5 beginbfchar\n<0001> <4EE4>\n<0002> <548C>\n<0003> <0038>\n<0004> <5E74>\n<0005> <5EA6>\nendbfchar\nendcmap\nend end";
  const content = "BT /FJP 28 Tf 20 60 Td [<00010002> -50 <000300040005>] TJ ET";
  const stream = (number, body) => `${number} 0 obj\n<< /Length ${encode(body).length} >>\nstream\n${body}\nendstream\nendobj\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] /Contents 4 0 R /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n",
    stream(4, content),
    "5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Doc /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>\nendobj\n",
    stream(6, cmap),
    "7 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Doc /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>"
      + " /FontDescriptor 8 0 R /DW 1000 /W [1 [1000] 2 [950] 3 [500] 4 [1000] 5 [1000]] /CIDToGIDMap /Identity >>\nendobj\n",
    "8 0 obj\n<< /Type /FontDescriptor /FontName /ABCDEF+Doc /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n"
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
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  const allowed = await editor.checkTextMatchReplacement(match.id, "しょ");
  await editor.replaceTextMatch(match.id, "しょ");
  const saved = await editor.save();

  const reopened = new PdfTextEditor(saved);
  const runs = (await reopened.listTextRuns()).map((run) => run.text);
  await reopened.listTextRuns();
  return {
    allowed,
    runs,
    found: (await reopened.searchText("しょ")).length,
    gone: (await reopened.searchText("令和")).length,
    year: (await reopened.searchText("8年度")).length,
    // The rewritten operators, so the adjustment the engine wrote can be checked outside.
    rewritten: new TextDecoder("latin1").decode(reopened.streams[0].decoded),
    saved: [...saved]
  };
}

test("keeps the text after a TJ match in place, in a browser, and opens in Chromium's viewer", { skip }, async () => {
  const state = {};
  const server = await serve(state);
  const { port } = server.address();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto(`http://127.0.0.1:${port}/`);

    const result = await page.evaluate(tjFlowInPage);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(result.allowed, { allowed: true, mode: "fallback-font" });
    assert.deepEqual(result.runs, ["しょ", "8年度"]);
    assert.equal(result.found, 1);
    assert.equal(result.gone, 0);
    assert.equal(result.year, 1, "8年度 must still be there, and still searchable");
    // 令和 was 1000 + 950 glyph-space units wide and しょ is 1000 + 1000, so the array is
    // pulled back by exactly 50 -- and the document's own -50 kern is still written once.
    assert.match(result.rewritten, /\/ILPFallback 28 Tf \[<[0-9a-f]+>\] TJ \/FJP 28 Tf \[50 -50 <000300040005>\] TJ/);

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
    assert.ok(shot.length > 3000, `Chromium appears to have rendered a blank page (${shot.length} byte screenshot)`);
  } finally {
    await browser.close();
    server.close();
  }
});

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

    const result = await page.evaluate(fallbackFlowInPage, { includeSaved: true });

    assert.deepEqual(pageErrors, []);
    assert.equal(result.hadWebCrypto, true, "127.0.0.1 is a Secure Context, so this run should have used Web Crypto");
    assert.equal(result.refused.code, "FONT_ENCODING_UNSUPPORTED");
    assert.deepEqual(result.refused.characters, ["し", "ょ", "う", "わ"]);
    assert.deepEqual(result.allowed, { allowed: true, mode: "fallback-font-partial" });
    // The prefix and suffix stay in the document's own font; the replacement is embedded.
    assert.deepEqual(result.reopenedRunTexts, ["申請は", "しょうわ", "です"]);
    assert.equal(result.found, 1);
    assert.equal(result.gone, 0);
    assert.ok(result.savedBytes > result.originalBytes + 1_000_000, "the font should have been embedded");
    assert.equal(result.digest, FONT_DIGEST);

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

test("does the same with no Web Crypto, as on a page served over plain HTTP", { skip }, async () => {
  // `crypto.subtle` exists only in a Secure Context. Playwright has to serve the bundle
  // from 127.0.0.1, which is exempt from that rule -- so the test above runs with Web
  // Crypto available no matter how the engine is deployed, and cannot show what happens
  // on the intranet IIS this is installed on, which serves plain HTTP to a machine name.
  // Taking `subtle` away in the page is the closest a local server can get to that.
  const server = await serve({});
  const { port } = server.address();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    // Before any script of ours runs, and so before the bundle is imported.
    await page.addInitScript(() => {
      const real = window.crypto;
      Object.defineProperty(window, "crypto", {
        configurable: true,
        value: { getRandomValues: (array) => real.getRandomValues(array) }
      });
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    assert.equal(await page.evaluate(() => window.crypto.subtle), undefined, "subtle must be gone, or this test proves nothing");

    const result = await page.evaluate(fallbackFlowInPage, { includeSaved: false });

    assert.deepEqual(pageErrors, []);
    assert.equal(result.hadWebCrypto, false);
    assert.equal(result.refused.code, "FONT_ENCODING_UNSUPPORTED");
    assert.deepEqual(result.allowed, { allowed: true, mode: "fallback-font-partial" });
    assert.deepEqual(result.reopenedRunTexts, ["申請は", "しょうわ", "です"]);
    assert.equal(result.found, 1);
    assert.equal(result.gone, 0);
    assert.ok(result.savedBytes > result.originalBytes + 1_000_000, "the font should have been embedded");
    // The point of the whole change: the JavaScript digest is the right one, so a font
    // embedded over HTTP is still recognised by a session that has Web Crypto, and back.
    assert.equal(result.digest, FONT_DIGEST);
  } finally {
    await browser.close();
    server.close();
  }
});
