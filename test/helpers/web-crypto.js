/**
 * Running a piece of a test with, and without, the Web Crypto API.
 *
 * `crypto.subtle` is exposed only in a Secure Context, and the deployment this engine is
 * built for -- an intranet IIS serving the page over plain HTTP -- is not one. Neither
 * Node nor a Playwright server on 127.0.0.1 is ever short of Web Crypto, so the only way
 * to test the environment the engine actually runs in is to take `subtle` away here.
 *
 * Both directions are forced explicitly, from node:crypto's own `webcrypto` rather than
 * from whatever `globalThis.crypto` happens to hold. That keeps a test that covers both
 * paths covering both paths even when the whole suite is run under
 * test/helpers/no-web-crypto.js (`npm run test:no-subtle`), where the global is already
 * gone before any test file loads.
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function install(value) {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
}

async function during(value, body, expectation) {
  const previous = globalThis.crypto;
  install(value);
  try {
    expectation();
    return await body();
  } finally {
    install(previous);
  }
}

/** Runs `body` with a real Web Crypto in place, whatever the surrounding environment has. */
export async function withWebCrypto(body) {
  return during(webcrypto, body, () => {
    assert.ok(globalThis.crypto?.subtle, "crypto.subtle must be present, or this proves nothing");
  });
}

/** Runs `body` as a page served over plain HTTP sees it: `crypto` present, `subtle` absent. */
export async function withoutWebCrypto(body) {
  const stub = { getRandomValues: (array) => webcrypto.getRandomValues(array) };
  return during(stub, body, () => {
    assert.equal(globalThis.crypto.subtle, undefined, "crypto.subtle must be gone, or this proves nothing");
  });
}
