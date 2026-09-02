/**
 * SHA-256, in whichever way the environment can do it.
 *
 * Web Crypto (`crypto.subtle`) is only exposed in a Secure Context: HTTPS, or the
 * `localhost`/`127.0.0.1` exemption. A browser loading this engine over plain HTTP --
 * an intranet IIS serving a page to office PCs, which is how this is deployed -- has a
 * `crypto` object with no `subtle` on it at all, so `crypto.subtle.digest` there is not
 * a rejected promise but a TypeError on undefined. That is not a configuration to fix
 * at the call site; it is the environment the engine has to work in, so the digest
 * falls back to a JavaScript implementation and every feature that hashes keeps working.
 *
 * The fallback is @noble/hashes -- an audited, dependency-free MIT implementation --
 * rather than a hand-written one: a hash written here would be new, unreviewed code on
 * a path where a wrong answer is silent (see fallback-font.js, where the digest decides
 * whether an embedded font program is the one the caller supplied). test/sha2.test.js
 * checks both paths against node:crypto over inputs spanning the block and length-field
 * boundaries, and asserts they agree with each other.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";

/** SHA-256 of `bytes`, as a Uint8Array. */
export async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return nobleSha256(bytes);
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

/** SHA-256 of `bytes`, as lowercase hex. */
export async function sha256Hex(bytes) {
  return [...await sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
