/**
 * AES-CBC decryption for PDF AESV2/AESV3 streams and strings, laid out as
 * `IV (16 bytes) || ciphertext` with PKCS#7 padding.
 *
 * Web Crypto (`globalThis.crypto.subtle`) does this in one call, removing the padding
 * itself and rejecting when it is invalid -- exactly the "explicit error on bad padding"
 * behaviour this needs. But `crypto.subtle` exists only in a Secure Context, and this
 * engine is served to office PCs over plain HTTP from an intranet IIS, where an
 * encrypted PDF still has to open. So where Web Crypto is absent the same work is done
 * with the AES block cipher in aes-primitives.js -- already in this repository, already
 * checked against the FIPS 197 known-answer vectors -- plus the PKCS#7 unpadding step
 * SubtleCrypto would otherwise have performed. test/aes.test.js runs both paths against
 * node:crypto and against each other, padding failures included.
 */
import { aesCbcNoPaddingDecrypt } from "./aes-primitives.js";

/**
 * Removes PKCS#7 padding (RFC 5652 §6.3), rejecting anything that is not valid padding.
 * Checked in full rather than trusting the last byte: a wrong key produces plaintext that
 * happens to end in a plausible length byte roughly one time in 256, and accepting that
 * would silently hand back data with 1-16 real bytes cut off its end.
 */
function removePkcs7Padding(plain) {
  const padding = plain[plain.length - 1];
  if (padding < 1 || padding > 16 || padding > plain.length) throw new Error("invalid PKCS#7 padding");
  for (let index = plain.length - padding; index < plain.length; index += 1) {
    if (plain[index] !== padding) throw new Error("invalid PKCS#7 padding");
  }
  return plain.subarray(0, plain.length - padding);
}

/** Decrypts `ivAndCiphertext` (IV || AES-CBC ciphertext) with the given raw AES key. */
export async function decryptAesCbc(key, ivAndCiphertext) {
  if (ivAndCiphertext.length < 16) throw new Error("AES-CBC data is shorter than one IV block (16 bytes)");
  const iv = ivAndCiphertext.subarray(0, 16);
  const ciphertext = ivAndCiphertext.subarray(16);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error("AES-CBC ciphertext length is not a multiple of the 16-byte block size");
  }
  const subtle = globalThis.crypto?.subtle;
  try {
    if (!subtle) return removePkcs7Padding(aesCbcNoPaddingDecrypt(key, iv, ciphertext));
    const cryptoKey = await subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, ciphertext));
  } catch (error) {
    // SubtleCrypto reports a bad key or bad PKCS#7 padding the same way (an
    // OperationError with no further detail); both mean the data cannot be trusted, and
    // the JavaScript path is reported the same way so callers cannot tell them apart.
    throw new Error(`AES-CBC decryption failed (invalid key or invalid PKCS#7 padding): ${error.message}`);
  }
}
