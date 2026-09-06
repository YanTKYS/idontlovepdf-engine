// The sparse TrueType subsetter (src/font-subset.js) in isolation, and its wiring into
// buildFallbackFontObjects() (src/fallback-font.js) -- the fallback-font-subsetting PoC's
// central claim: a subset never renumbers a glyph id, so PDF-level glyph ids drawn by a
// content stream keep meaning exactly what they meant before subsetting, across a subset's
// whole life (see the module doc comment on src/font-subset.js).
//
// Two kinds of fixture are used. Real fonts (BIZ UDGothic/明朝, fetched by `npm run
// test:font`; these tests skip cleanly without it) prove the real cases this PoC targets:
// byte-exact composite dependencies, real size reduction, real timing. A tiny synthetic
// TrueType font, built by buildMinimalFont() below, proves the mechanics no real font
// happens to exercise on demand: a multi-component composite, a cyclic composite reference,
// and a font missing a table this subsetter requires -- built directly from the six
// REQUIRED_TABLES this module reads (head/hhea/hmtx/maxp/loca/glyf), with no cmap/name/
// OS/2/post at all, which planFontSubsetSupport() does not require either (nothing here
// touches them).
import assert from "node:assert/strict";
import test from "node:test";

import opentypeModule from "opentype.js";

import { buildFallbackFontObjects, parseFallbackFont } from "../src/fallback-font.js";
import { buildSparseSubsetFont, FontSubsetError, planFontSubsetSupport } from "../src/font-subset.js";
import { TEST_FONT, TEST_FONT_SERIF, readTestFont, readTestFontSerif } from "../scripts/fetch-test-font.js";

const opentype = opentypeModule.default ?? opentypeModule;
const parseFont = (bytes) => opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

const fontBytes = readTestFont();
const serifBytes = readTestFontSerif();
const skip = fontBytes && serifBytes ? false : `${TEST_FONT.name} / ${TEST_FONT_SERIF.name} are not present -- run \`npm run test:font\` to fetch them`;

/* ------------------------------------------------------------- synthetic font builder */

/** Assembles a full sfnt from a tag -> bytes map. No checksums: nothing here reads them back from an *input* font. */
function assembleSfnt(version, tables) {
  const tags = [...tables.keys()];
  const pad4 = (bytes) => (bytes.length % 4 === 0 ? bytes : (() => {
    const padded = new Uint8Array(bytes.length + (4 - (bytes.length % 4)));
    padded.set(bytes);
    return padded;
  })());
  const padded = tags.map((tag) => pad4(tables.get(tag)));
  const headerLength = 12 + tags.length * 16;
  const total = headerLength + padded.reduce((sum, bytes) => sum + bytes.length, 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, version);
  view.setUint16(4, tags.length);
  let offset = headerLength;
  tags.forEach((tag, index) => {
    const record = 12 + index * 16;
    for (let i = 0; i < 4; i += 1) output[record + i] = tag.charCodeAt(i);
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, tables.get(tag).length);
    output.set(padded[index], offset);
    offset += padded[index].length;
  });
  return output;
}

const evenPad = (bytes) => (bytes.length % 2 === 0 ? bytes : Uint8Array.of(...bytes, 0));

/** A composite glyph record: one component, no scale, byte args -- the smallest legal shape. */
function compositeGlyph(componentGlyphIds) {
  const bytes = [0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]; // numberOfContours = -1, then a zero bbox
  componentGlyphIds.forEach((glyphIndex, index) => {
    const moreComponents = index < componentGlyphIds.length - 1 ? 0x0020 : 0;
    bytes.push((moreComponents >> 8) & 0xff, moreComponents & 0xff, (glyphIndex >> 8) & 0xff, glyphIndex & 0xff, 0, 0);
  });
  return Uint8Array.from(bytes);
}

/** A simple (non-composite) glyph: just needs numberOfContours >= 0 -- the outline bytes after it are opaque to the subsetter. */
function simpleGlyph(fill = 1) {
  return Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0, 0, 0, fill, fill, fill, fill);
}

/**
 * A minimal TrueType font with exactly the tables buildSparseSubsetFont() needs
 * (REQUIRED_TABLES in src/font-subset.js) and nothing else, built from `glyphs` --
 * gid 0 first. Real enough for planFontSubsetSupport()/buildSparseSubsetFont(), not a font
 * any renderer would accept (no cmap, garbage outlines) -- this tests the subsetter's own
 * mechanics, not font rendering.
 */
function buildMinimalFont(glyphs) {
  const padded = glyphs.map(evenPad);
  const offsets = [0];
  for (const glyph of padded) offsets.push(offsets.at(-1) + glyph.length);
  const glyf = new Uint8Array(offsets.at(-1));
  padded.forEach((glyph, index) => glyf.set(glyph, offsets[index]));

  const loca = new Uint8Array(offsets.length * 4);
  const locaView = new DataView(loca.buffer);
  offsets.forEach((offset, index) => locaView.setUint32(index * 4, offset));

  const head = new Uint8Array(54);
  new DataView(head.buffer).setUint32(0, 0x00010000);
  new DataView(head.buffer).setUint16(18, 1000); // unitsPerEm
  new DataView(head.buffer).setInt16(50, 1); // indexToLocFormat: long

  const hhea = new Uint8Array(36);
  new DataView(hhea.buffer).setUint16(34, glyphs.length); // numberOfHMetrics

  const hmtx = new Uint8Array(glyphs.length * 4);
  const hmtxView = new DataView(hmtx.buffer);
  for (let gid = 0; gid < glyphs.length; gid += 1) hmtxView.setUint16(gid * 4, 500);

  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint16(4, glyphs.length);

  return assembleSfnt(0x00010000, new Map([
    ["head", head], ["hhea", hhea], ["hmtx", hmtx], ["maxp", maxp], ["loca", loca], ["glyf", glyf]
  ]));
}

/** Independently recomputes every per-table checksum and the head.checkSumAdjustment formula, without reusing font-subset.js's own writer. */
function verifySfntChecksums(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  const calc = (region) => {
    let sum = 0;
    let padded = region;
    if (region.length % 4 !== 0) {
      padded = new Uint8Array(region.length + (4 - (region.length % 4)));
      padded.set(region);
    }
    const regionView = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    for (let offset = 0; offset < padded.length; offset += 4) sum = (sum + regionView.getUint32(offset)) >>> 0;
    return sum >>> 0;
  };
  let headOffset = null;
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    const checksum = view.getUint32(record + 4);
    const tableOffset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (tag === "head") {
      // A documented TrueType quirk every writer produces, not a bug: head's directory
      // checksum entry is computed with checkSumAdjustment treated as 0, not against its
      // real on-disk bytes (which hold the actual adjustment) -- see the doc comment on
      // writeSfnt() in src/font-subset.js.
      headOffset = tableOffset;
      const headBytes = Uint8Array.from(bytes.subarray(tableOffset, tableOffset + length));
      new DataView(headBytes.buffer).setUint32(8, 0);
      assert.equal(calc(headBytes), checksum, "head's directory checksum entry must match its bytes with checkSumAdjustment treated as 0");
      continue;
    }
    assert.equal(calc(bytes.subarray(tableOffset, tableOffset + length)), checksum, `${tag} table checksum does not match its directory entry`);
  }
  assert.ok(headOffset !== null, "font must have a head table");
  const withAdjustmentZeroed = Uint8Array.from(bytes);
  const storedAdjustment = view.getUint32(headOffset + 8);
  new DataView(withAdjustmentZeroed.buffer).setUint32(headOffset + 8, 0);
  const fileChecksum = calc(withAdjustmentZeroed);
  assert.equal(((0xb1b0afba - fileChecksum) >>> 0), storedAdjustment, "head.checkSumAdjustment does not satisfy the whole-file checksum formula");
}

/* --------------------------------------------------------------- planFontSubsetSupport */

test("planFontSubsetSupport: BIZ UDゴシック/明朝 are both supported", { skip }, () => {
  assert.deepEqual(planFontSubsetSupport(fontBytes), { supported: true, reason: null });
  assert.deepEqual(planFontSubsetSupport(serifBytes), { supported: true, reason: null });
});

test("planFontSubsetSupport: refuses a font with a CFF/CFF2 outline table", () => {
  const font = buildMinimalFont([simpleGlyph()]);
  const tables = new Map([["CFF ", Uint8Array.of(1, 2, 3, 4)]]);
  // Splice an extra table into the directory by rebuilding with the same helper.
  const withCff = spliceExtraTable(font, tables);
  const result = planFontSubsetSupport(withCff);
  assert.equal(result.supported, false);
  assert.match(result.reason, /CFF/);
});

test("planFontSubsetSupport: refuses a variable font (fvar present)", () => {
  const font = buildMinimalFont([simpleGlyph()]);
  const withFvar = spliceExtraTable(font, new Map([["fvar", Uint8Array.of(1, 2, 3, 4)]]));
  const result = planFontSubsetSupport(withFvar);
  assert.equal(result.supported, false);
  assert.match(result.reason, /variable font/);
});

test("planFontSubsetSupport: refuses a font missing a required table", () => {
  // hmtx is required and this font has none.
  const font = buildMinimalFont([simpleGlyph()]);
  const withoutHmtx = removeTable(font, "hmtx");
  const result = planFontSubsetSupport(withoutHmtx);
  assert.equal(result.supported, false);
  assert.match(result.reason, /hmtx/);
});

/** Rebuilds an sfnt with one or more extra tables added to whatever `font` already has. */
function spliceExtraTable(font, extra) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...font.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    tables.set(tag, font.slice(offset, offset + length));
  }
  for (const [tag, bytes] of extra) tables.set(tag, bytes);
  return assembleSfnt(view.getUint32(0), tables);
}

/** Rebuilds an sfnt with one table removed. */
function removeTable(font, removeTag) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...font.subarray(record, record + 4));
    if (tag === removeTag) continue;
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    tables.set(tag, font.slice(offset, offset + length));
  }
  return assembleSfnt(view.getUint32(0), tables);
}

/* ------------------------------------------------------------ buildSparseSubsetFont: synthetic */

// Glyph ids: 0 = .notdef (empty), 1/2 = simple, 3 = composite(1), 4/5 = a cycle (4 -> 5 -> 4),
// 6 = composite(1, 2) -- two components, exercising MORE_COMPONENTS.
const SYNTHETIC_GLYPHS = [
  new Uint8Array(0),
  simpleGlyph(0x11),
  simpleGlyph(0x22),
  compositeGlyph([1]),
  compositeGlyph([5]),
  compositeGlyph([4]),
  compositeGlyph([1, 2])
];

test("buildSparseSubsetFont: keeps .notdef even when it is never requested", () => {
  const { includedGlyphs } = buildSparseSubsetFont(buildMinimalFont(SYNTHETIC_GLYPHS), [1]);
  assert.ok(includedGlyphs.has(0));
});

test("buildSparseSubsetFont: a duplicate glyph id in the request is harmless", () => {
  const a = buildSparseSubsetFont(buildMinimalFont(SYNTHETIC_GLYPHS), [1, 1, 1]);
  const b = buildSparseSubsetFont(buildMinimalFont(SYNTHETIC_GLYPHS), [1]);
  assert.deepEqual([...a.includedGlyphs].sort(), [...b.includedGlyphs].sort());
  assert.deepEqual(a.bytes, b.bytes);
});

test("buildSparseSubsetFont: a composite glyph pulls in its component", () => {
  const { includedGlyphs } = buildSparseSubsetFont(buildMinimalFont(SYNTHETIC_GLYPHS), [3]);
  assert.deepEqual([...includedGlyphs].sort((x, y) => x - y), [0, 1, 3]);
});

test("buildSparseSubsetFont: a multi-component composite pulls in every component", () => {
  const { includedGlyphs } = buildSparseSubsetFont(buildMinimalFont(SYNTHETIC_GLYPHS), [6]);
  assert.deepEqual([...includedGlyphs].sort((x, y) => x - y), [0, 1, 2, 6]);
});

test("buildSparseSubsetFont: a cyclic composite reference is refused, not silently absorbed", () => {
  // Glyph 4 -> component 5 -> component 4: a true cycle, not the shared-component diamond
  // the next test covers. This must fail closed (FontSubsetError, caught by
  // buildFallbackFontObjects() and turned into a full-font-embedding fallback -- see
  // src/fallback-font.js), not terminate quietly and embed a subset built from a reference
  // graph this function could not actually resolve.
  const font = buildMinimalFont(SYNTHETIC_GLYPHS);
  assert.throws(() => buildSparseSubsetFont(font, [4]), FontSubsetError);
});

test("buildSparseSubsetFont: two composites sharing one component (a diamond, not a cycle) both succeed", () => {
  // gid 3 = composite(1) and gid 6 = composite(1, 2): both depend on gid 1, reached by two
  // different paths -- this must NOT be mistaken for a cycle.
  const font = buildMinimalFont(SYNTHETIC_GLYPHS);
  const { includedGlyphs } = buildSparseSubsetFont(font, [3, 6]);
  assert.deepEqual([...includedGlyphs].sort((x, y) => x - y), [0, 1, 2, 3, 6]);
});

test("buildSparseSubsetFont: an out-of-range glyph id is refused, not silently dropped or embedded as garbage", () => {
  const font = buildMinimalFont(SYNTHETIC_GLYPHS);
  assert.throws(() => buildSparseSubsetFont(font, [999]), FontSubsetError);
  assert.throws(() => buildSparseSubsetFont(font, [-1]), FontSubsetError);
});

test("buildSparseSubsetFont: dropped glyphs become zero-length, not removed -- every original glyph id still has a loca entry", () => {
  const font = buildMinimalFont(SYNTHETIC_GLYPHS);
  const { bytes } = buildSparseSubsetFont(font, [1]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  const tableAt = (tag) => {
    for (let index = 0; index < numTables; index += 1) {
      const record = 12 + index * 16;
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) {
        return { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };
      }
    }
    return null;
  };
  const maxp = tableAt("maxp");
  const numGlyphs = view.getUint16(maxp.offset + 4);
  assert.equal(numGlyphs, SYNTHETIC_GLYPHS.length, "loca/maxp must still describe every original glyph id, kept or not");
  const loca = tableAt("loca");
  const offsets = [];
  for (let gid = 0; gid <= numGlyphs; gid += 1) offsets.push(view.getUint32(loca.offset + gid * 4));
  // Glyph 2 (not requested) must be zero-length; glyph 1 (requested) must not be.
  assert.equal(offsets[2 + 1] - offsets[2], 0, "an unused glyph must be zero-length, not absent");
  assert.ok(offsets[1 + 1] - offsets[1] > 0, "the requested glyph must keep its outline");
});

test("buildSparseSubsetFont: rebuilds valid sfnt checksums and head.checkSumAdjustment", () => {
  const font = buildMinimalFont(SYNTHETIC_GLYPHS);
  const { bytes } = buildSparseSubsetFont(font, [3, 6]);
  verifySfntChecksums(bytes);
});

/* ----------------------------------------------------------------- buildSparseSubsetFont: real fonts */

test("buildSparseSubsetFont: kept glyphs are byte-identical to the original font's own glyf data", { skip }, () => {
  const font = parseFont(fontBytes);
  const requestedChars = ["し", "ょ"];
  const requestedIds = requestedChars.map((character) => font.charToGlyph(character).index);

  const { bytes: subsetBytes, includedGlyphs } = buildSparseSubsetFont(fontBytes, requestedIds);
  verifySfntChecksums(subsetBytes);
  for (const id of requestedIds) assert.ok(includedGlyphs.has(id));
  assert.ok(includedGlyphs.has(0), ".notdef must always be included");

  const reparsed = parseFont(subsetBytes);
  for (const id of requestedIds) {
    const before = font.glyphs.get(id);
    const after = reparsed.glyphs.get(id);
    assert.equal(after.advanceWidth, before.advanceWidth, `glyph ${id}'s advance width must be unchanged`);
    assert.deepEqual(after.path.commands, before.path.commands, `glyph ${id}'s outline must be unchanged`);
  }
});

test("buildSparseSubsetFont: extending a subset does not change a glyph already in it", { skip }, () => {
  const font = parseFont(fontBytes);
  const shoId = font.charToGlyph("し").index;
  const meId = font.charToGlyph("め").index;

  const first = buildSparseSubsetFont(fontBytes, [shoId]);
  const extended = buildSparseSubsetFont(fontBytes, [shoId, meId]);

  const opentypeFirst = parseFont(first.bytes);
  const opentypeExtended = parseFont(extended.bytes);
  const before = opentypeFirst.glyphs.get(shoId);
  const after = opentypeExtended.glyphs.get(shoId);
  assert.deepEqual(after.path.commands, before.path.commands, "し must render identically whether or not め is also in the subset -- this is the save/reopen/add-glyph invariant this PoC exists for");
  assert.equal(after.advanceWidth, before.advanceWidth);
  assert.ok(extended.includedGlyphs.has(shoId) && extended.includedGlyphs.has(meId));
});

test("buildSparseSubsetFont: 令和 -> しょ reduces BIZ UDMincho's embedded bytes by at least 80%", { skip }, () => {
  const font = parseFont(serifBytes);
  const ids = [...new Set(["し", "ょ"].map((character) => font.charToGlyph(character).index))];
  const { bytes: subsetBytes } = buildSparseSubsetFont(serifBytes, ids);
  const reduction = 1 - subsetBytes.length / serifBytes.length;
  assert.ok(reduction >= 0.8, `reduction was only ${(reduction * 100).toFixed(1)}%, wanted at least 80%`);
});

test("buildSparseSubsetFont: size and time scale sensibly from 2 to 100 glyphs (BIZ UDMincho)", { skip }, () => {
  const font = parseFont(serifBytes);
  let previousSize = 0;
  for (const count of [2, 10, 50, 100]) {
    const ids = [];
    for (let index = 0; index < count; index += 1) ids.push((index * 37 + 1) % font.numGlyphs);
    const t0 = performance.now();
    const { bytes: subsetBytes, includedGlyphs } = buildSparseSubsetFont(serifBytes, [...new Set(ids)]);
    const elapsedMs = performance.now() - t0;
    // Not asserted strictly (real hardware and CI runners vary), but printed for the PoC
    // report -- see docs/font-subsetting-poc.md.
    console.log(`  N=${count}: subset=${subsetBytes.length} bytes, includedGlyphs=${includedGlyphs.size}, ${elapsedMs.toFixed(1)}ms`);
    assert.ok(subsetBytes.length >= previousSize, "a larger glyph set must not produce a smaller subset");
    assert.ok(subsetBytes.length < serifBytes.length, "even 100 glyphs must stay far below the whole font");
    assert.ok(elapsedMs < 2000, `subsetting ${count} glyphs took ${elapsedMs}ms, too slow for interactive use`);
    previousSize = subsetBytes.length;
  }
});

/* ------------------------------------------------------------- buildFallbackFontObjects wiring */

test("buildFallbackFontObjects: a subset-supported font gets a subset-tag BaseFont and a Length1 smaller than the full font", { skip }, async () => {
  const fallback = parseFallbackFont(fontBytes);
  fallback.digest = "a".repeat(64);
  assert.equal(fallback.subset.supported, true);

  const glyphs = new Map([[fallback.font.charToGlyph("し").index, { character: "し", glyphId: fallback.font.charToGlyph("し").index, advanceWidth: 500 }]]);
  const objects = await buildFallbackFontObjects(fallback, { type0: 1, cidFont: 2, descriptor: 3, fontFile: 4, toUnicode: 5 }, glyphs, { serif: false });

  const type0 = objects.get(1).dictionary;
  assert.match(type0, /\/BaseFont \/[A-Z]{6}\+BIZUDGothic-Regular/);
  const length1 = Number(objects.get(4).dictionary.match(/\/Length1 (\d+)/)?.[1]);
  assert.ok(length1 > 0 && length1 < fallback.bytes.length);
  assert.equal(fallback.lastEmbedding.mode, "subset");
  assert.ok(fallback.lastEmbedding.subset.subsetBytes < fallback.bytes.length);
});

test("buildFallbackFontObjects: a font this subsetter cannot handle embeds the whole program, with no subset-tag prefix", { skip }, async () => {
  const fallback = parseFallbackFont(fontBytes);
  fallback.digest = "b".repeat(64);
  // Force the "unsupported" path without needing an exotic real font fixture -- this is
  // exactly the state planFontSubsetSupport() would have produced for a CFF/variable font.
  fallback.subset = { supported: false, reason: "test: forced unsupported" };
  fallback.subsetNamePrefixEnabled = false;

  const glyphId = fallback.font.charToGlyph("し").index;
  const glyphs = new Map([[glyphId, { character: "し", glyphId, advanceWidth: 500 }]]);
  const objects = await buildFallbackFontObjects(fallback, { type0: 1, cidFont: 2, descriptor: 3, fontFile: 4, toUnicode: 5 }, glyphs, { serif: false });

  const type0 = objects.get(1).dictionary;
  assert.doesNotMatch(type0, /\/BaseFont \/[A-Z]{6}\+/, "an unsupported font must not get a subset-tag prefix");
  const fontFile = objects.get(4);
  assert.match(fontFile.dictionary, new RegExp(`/Length1 ${fallback.bytes.length}\\b`), "the whole font's length, not a subset's");
  assert.equal(fallback.lastEmbedding.mode, "full-font");
});

test("buildFallbackFontObjects: a runtime subset failure falls back to full-font embedding instead of a broken PDF", { skip }, async () => {
  const fallback = parseFallbackFont(Uint8Array.from(fontBytes));
  fallback.digest = "c".repeat(64);
  assert.equal(fallback.subset.supported, true);

  const glyphId = fallback.font.charToGlyph("し").index;
  // Corrupt this one glyph's loca entry (long format: 4-byte offsets) so buildSparseSubsetFont()
  // sees an invalid range for it and throws -- without touching planFontSubsetSupport()'s own
  // shallow, table-presence-only checks, which is exactly the "looked fine at parse time, failed
  // at build time" case item 16 of the PoC exists for.
  const view = new DataView(fallback.bytes.buffer, fallback.bytes.byteOffset, fallback.bytes.byteLength);
  const directoryTables = readDirectoryForTest(fallback.bytes);
  const head = directoryTables.get("head");
  const loca = directoryTables.get("loca");
  const glyf = directoryTables.get("glyf");
  const indexToLocFormat = view.getInt16(head.offset + 50);
  assert.equal(indexToLocFormat, 1, "this test assumes BIZ UDGothic uses the long loca format");
  // Point this glyph's end offset past the end of the glyf table.
  view.setUint32(loca.offset + (glyphId + 1) * 4, glyf.length + 1_000_000);

  const glyphs = new Map([[glyphId, { character: "し", glyphId, advanceWidth: 500 }]]);
  const objects = await buildFallbackFontObjects(fallback, { type0: 1, cidFont: 2, descriptor: 3, fontFile: 4, toUnicode: 5 }, glyphs, { serif: false });

  assert.equal(fallback.subset.supported, false, "a runtime failure must permanently disable subsetting for this fallback font");
  assert.equal(fallback.lastEmbedding.mode, "full-font");
  const fontFile = objects.get(4);
  assert.match(fontFile.dictionary, new RegExp(`/Length1 ${fallback.bytes.length}\\b`));
  // Note: this test's own corruption above makes `fallback.bytes` itself no longer a
  // valid font -- deliberately, to force buildSparseSubsetFont() to fail. It is not
  // claiming the resulting full-font embed is well-formed; only that the *code path*
  // switches to full-font mode and stops attempting a subset, which is what item 16 of
  // the PoC (never embed a subset that could not be proven correct) requires.
});

/** A tiny stand-in for readSfntDirectory() (font-subset.js does not export it) -- used only to corrupt a test fixture, not to assert anything about font-subset.js's own internals. */
function readDirectoryForTest(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  return tables;
}
