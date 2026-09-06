/**
 * A minimal TrueType (`glyf`-outline) subsetter, purpose-built for one thing: shrinking a
 * fallback font's `/FontFile2` embedding down to the glyphs actually drawn, without ever
 * renumbering a glyph id.
 *
 * That constraint is the whole point. A fallback replacement writes glyph ids straight into
 * the content stream (Identity-H, `/CIDToGIDMap /Identity` -- see fallback-font.js), and a
 * document is edited, saved, reopened, and edited again: the glyph ids a first save wrote
 * must still mean the same glyphs after a second save adds more. A subsetter that
 * renumbers glyphs (which is what most general-purpose subsetting tools do, since it lets
 * them drop the unused slots in every per-glyph table) would have to prove a stable
 * renumbering survives that round trip, and re-derive it correctly every time a session
 * reopens a document it did not create the subset in. This does not renumber: every table
 * except `glyf`/`loca` is copied byte for byte, `loca` keeps one entry per original glyph
 * id, and an unused glyph's outline is simply zero bytes long. The saving comes almost
 * entirely from `glyf` -- for BIZ UD明朝, it is over 93% of the font's bytes, because it
 * holds the outline of every one of ~14,000 CJK glyphs the document will in practice use a
 * handful of.
 *
 * `cmap`, `hmtx`, `post`, `name`, `OS/2`, and every other table are left exactly as they
 * were: nothing here depends on them, and shrinking them would only add risk (a reader that
 * expects `hmtx` to have one entry per `maxp.numGlyphs`, say) for a small further saving.
 * `glyf`-outline TrueType only: CFF/CFF2 outlines, and variable fonts (an `fvar` table),
 * are refused rather than guessed at -- see planFontSubsetSupport().
 */

export class FontSubsetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Reads a big-endian sfnt table directory, without interpreting any table's contents. */
function readSfntDirectory(bytes) {
  if (bytes.length < 12) throw new FontSubsetError("FONT_SUBSET_INVALID", "Font is too short to hold an sfnt header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  const numTables = view.getUint16(4);
  const tables = new Map();
  const order = [];
  let offset = 12;
  for (let index = 0; index < numTables; index += 1) {
    if (offset + 16 > bytes.length) throw new FontSubsetError("FONT_SUBSET_INVALID", "Truncated sfnt table directory");
    const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const tableOffset = view.getUint32(offset + 8);
    const length = view.getUint32(offset + 12);
    if (tableOffset + length > bytes.length) throw new FontSubsetError("FONT_SUBSET_INVALID", `Table "${tag}" extends past the end of the font`);
    tables.set(tag, { offset: tableOffset, length });
    order.push(tag);
    offset += 16;
  }
  return { version, tables, order };
}

const REQUIRED_TABLES = ["glyf", "loca", "head", "hhea", "hmtx", "maxp"];

/**
 * Whether `bytes` (already known, by parseFallbackFont(), to be TrueType-outline per
 * opentype.js) can safely go through buildSparseSubsetFont() -- and if not, why. Checked
 * once per font, at the same time it is parsed, so a font this subsetter cannot handle
 * falls back to full-font embedding consistently for the whole session rather than
 * sometimes succeeding and sometimes not depending on which glyphs a particular edit needs.
 *
 * Deliberately narrow: this is not a general OpenType subsetter, only enough of one to
 * subset BIZ UDゴシック/明朝 and fonts shaped like them (see the module doc comment and
 * docs/font-subsetting-poc.md). A CFF/CFF2 outline, an OpenType Layout table this does not
 * need to touch is fine (GSUB/GPOS are copied through untouched, unused), but a variable
 * font (`fvar`) is refused -- its `gvar`/`avar`/`HVAR` tables are keyed by glyph id exactly
 * like `glyf`, and this subsetter has no code to keep them consistent with a modified
 * `glyf`, so it does not try.
 */
export function planFontSubsetSupport(bytes) {
  let directory;
  try {
    directory = readSfntDirectory(bytes);
  } catch (error) {
    return { supported: false, reason: `font could not be read as sfnt: ${error.message}` };
  }
  if (directory.version !== 0x00010000) {
    return { supported: false, reason: `unsupported sfnt version 0x${directory.version.toString(16)} (expected TrueType 0x00010000)` };
  }
  if (directory.tables.has("CFF ") || directory.tables.has("CFF2")) {
    return { supported: false, reason: "font has CFF/CFF2 outlines, not glyf" };
  }
  if (directory.tables.has("fvar")) {
    return { supported: false, reason: "font is a variable font (has an fvar table)" };
  }
  const missing = REQUIRED_TABLES.filter((tag) => !directory.tables.has(tag));
  if (missing.length) {
    return { supported: false, reason: `font is missing required table(s): ${missing.join(", ")}` };
  }
  const head = directory.tables.get("head");
  if (head.length < 54) return { supported: false, reason: "head table is too short" };
  const maxp = directory.tables.get("maxp");
  if (maxp.length < 6) return { supported: false, reason: "maxp table is too short" };
  return { supported: true, reason: null };
}

/** `head.indexToLocFormat` (0 = short/uint16*2, 1 = long/uint32) and `maxp.numGlyphs`. */
function readGlyphCounts(bytes, directory) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = directory.tables.get("head");
  const maxp = directory.tables.get("maxp");
  const indexToLocFormat = view.getInt16(head.offset + 50);
  const numGlyphs = view.getUint16(maxp.offset + 4);
  if (indexToLocFormat !== 0 && indexToLocFormat !== 1) {
    throw new FontSubsetError("FONT_SUBSET_INVALID", `Unsupported indexToLocFormat ${indexToLocFormat}`);
  }
  return { indexToLocFormat, numGlyphs };
}

/** `loca` as `numGlyphs + 1` byte offsets into `glyf`, whatever the table's on-disk width. */
function readLoca(bytes, directory, indexToLocFormat, numGlyphs) {
  const loca = directory.tables.get("loca");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = numGlyphs + 1;
  const expectedLength = indexToLocFormat === 0 ? entries * 2 : entries * 4;
  if (loca.length < expectedLength) {
    throw new FontSubsetError("FONT_SUBSET_INVALID", `loca table (${loca.length} bytes) is too short for ${numGlyphs} glyphs`);
  }
  const offsets = new Array(entries);
  for (let index = 0; index < entries; index += 1) {
    offsets[index] = indexToLocFormat === 0
      ? view.getUint16(loca.offset + index * 2) * 2
      : view.getUint32(loca.offset + index * 4);
  }
  return offsets;
}

/**
 * The component glyph ids a composite glyph (glyf `numberOfContours < 0`) directly
 * references, by walking the raw component records -- not opentype.js's parsed glyph
 * object, so this has no dependency on how (or whether) a particular opentype.js version
 * exposes composites, and works from exactly the bytes that will be copied into the subset.
 */
function readCompositeComponents(glyfBytes, glyphStart, glyphEnd) {
  const view = new DataView(glyfBytes.buffer, glyfBytes.byteOffset, glyfBytes.byteLength);
  const components = [];
  let offset = glyphStart + 10; // past numberOfContours + 4 bbox int16s
  const ARG_WORDS = 0x0001;
  const HAVE_SCALE = 0x0008;
  const MORE_COMPONENTS = 0x0020;
  const XY_SCALE = 0x0040;
  const TWO_BY_TWO = 0x0080;
  for (;;) {
    if (offset + 4 > glyphEnd) throw new FontSubsetError("FONT_SUBSET_INVALID", "Composite glyph record runs past the end of its glyph");
    const flags = view.getUint16(offset);
    const glyphIndex = view.getUint16(offset + 2);
    components.push(glyphIndex);
    offset += 4;
    offset += (flags & ARG_WORDS) ? 4 : 2;
    if (flags & HAVE_SCALE) offset += 2;
    else if (flags & XY_SCALE) offset += 4;
    else if (flags & TWO_BY_TWO) offset += 8;
    if (!(flags & MORE_COMPONENTS)) break;
  }
  return components;
}

/**
 * Every glyph id `requested` needs to render correctly: the requested ids themselves, glyph
 * 0 (`.notdef` -- required to exist by the TrueType spec, and the glyph a reader falls back
 * to for a code it cannot otherwise resolve), and every component a composite glyph in that
 * set references, expanded recursively (a component can itself be composite).
 *
 * A glyph reached a second time by a *different* path (two composites sharing one
 * component -- a diamond, not a cycle, and common in real fonts) is only ever expanded
 * once. A glyph that is its own ancestor in the *current* path (a true cyclic composite
 * reference: malformed, but real fonts have shipped with exactly this) is not silently
 * absorbed -- it throws, so the caller falls back to full-font embedding rather than
 * embedding a subset built from a reference graph this function could not actually resolve.
 * Tracked with an explicit stack (not the JS call stack) precisely so that distinction --
 * "still being expanded" vs. "already finished" -- has somewhere to live; recursion depth
 * would otherwise be whatever a font's own composite nesting happens to be.
 */
function expandGlyphSet(glyfBytes, offsets, numGlyphs, requested) {
  const view = new DataView(glyfBytes.buffer, glyfBytes.byteOffset, glyfBytes.byteLength);
  const state = new Map(); // gid -> "visiting" (on the current path) | "done" (fully expanded)
  const keep = new Set();

  const componentsOf = (gid) => {
    if (!Number.isInteger(gid) || gid < 0 || gid >= numGlyphs) {
      throw new FontSubsetError("FONT_SUBSET_INVALID", `Glyph id ${gid} is out of range for a font with ${numGlyphs} glyphs`);
    }
    const start = offsets[gid];
    const end = offsets[gid + 1];
    if (end < start || end > glyfBytes.length) {
      throw new FontSubsetError("FONT_SUBSET_INVALID", `Glyph ${gid} has an invalid loca range`);
    }
    if (end === start) return []; // No outline (e.g. space) -- nothing to recurse into.
    return view.getInt16(start) < 0 ? readCompositeComponents(glyfBytes, start, end) : [];
  };

  const visit = (root) => {
    if (state.get(root) === "done") return;
    const stack = [{ gid: root, components: null, index: 0 }];
    state.set(root, "visiting");
    while (stack.length) {
      const frame = stack[stack.length - 1];
      frame.components ??= componentsOf(frame.gid);
      if (frame.index < frame.components.length) {
        const child = frame.components[frame.index];
        frame.index += 1;
        const childState = state.get(child);
        if (childState === "visiting") {
          throw new FontSubsetError("FONT_SUBSET_INVALID", `Glyph ${child} is part of a cyclic composite reference (reached again from glyph ${frame.gid})`);
        }
        if (childState !== "done") {
          state.set(child, "visiting");
          stack.push({ gid: child, components: null, index: 0 });
        }
        continue;
      }
      state.set(frame.gid, "done");
      keep.add(frame.gid);
      stack.pop();
    }
  };

  for (const gid of requested) visit(gid);
  visit(0);
  return keep;
}

/** Sum of every big-endian 32-bit word in `bytes`, wrapped to an unsigned 32-bit integer -- the sfnt table checksum algorithm. */
function calcChecksum(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    sum = (sum + view.getUint32(offset)) >>> 0;
  }
  return sum >>> 0;
}

const pad4 = (bytes) => {
  const remainder = bytes.length % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (4 - remainder));
  padded.set(bytes);
  return padded;
};

/**
 * Assembles a full sfnt binary from a tag -> bytes map, with every table offset, length,
 * per-table checksum, and `head.checkSumAdjustment` computed fresh.
 *
 * `head`'s own `checkSumAdjustment` field is zeroed by the caller before it ever reaches
 * this function (see buildSparseSubsetFont()), so every table -- `head` included -- is
 * checksummed and laid out in one pass, from bytes that do not change afterward. Only once
 * that whole (adjustment-still-zero) file exists is its checksum taken and turned into the
 * real adjustment value, which is then patched into `head`'s bytes in place. Its directory
 * checksum entry is deliberately left as computed in the first pass -- i.e. as if
 * `checkSumAdjustment` were still 0 -- rather than recomputed against the patched bytes:
 * recomputing it would change bytes the whole-file checksum was already taken over,
 * breaking the very relationship `checkSumAdjustment` exists to establish (that summing the
 * finished file, adjustment field included, yields the fixed constant 0xB1B0AFBA). This
 * mismatch between `head`'s recorded and actual table checksum is not a bug -- every
 * TrueType writer produces it, and it is why `head` is documented as the one table whose
 * own checksum does not have to verify.
 */
function writeSfnt(version, tables) {
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector += 1;
  }
  searchRange *= 16;
  const rangeShift = numTables * 16 - searchRange;

  const headerLength = 12 + numTables * 16;
  const padded = tags.map((tag) => pad4(tables.get(tag)));
  const totalLength = headerLength + padded.reduce((sum, bytes) => sum + bytes.length, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);

  view.setUint32(0, version);
  view.setUint16(4, numTables);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, rangeShift);

  let dataOffset = headerLength;
  const directoryOffsetOf = new Map();
  tags.forEach((tag, index) => {
    const record = 12 + index * 16;
    directoryOffsetOf.set(tag, record);
    const bytes = padded[index];
    for (let i = 0; i < 4; i += 1) output[record + i] = tag.charCodeAt(i);
    view.setUint32(record + 4, calcChecksum(bytes));
    view.setUint32(record + 8, dataOffset);
    view.setUint32(record + 12, tables.get(tag).length);
    output.set(bytes, dataOffset);
    dataOffset += bytes.length;
  });

  if (tables.has("head")) {
    // `output` already has head.checkSumAdjustment == 0 here (the caller zeroed it before
    // ever passing `tables` in -- see buildSparseSubsetFont()), and head's directory
    // checksum entry, written by the loop above like every other table's, was computed
    // from exactly that. Only the whole-file checksum -- and the byte this patches -- is
    // computed here; the directory entry is intentionally left alone (see the function's
    // doc comment).
    const headTableOffset = view.getUint32(directoryOffsetOf.get("head") + 8);
    const fileChecksum = calcChecksum(output);
    const adjustment = (0xb1b0afba - fileChecksum) >>> 0;
    view.setUint32(headTableOffset + 8, adjustment);
  }

  return output;
}

/**
 * Builds a subset of `bytes` (already confirmed by planFontSubsetSupport()) that keeps
 * exactly the glyphs in `requestedGlyphIds`, every glyph they reach as a composite
 * component, and glyph 0 -- with every glyph id unchanged. Every table but `glyf`/`loca` is
 * copied through unmodified; `glyf` shrinks to the kept glyphs' own outline bytes (an
 * unused glyph becomes zero-length, not removed -- `loca` keeps one entry per original
 * glyph id, in original order, so glyph ids drawn by a content stream still mean exactly
 * the glyph they meant before subsetting: see the module doc comment for why that has to be
 * true across save/reopen/re-edit). `DSIG`, if present, is dropped: a digital signature over
 * bytes this rewrites can only be invalid, and it is optional either way.
 *
 * Throws `FontSubsetError` for anything that would make a correct subset impossible
 * (malformed table, out-of-range glyph id, cyclic/overrunning composite) -- callers must
 * treat that as "fall back to full-font embedding", never as "embed whatever this
 * produced" (see docs/font-subsetting-poc.md and pdf-document.js).
 */
export function buildSparseSubsetFont(bytes, requestedGlyphIds) {
  const directory = readSfntDirectory(bytes);
  const { indexToLocFormat, numGlyphs } = readGlyphCounts(bytes, directory);
  const glyfTable = directory.tables.get("glyf");
  const glyfBytes = bytes.subarray(glyfTable.offset, glyfTable.offset + glyfTable.length);
  const offsets = readLoca(bytes, directory, indexToLocFormat, numGlyphs);

  const keep = expandGlyphSet(glyfBytes, offsets, numGlyphs, requestedGlyphIds);

  const glyfChunks = [];
  const newOffsets = new Array(numGlyphs + 1);
  let running = 0;
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    newOffsets[gid] = running;
    if (keep.has(gid)) {
      const start = offsets[gid];
      const end = offsets[gid + 1];
      if (end > start) {
        const glyph = pad4Even(glyfBytes.subarray(start, end));
        glyfChunks.push(glyph);
        running += glyph.length;
      }
    }
  }
  newOffsets[numGlyphs] = running;
  const newGlyf = new Uint8Array(running);
  let writeOffset = 0;
  for (const chunk of glyfChunks) {
    newGlyf.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  const maxOffset = newOffsets[numGlyphs];
  // The original font's own loca format is kept: a short-format font could in principle
  // need to grow past what uint16*2 can address if it were being *added* to, but a subset
  // only ever removes bytes, so the original format always still fits.
  const newLoca = indexToLocFormat === 0 ? new Uint8Array((numGlyphs + 1) * 2) : new Uint8Array((numGlyphs + 1) * 4);
  const locaView = new DataView(newLoca.buffer);
  for (let index = 0; index <= numGlyphs; index += 1) {
    if (indexToLocFormat === 0) locaView.setUint16(index * 2, newOffsets[index] / 2);
    else locaView.setUint32(index * 4, newOffsets[index]);
  }
  if (indexToLocFormat === 0 && maxOffset % 2 !== 0) {
    throw new FontSubsetError("FONT_SUBSET_INVALID", "Rebuilt glyf table is not evenly aligned for a short-format loca table");
  }

  const tables = new Map();
  for (const tag of directory.order) {
    if (tag === "DSIG") continue; // No longer valid once the font's bytes change; optional.
    if (tag === "glyf") { tables.set(tag, newGlyf); continue; }
    if (tag === "loca") { tables.set(tag, newLoca); continue; }
    const table = directory.tables.get(tag);
    const tableBytes = bytes.slice(table.offset, table.offset + table.length);
    if (tag === "head") {
      // Zeroed here, before writeSfnt() ever sees it, so head is checksummed like every
      // other table in one pass -- see the doc comment on writeSfnt() for why patching it
      // in afterward (as the source font's own value was) is not an option.
      new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength).setUint32(8, 0);
    }
    tables.set(tag, tableBytes);
  }

  return { bytes: writeSfnt(directory.version, tables), includedGlyphs: keep };
}

/** Pads a glyph's raw bytes to an even length -- `loca` offsets must stay even either way (short format halves them; long format gains nothing but costs nothing either). */
function pad4Even(bytes) {
  if (bytes.length % 2 === 0) return bytes;
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  return padded;
}
