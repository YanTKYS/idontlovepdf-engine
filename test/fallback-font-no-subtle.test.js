// The fallback font, in a browser that has no Web Crypto.
//
// `crypto.subtle` is exposed only in a Secure Context. The deployment this engine is
// built for is an intranet IIS serving the page over plain HTTP, where `window.crypto`
// exists but `window.crypto.subtle` is `undefined` -- and `localhost`/`127.0.0.1` are
// exempt from that rule, so neither Node nor the Chromium test in test/browser/ shows
// the problem. This file is the check that does: it takes `subtle` away before the
// engine is loaded and runs the whole 令和 -> しょうわ flow, ending in a reopened file.
//
// It lives apart from test/fallback-font.test.js because it edits a global. `node --test`
// gives each file its own process, so the substitution here cannot reach another file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TEST_FONT, readTestFont } from "../scripts/fetch-test-font.js";

const fontBytes = readTestFont();
const skip = fontBytes ? false : `${TEST_FONT.name} is not present -- run \`npm run test:font\` to fetch it`;

/**
 * Stand in for a non-secure-context browser: `crypto` is present and can still make
 * random numbers, but has no `subtle` at all. Installed before the engine is imported,
 * so nothing can have captured the real one on the way in.
 */
const secureContextCrypto = globalThis.crypto;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { getRandomValues: (array) => secureContextCrypto.getRandomValues(array) }
});
const { PdfTextEditor } = await import("../src/index.js");

test("the substitution is in place -- otherwise the rest of this file proves nothing", () => {
  assert.equal(globalThis.crypto.subtle, undefined);
  assert.equal(typeof globalThis.crypto.getRandomValues, "function");
});

/* --------------------------------------------------------------------- the fixture */

const encode = (value) => new TextEncoder().encode(value);
const latin1 = new TextDecoder("latin1");

/** The document's own font knows these characters and no others -- し, ょ, う, わ are not among them. */
const CODES = new Map([["令", "0001"], ["和", "0002"], ["平", "0008"], ["成", "0009"]]);
const UNICODE = new Map([["0001", "4EE4"], ["0002", "548C"], ["0008", "5E73"], ["0009", "6210"]]);
const CMAP = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n${UNICODE.size} beginbfchar\n`
  + [...UNICODE].map(([code, unicode]) => `<${code}> <${unicode}>`).join("\n")
  + `\nendbfchar\nendcmap\nend end`;

function streamObject(number, content) {
  const stream = encode(content);
  return new Uint8Array([
    ...encode(`${number} 0 obj\n<< /Length ${stream.length} >>\nstream\n`),
    ...stream,
    ...encode("\nendstream\nendobj\n")
  ]);
}

function buildPdf(objects) {
  const chunks = [encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  chunks.push(encode(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + `${offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  ));
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

/** A one-page document drawing 令和 in a subsetted Type0 font. */
function makePdf() {
  const glyphs = `<${[...("令和")].map((character) => CODES.get(character)).join("")}>`;
  return buildPdf([
    encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 140] /Contents 4 0 R"
      + " /Resources << /Font << /FJP 5 0 R >> >> >>\nendobj\n"),
    streamObject(4, `BT /FJP 36 Tf 20 60 Td ${glyphs} Tj ET`),
    encode("5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n"),
    streamObject(6, CMAP)
  ]);
}

/* ------------------------------------------------------------------------- the flow */

test("embeds a fallback font and writes 令和 -> しょうわ with no crypto.subtle", { skip }, async () => {
  const editor = new PdfTextEditor(makePdf());
  await editor.setFallbackFont(fontBytes);

  const [match] = await editor.searchText("令和");
  assert.ok(match, "the fixture must contain 令和");
  assert.deepEqual(await editor.checkTextMatchReplacement(match.id, "しょうわ"), { allowed: true, mode: "fallback-font" });
  await editor.replaceTextMatch(match.id, "しょうわ");

  const saved = await editor.save();
  const reopened = new PdfTextEditor(saved);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["しょうわ"]);
  assert.equal((await reopened.searchText("しょうわ")).length, 1, "the replacement must be searchable as Unicode");
  assert.deepEqual(await reopened.searchText("令和"), []);
  assert.equal(latin1.decode(saved).match(/\/FontFile2/g).length, 1, "the font program must have been embedded once");
});

test("writes the same font digest Web Crypto would have written", { skip }, async () => {
  // The digest is what a later session matches an already-embedded font program against,
  // so the JavaScript path has to agree with the Web Crypto path byte for byte -- a
  // digest that differed would quietly embed a second copy of the same font instead.
  const editor = new PdfTextEditor(makePdf());
  await editor.setFallbackFont(fontBytes);
  const [match] = await editor.searchText("令和");
  await editor.replaceTextMatch(match.id, "しょうわ");
  const saved = latin1.decode(await editor.save());

  const written = saved.match(/\/ILPFallbackFont\s*<\s*([0-9a-f]+)\s*>/)?.[1];
  assert.equal(written, createHash("sha256").update(fontBytes).digest("hex"));
});

test("reuses the font already embedded, rather than embedding it a second time", { skip }, async () => {
  // Recognising the embedded program is exactly what the digest is for, and it is the
  // step that would silently regress if the two hash paths ever disagreed.
  const first = new PdfTextEditor(makePdf());
  await first.setFallbackFont(fontBytes);
  const [reiwa] = await first.searchText("令和");
  await first.replaceTextMatch(reiwa.id, "しょうわ");
  const once = await first.save();

  const second = new PdfTextEditor(once);
  await second.setFallbackFont(fontBytes);
  const [shouwa] = await second.searchText("しょうわ");
  await second.replaceTextMatch(shouwa.id, "へいせい");
  const twice = await second.save();

  const reopened = new PdfTextEditor(twice);
  assert.deepEqual((await reopened.listTextRuns()).map((run) => run.text), ["へいせい"]);
  assert.equal(latin1.decode(twice).match(/\/FontFile2/g).length, 1, "the font program must not be embedded twice");
  assert.ok(twice.length < once.length + 100_000, `the second save added ${twice.length - once.length} bytes`);
});
