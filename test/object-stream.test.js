import assert from "node:assert/strict";
import test from "node:test";

import { parseObjectStream } from "../src/object-stream.js";

const encode = (value) => new TextEncoder().encode(value);

/** Builds a decoded ObjStm body (header + bodies) from `{ number, body }` pairs. */
function buildDecoded(objects) {
  let cursor = 0;
  const offsets = objects.map((object) => {
    const offset = cursor;
    cursor += encode(object.body).length;
    return offset;
  });
  const header = objects.map((object, index) => `${object.number} ${offsets[index]}`).join("\n") + "\n";
  const bodies = objects.map((object) => object.body).join("");
  return { decoded: encode(header + bodies), firstOffset: encode(header).length };
}

test("parses a single-object object stream", () => {
  const { decoded, firstOffset } = buildDecoded([{ number: 254, body: "<< /Type /Test /X 1 >>" }]);
  const entries = parseObjectStream(decoded, { objectCount: 1, firstOffset });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].objectNumber, 254);
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].offset, 0);
  assert.equal(new TextDecoder().decode(entries[0].bytes), "<< /Type /Test /X 1 >>");
});

test("parses multiple objects, each sliced to exactly its own bytes", () => {
  const objects = [
    { number: 254, body: "<< /Type /A /V 1 >>" },
    { number: 260, body: "[1 2 3]" },
    { number: 271, body: "<< /Type /B /V 2 >>" }
  ];
  const { decoded, firstOffset } = buildDecoded(objects);
  const entries = parseObjectStream(decoded, { objectCount: 3, firstOffset });
  assert.deepEqual(entries.map((entry) => entry.objectNumber), [254, 260, 271]);
  assert.deepEqual(entries.map((entry) => entry.index), [0, 1, 2]);
  entries.forEach((entry, index) => {
    assert.equal(new TextDecoder().decode(entry.bytes), objects[index].body);
  });
  // The last object runs to the exact end of the decoded stream, not beyond.
  assert.equal(entries.at(-1).bytes.length, encode(objects.at(-1).body).length);
});

test("rejects a non-positive or non-integer /N", () => {
  const { decoded, firstOffset } = buildDecoded([{ number: 1, body: "<< >>" }]);
  for (const objectCount of [-1, 0, NaN, 1.5, "3"]) {
    assert.throws(() => parseObjectStream(decoded, { objectCount, firstOffset }), /Malformed object stream \/N/, String(objectCount));
  }
});

test("rejects a negative, non-integer, or out-of-range /First", () => {
  const { decoded } = buildDecoded([{ number: 1, body: "<< >>" }]);
  for (const firstOffset of [-1, NaN, 1.5]) {
    assert.throws(() => parseObjectStream(decoded, { objectCount: 1, firstOffset }), /Malformed object stream \/First/, String(firstOffset));
  }
  assert.throws(
    () => parseObjectStream(decoded, { objectCount: 1, firstOffset: decoded.length + 1 }),
    /Malformed object stream \/First/
  );
});

test("rejects a header with fewer pairs than /N declares", () => {
  const { decoded, firstOffset } = buildDecoded([
    { number: 254, body: "<< /A 1 >>" },
    { number: 260, body: "<< /B 2 >>" }
  ]);
  // /N says 3, but only 2 pairs actually exist before /First.
  assert.throws(() => parseObjectStream(decoded, { objectCount: 3, firstOffset }), /Object stream header is incomplete/);
});

test("rejects /First landing in the middle of a header entry", () => {
  const { decoded, firstOffset } = buildDecoded([
    { number: 254, body: "<< /A 1 >>" },
    { number: 260, body: "<< /B 2 >>" }
  ]);
  assert.throws(() => parseObjectStream(decoded, { objectCount: 2, firstOffset: firstOffset - 2 }), /Object stream header is incomplete/);
});

test("rejects descending or duplicate header offsets", () => {
  const header = "254 10\n260 5\n271 20\n";
  const bodyLength = 30;
  const decoded = encode(header + "x".repeat(bodyLength));
  assert.throws(
    () => parseObjectStream(decoded, { objectCount: 3, firstOffset: encode(header).length }),
    /Object stream body offset is invalid/,
    "descending"
  );

  const dupHeader = "254 5\n260 5\n271 20\n";
  const dupDecoded = encode(dupHeader + "x".repeat(bodyLength));
  assert.throws(
    () => parseObjectStream(dupDecoded, { objectCount: 3, firstOffset: encode(dupHeader).length }),
    /Object stream body offset is invalid/,
    "duplicate"
  );
});

test("rejects an offset that reaches beyond the decoded stream", () => {
  const header = "254 0\n260 1000\n";
  const decoded = encode(header + "short body");
  assert.throws(
    () => parseObjectStream(decoded, { objectCount: 2, firstOffset: encode(header).length }),
    /Object stream body offset is invalid/
  );
});

test("accepts a non-zero first offset for the first object (offsets need not start at 0)", () => {
  // The spec only requires the pairs to be ascending and in range, not that the
  // first one is exactly 0 -- a writer could legally reserve leading padding.
  const header = "254 4\n260 14\n";
  const bodies = "PAD1<< /A 1 >>[1 2 3]";
  const decoded = encode(header + bodies);
  const entries = parseObjectStream(decoded, { objectCount: 2, firstOffset: encode(header).length });
  assert.equal(new TextDecoder().decode(entries[0].bytes), "<< /A 1 >>");
  assert.equal(new TextDecoder().decode(entries[1].bytes), "[1 2 3]");
});
