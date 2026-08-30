import assert from "node:assert/strict";
import test from "node:test";

import { decodeWithCMap, encodeWithCMap, parseToUnicodeCMap } from "../src/cmap.js";

const encode = (value) => new TextEncoder().encode(value);
const cmap = (body) => parseToUnicodeCMap(encode(`begincmap\n${body}\nendcmap`));

test("maps bfchar and bfrange entries, including the destination-array form", () => {
  const mappings = cmap([
    "2 beginbfchar",
    "<0001> <65E5>",
    "<0002> <672C>",
    "endbfchar",
    "2 beginbfrange",
    "<0003> <0004> <8A9E>",
    "<0010> <0011> [<0041> <0042>]",
    "endbfrange"
  ].join("\n"));
  assert.deepEqual([...mappings], [
    ["0001", "日"], ["0002", "本"], ["0003", "語"], ["0004", "誟"], ["0010", "A"], ["0011", "B"]
  ]);
});

test("leaves the tail unmapped when a bfrange destination array is too short", () => {
  // The missing entries must not fall through to the single-destination form: there
  // is no single destination in this syntax, and reading one threw a SyntaxError.
  assert.deepEqual([...cmap("1 beginbfrange\n<0001> <0003> [<0041>]\nendbfrange")], [["0001", "A"]]);
});

test("ignores a bfrange wider than the 2-byte codespace instead of expanding it", () => {
  const started = Date.now();
  assert.equal(cmap("1 beginbfrange\n<00000000> <7fffffff> <0041>\nendbfrange").size, 0);
  assert.ok(Date.now() - started < 1000, "a malformed range must not be walked entry by entry");
  // The widest legitimate range is still mapped in full.
  assert.equal(cmap("1 beginbfrange\n<0000> <ffff> <0041>\nendbfrange").size, 0x10000);
});

test("ignores a reversed bfrange", () => {
  assert.equal(cmap("1 beginbfrange\n<0005> <0001> <0041>\nendbfrange").size, 0);
});

test("marks bytes with no mapping as U+FFFD rather than failing the whole run", () => {
  const mappings = cmap("1 beginbfchar\n<0001> <65E5>\nendbfchar");
  assert.equal(decodeWithCMap(Uint8Array.of(0, 1, 0, 9), mappings), "日��");
  assert.equal(decodeWithCMap(encode("plain"), new Map()), "plain");
});

test("names the character that the existing font cannot encode", () => {
  const mappings = cmap("1 beginbfchar\n<0001> <65E5>\nendbfchar");
  assert.deepEqual([...encodeWithCMap("日", mappings)], [0, 1]);
  assert.throws(() => encodeWithCMap("本", mappings), /has no ToUnicode code for "本"/);
});
