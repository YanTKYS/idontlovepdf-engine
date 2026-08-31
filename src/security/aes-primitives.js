/**
 * A minimal, from-scratch AES-128/AES-256 block cipher (FIPS 197 Rijndael), used
 * only for the Standard Security Handler revision 6 operations that need AES
 * without PKCS#7 padding: Algorithm 2.B's inner AES-128-CBC step, /UE and /OE
 * (AES-256-CBC, zero IV), and /Perms (a single AES-256 block, no chaining needed).
 *
 * `src/security/aes.js` (Web Crypto's `crypto.subtle`) stays the implementation for
 * actual PDF AESV2/AESV3 stream/string decryption (IV || ciphertext, real PKCS#7
 * padding) -- that is exactly what SubtleCrypto is for, and there is no reason to
 * duplicate it here. SubtleCrypto's AES-CBC, however, always adds/strips PKCS#7
 * padding and has no ECB mode at all, so it cannot be reused for the operations
 * above without corrupting them (a data block that does not happen to end in valid
 * padding bytes makes SubtleCrypto's decrypt throw; one that accidentally does would
 * silently lose 1-16 real data bytes). Implemented directly from the FIPS 197
 * S-box/Rcon tables and GF(2^8) arithmetic -- not adapted from another project's
 * source -- and checked in tests against the official FIPS 197 Appendix C.1/C.3
 * known-answer test vectors (AES-128 and AES-256), not just self-consistency.
 *
 * No external npm dependency.
 */

// FIPS 197 Figure 7, the S-box (forward substitution table).
const SBOX = Uint8Array.of(
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
);

const INV_SBOX = new Uint8Array(256);
for (let index = 0; index < 256; index += 1) INV_SBOX[SBOX[index]] = index;

// FIPS 197 5.2, the round constant word array (only the first byte of each word is
// non-zero, so this holds just that byte -- Rcon[i][0] for i = 1..10, 1-indexed).
const RCON = Uint8Array.of(0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d);

/** GF(2^8) multiplication modulo the AES reduction polynomial x^8+x^4+x^3+x+1 (0x11b). */
function gmul(a, b) {
  let product = 0;
  let x = a;
  let y = b;
  for (let bit = 0; bit < 8; bit += 1) {
    if (y & 1) product ^= x;
    const carry = x & 0x80;
    x = (x << 1) & 0xff;
    if (carry) x ^= 0x1b;
    y >>= 1;
  }
  return product;
}

/**
 * FIPS 197 5.2 KeyExpansion, generalized over Nk (4 for a 128-bit key, 8 for a
 * 256-bit key -- the only two lengths this module needs). Returns the round-key
 * schedule as `4*(Nr+1)` 4-byte words, plus `roundCount` (Nr).
 */
function expandKey(key) {
  const wordCount = key.length / 4; // Nk: 4 or 8
  if (!Number.isInteger(wordCount) || (wordCount !== 4 && wordCount !== 8)) {
    throw new Error(`Unsupported AES key length: ${key.length} bytes (only 16 or 32 are supported)`);
  }
  const roundCount = wordCount + 6; // Nr: 10 for AES-128, 14 for AES-256
  const words = [];
  for (let index = 0; index < wordCount; index += 1) {
    words.push(Uint8Array.of(key[4 * index], key[4 * index + 1], key[4 * index + 2], key[4 * index + 3]));
  }
  const totalWords = 4 * (roundCount + 1);
  for (let index = wordCount; index < totalWords; index += 1) {
    let temp = words[index - 1];
    if (index % wordCount === 0) {
      // RotWord, then SubWord, then XOR the round constant into the first byte.
      temp = Uint8Array.of(SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]);
      temp = Uint8Array.of(temp[0] ^ RCON[index / wordCount - 1], temp[1], temp[2], temp[3]);
    } else if (wordCount > 6 && index % wordCount === 4) {
      // AES-256 only (FIPS 197 5.2): an extra SubWord every 4th word within a key.
      temp = Uint8Array.of(SBOX[temp[0]], SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]]);
    }
    const previous = words[index - wordCount];
    words.push(Uint8Array.of(previous[0] ^ temp[0], previous[1] ^ temp[1], previous[2] ^ temp[2], previous[3] ^ temp[3]));
  }
  return { words, roundCount };
}

// `Uint8Array.prototype.slice()` always copies -- but `Buffer` (which is-a
// `Uint8Array`, and is exactly what `crypto.randomBytes()`/Node crypto APIs hand
// back) OVERRIDES `.slice()` with its own legacy view-sharing semantics, so
// `buffer.slice()` does NOT copy -- it aliases the same underlying memory. Calling
// `input.slice()` here for what is meant to be an independent mutable copy would
// then silently mutate the CALLER's own bytes in place whenever `input` happens to
// be a real Buffer rather than a plain Uint8Array (both are common inputs to a
// module like this one). `Uint8Array.from()` always copies regardless of which one
// it is given, which is what every copy in this module actually needs.
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}

function addRoundKey(state, words, round) {
  for (let column = 0; column < 4; column += 1) {
    const word = words[4 * round + column];
    for (let row = 0; row < 4; row += 1) state[row + 4 * column] ^= word[row];
  }
}

function subBytes(state, table) {
  for (let index = 0; index < 16; index += 1) state[index] = table[state[index]];
}

/** Row r shifted left by r (encryption direction). */
function shiftRows(state) {
  const copy = copyBytes(state);
  for (let row = 1; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) state[row + 4 * column] = copy[row + 4 * ((column + row) % 4)];
  }
}

/** Row r shifted right by r (decryption direction) -- the inverse of shiftRows(). */
function invShiftRows(state) {
  const copy = copyBytes(state);
  for (let row = 1; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) state[row + 4 * column] = copy[row + 4 * ((column - row + 4) % 4)];
  }
}

function mixColumns(state) {
  for (let column = 0; column < 4; column += 1) {
    const base = 4 * column;
    const [s0, s1, s2, s3] = [state[base], state[base + 1], state[base + 2], state[base + 3]];
    state[base] = gmul(s0, 2) ^ gmul(s1, 3) ^ s2 ^ s3;
    state[base + 1] = s0 ^ gmul(s1, 2) ^ gmul(s2, 3) ^ s3;
    state[base + 2] = s0 ^ s1 ^ gmul(s2, 2) ^ gmul(s3, 3);
    state[base + 3] = gmul(s0, 3) ^ s1 ^ s2 ^ gmul(s3, 2);
  }
}

function invMixColumns(state) {
  for (let column = 0; column < 4; column += 1) {
    const base = 4 * column;
    const [s0, s1, s2, s3] = [state[base], state[base + 1], state[base + 2], state[base + 3]];
    state[base] = gmul(s0, 14) ^ gmul(s1, 11) ^ gmul(s2, 13) ^ gmul(s3, 9);
    state[base + 1] = gmul(s0, 9) ^ gmul(s1, 14) ^ gmul(s2, 11) ^ gmul(s3, 13);
    state[base + 2] = gmul(s0, 13) ^ gmul(s1, 9) ^ gmul(s2, 14) ^ gmul(s3, 11);
    state[base + 3] = gmul(s0, 11) ^ gmul(s1, 13) ^ gmul(s2, 9) ^ gmul(s3, 14);
  }
}

/** FIPS 197 5.1 Cipher: encrypts exactly one 16-byte block. */
function encryptBlock({ words, roundCount }, input) {
  const state = copyBytes(input);
  addRoundKey(state, words, 0);
  for (let round = 1; round < roundCount; round += 1) {
    subBytes(state, SBOX);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, words, round);
  }
  subBytes(state, SBOX);
  shiftRows(state);
  addRoundKey(state, words, roundCount);
  return state;
}

/** FIPS 197 5.3 InvCipher (the direct, non-equivalent form): decrypts one 16-byte block. */
function decryptBlock({ words, roundCount }, input) {
  const state = copyBytes(input);
  addRoundKey(state, words, roundCount);
  for (let round = roundCount - 1; round >= 1; round -= 1) {
    invShiftRows(state);
    subBytes(state, INV_SBOX);
    addRoundKey(state, words, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  subBytes(state, INV_SBOX);
  addRoundKey(state, words, 0);
  return state;
}

function requireBlockAligned(data, label) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error(`${label}: data length must be a non-zero multiple of 16 bytes`);
}

/** Single-block AES-ECB encrypt/decrypt (no chaining, no padding) -- used for /Perms. */
export function aesEcbBlockEncrypt(key, block) {
  if (block.length !== 16) throw new Error("aesEcbBlockEncrypt: block must be exactly 16 bytes");
  return encryptBlock(expandKey(key), block);
}
export function aesEcbBlockDecrypt(key, block) {
  if (block.length !== 16) throw new Error("aesEcbBlockDecrypt: block must be exactly 16 bytes");
  return decryptBlock(expandKey(key), block);
}

/**
 * AES-CBC encrypt/decrypt with NO padding: `data` must already be a multiple of 16
 * bytes (Algorithm 2.B's repeated-64-times input always is; /UE and /OE are each
 * exactly 32 bytes). Never adds or strips PKCS#7 padding, unlike Web Crypto's
 * AES-CBC -- see this module's own docstring for why that matters here.
 */
export function aesCbcNoPaddingEncrypt(key, iv, data) {
  requireBlockAligned(data, "aesCbcNoPaddingEncrypt");
  const context = expandKey(key);
  const output = new Uint8Array(data.length);
  let previous = iv;
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) block[index] = data[offset + index] ^ previous[index];
    const encrypted = encryptBlock(context, block);
    output.set(encrypted, offset);
    previous = encrypted;
  }
  return output;
}

export function aesCbcNoPaddingDecrypt(key, iv, data) {
  requireBlockAligned(data, "aesCbcNoPaddingDecrypt");
  const context = expandKey(key);
  const output = new Uint8Array(data.length);
  let previous = iv;
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16);
    const decrypted = decryptBlock(context, block);
    for (let index = 0; index < 16; index += 1) output[offset + index] = decrypted[index] ^ previous[index];
    previous = block;
  }
  return output;
}
