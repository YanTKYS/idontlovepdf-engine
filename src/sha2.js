/**
 * SHA-256, SHA-384 and SHA-512, in whichever way the environment can do it.
 *
 * Web Crypto (`crypto.subtle`) is only exposed in a Secure Context: HTTPS, or the
 * `localhost`/`127.0.0.1` exemption. A browser loading this engine over plain HTTP --
 * an intranet IIS serving a page to office PCs, which is how this is deployed -- has a
 * `crypto` object with no `subtle` on it at all, so `crypto.subtle.digest` there is not
 * a rejected promise but a TypeError on undefined. That is not a configuration to fix
 * at the call site; it is the environment the engine has to work in, so hashing falls
 * back to a JavaScript implementation and every feature that hashes keeps working.
 *
 * The fallback is @noble/hashes -- an audited, dependency-free MIT implementation --
 * rather than a hand-written one: a hash written here would be new, unreviewed code on
 * paths where a wrong answer is silent or security-relevant. It decides whether an
 * embedded font program is the one the caller supplied (fallback-font.js), and it is
 * every hash step of Algorithm 2.B (security/standard-r6.js).
 *
 * test/sha2.test.js checks both paths against node:crypto over inputs spanning the
 * block and length-field boundaries, and asserts the two agree with each other.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { sha384 as nobleSha384, sha512 as nobleSha512 } from "@noble/hashes/sha512";

/** Keyed by Web Crypto's algorithm names, so the fast path passes `algorithm` straight through. */
const IN_JAVASCRIPT = new Map([
  ["SHA-256", nobleSha256],
  ["SHA-384", nobleSha384],
  ["SHA-512", nobleSha512]
]);

/** `algorithm` ("SHA-256", "SHA-384" or "SHA-512") of `bytes`, as a Uint8Array. */
export async function sha2(algorithm, bytes) {
  const inJavaScript = IN_JAVASCRIPT.get(algorithm);
  if (!inJavaScript) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return inJavaScript(bytes);
  return new Uint8Array(await subtle.digest(algorithm, bytes));
}

/** SHA-256 of `bytes`, as a Uint8Array. */
export async function sha256(bytes) {
  return sha2("SHA-256", bytes);
}

/** SHA-256 of `bytes`, as lowercase hex. */
export async function sha256Hex(bytes) {
  return [...await sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
