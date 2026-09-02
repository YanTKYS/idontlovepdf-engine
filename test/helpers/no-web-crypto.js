/**
 * A `--import` preload that takes Web Crypto away from the whole process, so the test
 * suite can be run as a browser on plain HTTP would run it (`npm run test:no-subtle`).
 * `window.crypto` still exists there and can still make random numbers; it simply has no
 * `subtle`. Nothing in src/ may need it -- see the note in src/sha2.js.
 */
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { getRandomValues: (array) => webcrypto.getRandomValues(array) }
});
