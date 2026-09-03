// Hands an edited PDF to Chromium's own PDF viewer -- an implementation with nothing in
// common with this engine -- and fails if it reports any error while opening it. The same
// check test/browser/fallback-font.test.js makes on synthetic fixtures, run here against
// whatever file --out of scripts/verify-real-pdf-edit.js produced.
//
//   node scripts/verify-real-pdf-viewer.js <edited.pdf> [--screenshot out.png]
//
// Needs Playwright's Chromium (`npx playwright install --with-deps chromium`, already a
// devDependency). Makes no network access beyond serving the given file to itself over
// 127.0.0.1.
import http from "node:http";
import { readFileSync } from "node:fs";

import { chromium } from "playwright";

const args = process.argv.slice(2);
const file = args.find((argument) => !argument.startsWith("--"));
const optionOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
};

if (!file) {
  console.error("usage: node scripts/verify-real-pdf-viewer.js <edited.pdf> [--screenshot out.png]");
  process.exit(2);
}

const screenshotPath = optionOf("screenshot");
const pdfBytes = readFileSync(file);

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/viewer")) {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><style>html,body{margin:0;background:#fff}</style>'
      + '<embed id="v" style="width:820px;height:1060px" type="application/pdf" src="/doc.pdf">');
    return;
  }
  response.setHeader("Content-Type", "application/pdf");
  response.end(pdfBytes);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch({ channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 840, height: 1080 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/viewer`);
  await page.waitForSelector("embed#v");
  await page.waitForTimeout(4000);
  if (screenshotPath) await page.screenshot({ path: screenshotPath });

  console.log(JSON.stringify({ pageErrors: errors, screenshot: screenshotPath }));
  if (errors.length) {
    console.error("FAIL: Chromium's PDF viewer reported an error while opening the edited PDF");
    process.exitCode = 1;
  } else {
    console.log("OK: Chromium's own PDF viewer opened the edited file without error");
  }
} finally {
  await browser.close();
  server.close();
}
