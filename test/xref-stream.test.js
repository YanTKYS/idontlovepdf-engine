import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { PdfTextEditor } from "../src/index.js";

const encode = (value) => new TextEncoder().encode(value);
const latin1 = new TextDecoder("latin1");

function bigEndian(value, width) {
  const bytes = [];
  for (let index = width - 1; index >= 0; index -= 1) bytes.push((value >>> (index * 8)) & 0xff);
  return bytes;
}

function concatChunks(chunks) {
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

/** Places a run of `N 0 obj` bodies one after another, tracking each one's byte offset. */
function placeObjects(headerChunks, headerLength, objects) {
  const chunks = [...headerChunks];
  const offsets = new Map();
  let pos = headerLength;
  for (const object of objects) {
    offsets.set(object.number, pos);
    let piece;
    if (object.streamBytes) {
      const extra = object.dictionary ? `${object.dictionary} ` : "";
      piece = encode(`${object.number} 0 obj\n<< ${extra}/Length ${object.streamBytes.length} >>\nstream\n`);
      chunks.push(piece); pos += piece.length;
      chunks.push(object.streamBytes); pos += object.streamBytes.length;
      piece = encode("\nendstream\nendobj\n");
      chunks.push(piece); pos += piece.length;
    } else {
      piece = encode(`${object.number} 0 obj\n${object.dictionary}\nendobj\n`);
      chunks.push(piece); pos += piece.length;
    }
  }
  return { chunks, pos, offsets };
}

/**
 * Appends one cross-reference stream object (its own entries supplied explicitly, as
 * `{ number, type, field2, field3 }` rows) plus `startxref`/`%%EOF`, and returns the
 * finished PDF bytes. `prev` chains to an earlier xref section's byte offset.
 */
function appendXrefStream({ chunks, pos }, { number, entries, size, w = [1, 4, 2], index = null, root, prev = null, compressed = false, extraDictText = "" }) {
  const raw = [];
  for (const entry of entries) raw.push(...bigEndian(entry.type, w[0]), ...bigEndian(entry.field2, w[1]), ...bigEndian(entry.field3, w[2]));
  let data = Uint8Array.from(raw);
  let filterClause = "";
  if (compressed) {
    data = deflateSync(data);
    filterClause = " /Filter /FlateDecode";
  }
  const indexClause = index ? ` /Index [${index.flat().join(" ")}]` : "";
  const prevClause = prev !== null ? ` /Prev ${prev}` : "";
  const dict = `<< /Type /XRef /Size ${size} /W [${w.join(" ")}]${indexClause} /Root ${root} 0 R${prevClause}${extraDictText} /Length ${data.length}${filterClause} >>`;
  const xrefOffset = pos;
  let piece = encode(`${number} 0 obj\n${dict}\nstream\n`);
  const nextChunks = [...chunks, piece];
  let nextPos = pos + piece.length;
  nextChunks.push(data); nextPos += data.length;
  piece = encode("\nendstream\nendobj\n");
  nextChunks.push(piece); nextPos += piece.length;
  piece = encode(`startxref\n${xrefOffset}\n%%EOF\n`);
  nextChunks.push(piece); nextPos += piece.length;
  return { bytes: concatChunks(nextChunks), chunks: nextChunks, pos: nextPos, xrefOffset };
}

/** Appends a classic `xref ... trailer` section plus `startxref`/`%%EOF`. */
function appendClassicXref({ chunks, pos }, { entries, size, root, prev = null }) {
  const xrefOffset = pos;
  const table = entries
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((entry) => `${entry.number} 1\n${String(entry.offset).padStart(10, "0")} ${String(entry.generation ?? 0).padStart(5, "0")} ${entry.free ? "f" : "n"} \n`)
    .join("");
  const prevClause = prev !== null ? ` /Prev ${prev}` : "";
  const piece = encode(`xref\n${table}trailer\n<< /Size ${size} /Root ${root} 0 R${prevClause} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const nextChunks = [...chunks, piece];
  return { bytes: concatChunks(nextChunks), chunks: nextChunks, pos: pos + piece.length, xrefOffset };
}

/**
 * A single-page PDF (Catalog 1, Pages 2, Page 3, Contents 4) whose only cross
 * reference is one xref stream (object 5). Options let individual tests exercise
 * /W, /Index, compression, and free/type-2 entries.
 */
function basicXrefStreamPdf(content, {
  compressed = false,
  w = [1, 4, 2],
  index = null,
  extraTrailingEntries = [],
  sizeOverride = null
} = {}) {
  const header = encode("%PDF-1.5\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode(content) }
  ];
  const placed = placeObjects([header], header.length, objects);
  const entries = [
    { number: 0, type: 0, field2: 0, field3: 65535 },
    ...objects.map((object) => ({ number: object.number, type: 1, field2: placed.offsets.get(object.number), field3: 0 })),
    { number: 5, type: 1, field2: placed.pos, field3: 0 },
    ...extraTrailingEntries
  ];
  const size = sizeOverride ?? entries.length;
  const result = appendXrefStream(placed, { number: 5, entries, size, w, index, root: 1, compressed });
  return result.bytes;
}

test("reads type 1 objects from a basic cross-reference stream and extracts text runs", async () => {
  const pdf = basicXrefStreamPdf("BT (Hello xref stream) Tj ET");
  const editor = new PdfTextEditor(pdf);
  const runs = await editor.listTextRuns();
  assert.deepEqual(runs.map((run) => run.text), ["Hello xref stream"]);
});

test("decodes a Flate-compressed cross-reference stream", async () => {
  const pdf = basicXrefStreamPdf("BT (Compressed xref) Tj ET", { compressed: true });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Compressed xref"]);
});

test("treats a missing /Index as covering object numbers 0 through /Size", async () => {
  // basicXrefStreamPdf() never sets `index`, so this is the same code path; assert it
  // explicitly against the /W/Index defaulting rule the implementation relies on.
  const pdf = basicXrefStreamPdf("BT (No Index key) Tj ET", { index: null });
  assert.doesNotMatch(latin1.decode(pdf).match(/5 0 obj\n(.*?)stream/s)[1], /\/Index/);
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["No Index key"]);
});

test("resolves object numbers from a partial, non-contiguous /Index", async () => {
  const header = encode("%PDF-1.5\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 40 0 R >>" },
    { number: 40, streamBytes: encode("BT (Sparse index) Tj ET") }
  ];
  const placed = placeObjects([header], header.length, objects);
  // Two disjoint ranges: 0..4 (free head, Catalog/Pages/Page, and the xref stream
  // object itself) and 40..40 (Contents), skipping every object number in between.
  // Row order must follow /Index pair order, not object-number order: rows 0-3 are
  // for the [0,4) range, row 4 is the single row for the [40,1) range.
  const result = appendXrefStream(placed, {
    number: 5,
    entries: [
      { number: 0, type: 0, field2: 0, field3: 65535 },
      { number: 1, type: 1, field2: placed.offsets.get(1), field3: 0 },
      { number: 2, type: 1, field2: placed.offsets.get(2), field3: 0 },
      { number: 3, type: 1, field2: placed.offsets.get(3), field3: 0 },
      { number: 40, type: 1, field2: placed.offsets.get(40), field3: 0 }
    ],
    size: 41,
    index: [[0, 4], [40, 1]],
    root: 1
  });
  const editor = new PdfTextEditor(result.bytes);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Sparse index"]);
});

test("lets a newer xref stream's free (type 0) entry invalidate an object from an older classic section", async () => {
  // Base: classic xref table with a real Contents object 4.
  const header = encode("%PDF-1.4\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode("BT (Will be freed) Tj ET") }
  ];
  const placed = placeObjects([header], header.length, objects);
  const classic = appendClassicXref(placed, {
    entries: [
      { number: 0, offset: 0, generation: 65535, free: true },
      ...objects.map((object) => ({ number: object.number, offset: placed.offsets.get(object.number), generation: 0 }))
    ],
    size: 5,
    root: 1
  });
  assert.equal((await new PdfTextEditor(classic.bytes).listTextRuns())[0].text, "Will be freed");

  // Update: an xref stream whose type 0 entry frees object 4, chained via /Prev to
  // the classic section above.
  const updated = appendXrefStream(classic, {
    number: 5,
    entries: [{ number: 4, type: 0, field2: 0, field3: 0 }],
    size: 5,
    index: [[4, 1]],
    root: 1,
    prev: classic.xrefOffset
  });
  await assert.rejects(
    new PdfTextEditor(updated.bytes).listTextRuns(),
    /PDF object 4 is missing from the xref table/
  );
});

test("chains an xref stream to an older classic xref table via /Prev", async () => {
  const header = encode("%PDF-1.4\n");
  const objects = [
    { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
    { number: 4, streamBytes: encode("BT (From classic base) Tj ET") }
  ];
  const placed = placeObjects([header], header.length, objects);
  const classic = appendClassicXref(placed, {
    entries: [
      { number: 0, offset: 0, generation: 65535, free: true },
      ...objects.map((object) => ({ number: object.number, offset: placed.offsets.get(object.number), generation: 0 }))
    ],
    size: 5,
    root: 1
  });

  // Update: replace object 4's content via a new object, indexed by an xref stream
  // that only lists the changed object and chains /Prev back to the classic table.
  const newContent = { number: 6, streamBytes: encode("BT (From xref stream update) Tj ET") };
  const replaced = placeObjects(classic.chunks, classic.pos, [
    { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>" },
    newContent
  ]);
  const updated = appendXrefStream(replaced, {
    number: 5,
    entries: [
      { number: 3, type: 1, field2: replaced.offsets.get(3), field3: 0 },
      { number: 6, type: 1, field2: replaced.offsets.get(6), field3: 0 }
    ],
    size: 7,
    index: [[3, 1], [6, 1]],
    root: 1,
    prev: classic.xrefOffset
  });

  const editor = new PdfTextEditor(updated.bytes);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["From xref stream update"]);
});

test("does not fail the whole xref stream over a type 2 entry, only accessing that object", async () => {
  const pdf = basicXrefStreamPdf("BT (Type 2 present) Tj ET", {
    // Object 6 claims to live inside object stream 99 at index 3, and is never
    // referenced by the page tree that listTextRuns() actually walks.
    extraTrailingEntries: [{ number: 6, type: 2, field2: 99, field3: 3 }],
    sizeOverride: 7
  });
  const editor = new PdfTextEditor(pdf);
  assert.deepEqual((await editor.listTextRuns()).map((run) => run.text), ["Type 2 present"]);
  assert.throws(() => editor.document.object(6), /Object streams are not supported/);
});

test("rejects malformed cross-reference streams instead of hanging or over-allocating", async () => {
  const attempts = [
    ["a /W with the wrong number of fields", { w: [1, 4] }, /invalid \/W/],
    ["a negative /W field", { w: [-1, 4, 2] }, /invalid \/W/],
    ["an odd-length /Index", { index: [[0, 3]], extraTrailingEntries: [], sizeOverride: 3, indexOddOverride: true }, /invalid \/Index/],
    ["an /Index claiming far more entries than the stream actually holds", { index: [[0, 1_000_000_000]], sizeOverride: 1_000_000_000 }, /length does not match \/W and \/Index/],
    // A subsection reaching object 6 while /Size says objects only go up to 5 (i.e.
    // object numbers 0-4): /Size is defined as "one greater than the highest object
    // number used in the file", so /Index [4 2] under /Size 5 is self-contradictory.
    ["an /Index subsection whose range exceeds /Size", { index: [[4, 2]], sizeOverride: 5 }, /invalid \/Index/],
    ["/Index subsections out of ascending order", { index: [[10, 2], [5, 2]], sizeOverride: 20 }, /invalid \/Index/],
    ["overlapping /Index subsections", { index: [[1, 4], [3, 2]], sizeOverride: 20 }, /invalid \/Index/]
  ];

  for (const [label, options, pattern] of attempts) {
    let pdf;
    if (options.indexOddOverride) {
      // Build directly: an /Index array with an odd element count is not
      // representable through basicXrefStreamPdf()'s [[start,count],...] pairing.
      const header = encode("%PDF-1.5\n");
      const objects = [
        { number: 1, dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
        { number: 2, dictionary: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { number: 3, dictionary: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
        { number: 4, streamBytes: encode("BT (unused) Tj ET") }
      ];
      const placed = placeObjects([header], header.length, objects);
      const entries = objects.map((object) => ({ number: object.number, type: 1, field2: placed.offsets.get(object.number), field3: 0 }));
      const result = appendXrefStream(placed, { number: 5, entries, size: 6, root: 1, extraDictText: " /Index [0 3 7]" });
      pdf = result.bytes;
    } else {
      pdf = basicXrefStreamPdf("BT (unused) Tj ET", options);
    }
    await assert.rejects(new PdfTextEditor(pdf).listTextRuns(), pattern, label);
  }
});

test("replaces text in an xref-stream PDF and reopens the saved incremental update", async () => {
  const pdf = basicXrefStreamPdf("BT (Before save) Tj ET");
  const editor = new PdfTextEditor(pdf);
  const [run] = await editor.listTextRuns();
  await editor.replaceText(run.id, "After save");
  const output = await editor.save();

  // save() always appends its own classic-xref incremental update, so reopening this
  // exercises classic xref chained via /Prev back into the original xref stream.
  assert.match(latin1.decode(output).slice(pdf.length), /^\d+ \d+ obj/);
  const reopened = new PdfTextEditor(output);
  assert.deepEqual((await reopened.listTextRuns()).map((r) => r.text), ["After save"]);
});
