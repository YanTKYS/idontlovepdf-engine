import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { md5 } from "../src/security/md5.js";

const encode = (value) => new TextEncoder().encode(value);

test("matches known MD5 test vectors (RFC 1321, appendix A.5)", () => {
  const vectors = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"]
  ];
  for (const [input, expected] of vectors) {
    assert.equal(Buffer.from(md5(encode(input))).toString("hex"), expected, input);
  }
});

test("matches node:crypto's md5 across message lengths spanning multiple 64-byte blocks", () => {
  // RFC 1321's own vectors are all short; this cross-checks the multi-block padding
  // path (messages that do not fit in one 64-byte chunk) against an independent
  // implementation, not just against hand-copied hex constants.
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, 100_000]) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = index % 256;
    const mine = Buffer.from(md5(bytes)).toString("hex");
    const reference = createHash("md5").update(bytes).digest("hex");
    assert.equal(mine, reference, `length ${length}`);
  }
});
