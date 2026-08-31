/**
 * AES-128-CBC decryption for PDF AESV2 streams/strings, via the Web Crypto API
 * (globalThis.crypto.subtle -- present in both modern browsers and modern Node,
 * so no browser/Node adapter is needed here). PDF AES data is laid out as
 * `IV (16 bytes) || ciphertext`. SubtleCrypto's AES-CBC decrypt removes PKCS#7
 * padding itself and rejects when the padding is invalid, which is exactly the
 * "explicit error on bad padding" behaviour this needs -- no separate unpadding
 * step is written by hand here.
 */

function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("Web Crypto API (crypto.subtle) is not available in this environment");
  return value;
}

/** Decrypts `ivAndCiphertext` (IV || AES-CBC ciphertext) with the given raw AES key. */
export async function decryptAesCbc(key, ivAndCiphertext) {
  if (ivAndCiphertext.length < 16) throw new Error("AES-CBC data is shorter than one IV block (16 bytes)");
  const iv = ivAndCiphertext.subarray(0, 16);
  const ciphertext = ivAndCiphertext.subarray(16);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error("AES-CBC ciphertext length is not a multiple of the 16-byte block size");
  }
  const cryptoKey = await subtle().importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  try {
    const plain = await subtle().decrypt({ name: "AES-CBC", iv }, cryptoKey, ciphertext);
    return new Uint8Array(plain);
  } catch (error) {
    // SubtleCrypto reports a bad key or bad PKCS#7 padding the same way (an
    // OperationError with no further detail); both mean the data cannot be trusted.
    throw new Error(`AES-CBC decryption failed (invalid key or invalid PKCS#7 padding): ${error.message}`);
  }
}
