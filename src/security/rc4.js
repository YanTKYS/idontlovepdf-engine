/**
 * Minimal RC4 stream cipher, scoped to the PDF Standard Security Handler (the /U and
 * /O value computation in Algorithms 3.3/3.5/3.7, and decrypting streams/strings for
 * a plain /V2 crypt filter -- see standard-r4.js). Web Crypto has no RC4 (it is
 * long-broken for anything security-sensitive; the PDF spec still specifies it for
 * this legacy handler). RC4 is symmetric, so the same function both encrypts and
 * decrypts.
 */
export function rc4(key, data) {
  if (key.length === 0) throw new Error("RC4 key must not be empty");
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const temp = s[i];
    s[i] = s[j];
    s[j] = temp;
  }
  const output = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const temp = s[i];
    s[i] = s[j];
    s[j] = temp;
    output[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return output;
}
