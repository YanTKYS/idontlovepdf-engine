import { isRegular, isWhite, skipWhite } from "./syntax.js";

const latin1 = new TextDecoder("latin1");

// Exported for reuse by src/pdf-dictionary-text.js (the /O, /U, and /ID binary
// strings in an Encrypt dictionary/trailer use the exact same PDF string syntax --
// escapes, octal, hex -- as a Tj operand). One implementation avoids a second,
// separately-written copy quietly missing an escape case the other already handles.
export function readLiteral(bytes, start) {
  let depth = 1;
  let cursor = start + 1;
  const value = [];
  while (cursor < bytes.length && depth > 0) {
    const byte = bytes[cursor++];
    if (byte === 0x5c) {
      if (cursor >= bytes.length) break;
      const escaped = bytes[cursor++];
      const simple = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
      if (simple[escaped] !== undefined) value.push(simple[escaped]);
      else if (escaped === 10) continue;
      else if (escaped === 13) {
        if (bytes[cursor] === 10) cursor += 1;
      } else if (escaped >= 0x30 && escaped <= 0x37) {
        let octal = escaped - 0x30;
        for (let count = 1; count < 3 && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x37; count += 1) {
          octal = octal * 8 + bytes[cursor++] - 0x30;
        }
        value.push(octal & 0xff);
      } else value.push(escaped);
    } else if (byte === 0x28) {
      depth += 1;
      value.push(byte);
    } else if (byte === 0x29) {
      depth -= 1;
      if (depth > 0) value.push(byte);
    } else value.push(byte);
  }
  if (depth !== 0) throw new Error("Malformed PDF literal string");
  return { end: cursor, value: Uint8Array.from(value), syntax: "literal" };
}

export function readHex(bytes, start) {
  let cursor = start + 1;
  let digits = "";
  while (cursor < bytes.length && bytes[cursor] !== 0x3e) {
    if (!isWhite(bytes[cursor])) digits += String.fromCharCode(bytes[cursor]);
    cursor += 1;
  }
  if (cursor === bytes.length || !/^[0-9a-f]*$/i.test(digits)) throw new Error("Malformed PDF hex string");
  if (digits.length % 2) digits += "0";
  return {
    end: cursor + 1,
    value: Uint8Array.from(digits.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []),
    syntax: "hex"
  };
}

/**
 * Skips a PDF array `[ ... ]` appearing inside a content-stream dictionary operand
 * (e.g. `/BBox [0 0 100 100]`, `/Items [(A) <42>]`), tracking `[`/`]` depth and
 * reusing readLiteral()/readHex()/skipDictionary() for anything nested inside it --
 * a literal string, hex string, dictionary, or another array. Exported alongside
 * skipDictionary() for reuse by src/pdf-dictionary-text.js's top-level (depth-1)
 * dictionary field reader, which needs to skip over an array value the same way
 * when scanning past it in search of a different key; within this module,
 * scanTextRuns() itself never sees an array except as a TJ operand, which it reads
 * element-by-element on its own (see below), not via this helper.
 */
export function skipArray(bytes, start) {
  let cursor = start + 1;
  let depth = 1;
  while (cursor < bytes.length && depth > 0) {
    cursor = skipWhite(bytes, cursor);
    if (cursor >= bytes.length) break;
    if (bytes[cursor] === 0x5b) {
      depth += 1;
      cursor += 1;
    } else if (bytes[cursor] === 0x5d) {
      depth -= 1;
      cursor += 1;
    } else if (bytes[cursor] === 0x28) {
      cursor = readLiteral(bytes, cursor).end;
    } else if (bytes[cursor] === 0x3c && bytes[cursor + 1] === 0x3c) {
      cursor = skipDictionary(bytes, cursor);
    } else if (bytes[cursor] === 0x3c) {
      cursor = readHex(bytes, cursor).end;
    } else {
      cursor += 1;
    }
  }
  if (depth !== 0) throw new Error("Malformed PDF array in content stream");
  return cursor;
}

/**
 * Skips a PDF dictionary operand `<< ... >>` appearing directly in a content stream
 * (e.g. `/Span << /MCID 12 >> BDC`, a marked-content property list) as one opaque
 * unit, without extracting or interpreting anything inside it. scanTextRuns() below
 * must not mistake the dictionary's own second `<` for the start of a hex string
 * (that misreading is exactly what used to turn `/Span << /MCID 12 >> BDC` into a
 * "Malformed PDF hex string" failure -- `/MCID 12 ` is not valid hex), nor treat a
 * string nested inside the dictionary (e.g. `/ActualText (...)`) as a text-showing
 * operand -- neither is meaningful to this scanner, which only extracts operands of
 * Tj/TJ/'/" (see scanTextRuns()'s own docstring further down).
 *
 * `start` must point at the opening `<<`. Tracks `<<`/`>>` nesting depth, and reuses
 * readLiteral()/readHex() -- both already string-boundary-aware, so a `>>`, `<<`, or
 * unescaped `<`/`>` occurring inside a string value (literal or hex) never disturbs
 * the depth count. An array value is walked via skipArray() above, since it can
 * itself hold strings, nested dictionaries, or nested arrays. `%` comments are
 * skipped the same as whitespace, via skipWhite() (already used everywhere else in
 * this module for that).
 *
 * Never returns silently on a dictionary that never closes, or a string/array inside
 * it that is itself malformed: those already throw via readLiteral()/readHex()/
 * skipArray(), and an unclosed `<<` throws here once `bytes` runs out at depth > 0.
 */
export function skipDictionary(bytes, start) {
  if (bytes[start] !== 0x3c || bytes[start + 1] !== 0x3c) throw new Error("Expected a PDF dictionary");
  let cursor = start + 2;
  let depth = 1;
  while (cursor < bytes.length && depth > 0) {
    cursor = skipWhite(bytes, cursor);
    if (cursor >= bytes.length) break;
    if (bytes[cursor] === 0x3c && bytes[cursor + 1] === 0x3c) {
      depth += 1;
      cursor += 2;
    } else if (bytes[cursor] === 0x3e && bytes[cursor + 1] === 0x3e) {
      depth -= 1;
      cursor += 2;
    } else if (bytes[cursor] === 0x28) {
      cursor = readLiteral(bytes, cursor).end;
    } else if (bytes[cursor] === 0x3c) {
      cursor = readHex(bytes, cursor).end;
    } else if (bytes[cursor] === 0x5b) {
      cursor = skipArray(bytes, cursor);
    } else {
      cursor += 1;
    }
  }
  if (depth !== 0) throw new Error("Malformed PDF dictionary in content stream");
  return cursor;
}

function encodeLiteral(value) {
  const output = [0x28];
  for (const byte of value) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) output.push(0x5c, byte);
    else if (byte === 10) output.push(0x5c, 0x6e);
    else if (byte === 13) output.push(0x5c, 0x72);
    else output.push(byte);
  }
  output.push(0x29);
  return Uint8Array.from(output);
}

function encodeHex(value) {
  return new TextEncoder().encode(`<${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}>`);
}

/**
 * Skips an inline image (`BI … ID <binary> EI`). The binary data between `ID` and
 * `EI` is not PDF syntax: left to the tokenizer its bytes are read as literal
 * strings, which both invents text runs that do not exist and aborts the whole
 * scan when the image happens to contain an unbalanced `(`.
 *
 * `start` is the offset just past the `BI` operator; the returned offset is just
 * past the closing `EI`, or the end of the stream when the image is truncated.
 */
function skipInlineImage(bytes, start) {
  let cursor = start;
  while (cursor < bytes.length) {
    const isIdOperator = bytes[cursor] === 0x49 && bytes[cursor + 1] === 0x44
      && !isRegular(bytes[cursor - 1]) && !isRegular(bytes[cursor + 2]);
    if (isIdOperator) break;
    cursor += 1;
  }
  if (cursor >= bytes.length) return bytes.length;
  cursor += 2;
  // Exactly one whitespace byte separates ID from the image data.
  if (isWhite(bytes[cursor])) cursor += 1;
  while (cursor < bytes.length) {
    const isEiOperator = bytes[cursor] === 0x45 && bytes[cursor + 1] === 0x49
      && isWhite(bytes[cursor - 1]) && !isRegular(bytes[cursor + 2]);
    if (isEiOperator) return cursor + 2;
    cursor += 1;
  }
  return bytes.length;
}

/**
 * Wraps a token-reading call so a parse failure names where it happened: `context`
 * (e.g. "content stream object 42", passed in by the caller -- see decodeStream() in
 * pdf-document.js) and the byte offset the failing token started at, both appended to
 * the underlying error's own message (already specific -- "Malformed PDF hex
 * string", "Malformed PDF dictionary in content stream", ...). Also attaches a short
 * (<=40 byte) excerpt around the failure as `contentStreamExcerpt`/
 * `contentStreamOffset` properties, for callers that want it for debugging, without
 * putting raw PDF bytes into the message every caller/log/UI sees by default.
 */
function withStreamContext(read, bytes, cursor, context) {
  try {
    return read();
  } catch (error) {
    const suffix = context ? `${context}, byte offset ${cursor}` : `byte offset ${cursor}`;
    const wrapped = new Error(`${error.message} (${suffix})`);
    wrapped.contentStreamOffset = cursor;
    wrapped.contentStreamExcerpt = latin1.decode(bytes.subarray(Math.max(0, cursor - 20), Math.min(bytes.length, cursor + 20)));
    throw wrapped;
  }
}

/**
 * Extracts text-showing operands (Tj/TJ/'/" strings, inside BT...ET) from a content
 * stream, as a lightweight scanner -- not a full PDF content-stream parser or AST.
 * `context`, when given, is threaded into any parse-failure message via
 * withStreamContext() above; pdf-document.js passes `content stream object ${number}`.
 */
export function scanTextRuns(bytes, context = "") {
  const strings = [];
  const runs = [];
  let cursor = 0;
  let inText = false;
  let currentFont = null;
  let lastName = null;
  // Two `BT ... ET` blocks in the same content stream are usually positioned
  // independently (a new `Td`/`Tm` moves the text cursor elsewhere on the page), so
  // their runs must never be treated as adjacent text. Each `BT` gets its own id;
  // callers that concatenate runs into searchable text must also split on it.
  let textObjectId = -1;
  while (cursor < bytes.length) {
    cursor = skipWhite(bytes, cursor);
    if (cursor >= bytes.length) break;
    if (bytes[cursor] === 0x28) {
      const token = withStreamContext(() => readLiteral(bytes, cursor), bytes, cursor, context);
      strings.push({ ...token, start: cursor });
      cursor = token.end;
      continue;
    }
    // A dictionary operand (e.g. `/Span << /MCID 12 >> BDC`, a marked-content
    // property list) is skipped as one opaque unit -- its second `<` must never be
    // mistaken for the start of a hex string (see skipDictionary()'s docstring), and
    // any string nested inside it (e.g. /ActualText's value) must never become a
    // text-showing run: this scanner only extracts operands actually passed to
    // Tj/TJ/'/", which a dictionary operand to BDC/DP/etc. never is.
    if (bytes[cursor] === 0x3c && bytes[cursor + 1] === 0x3c) {
      cursor = withStreamContext(() => skipDictionary(bytes, cursor), bytes, cursor, context);
      continue;
    }
    if (bytes[cursor] === 0x3c) {
      const token = withStreamContext(() => readHex(bytes, cursor), bytes, cursor, context);
      strings.push({ ...token, start: cursor });
      cursor = token.end;
      continue;
    }
    if (bytes[cursor] === 0x2f) {
      const start = ++cursor;
      while (isRegular(bytes[cursor])) cursor += 1;
      lastName = latin1.decode(bytes.subarray(start, cursor));
      continue;
    }
    const start = cursor;
    while (isRegular(bytes[cursor])) cursor += 1;
    if (cursor === start) {
      cursor += 1;
      continue;
    }
    const operator = latin1.decode(bytes.subarray(start, cursor));
    if (operator === "BI") {
      cursor = skipInlineImage(bytes, cursor);
      strings.length = 0;
      lastName = null;
    } else if (operator === "BT") {
      inText = true;
      currentFont = null;
      textObjectId += 1;
      strings.length = 0;
    } else if (operator === "ET") {
      inText = false;
      strings.length = 0;
    } else if (inText && operator === "Tf") {
      currentFont = lastName;
      strings.length = 0;
    } else if (inText && (operator === "Tj" || operator === "'" || operator === "\"" || operator === "TJ")) {
      for (const string of strings) runs.push({ ...string, fontName: currentFont, textObjectId });
      strings.length = 0;
    } else if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(operator)) {
      strings.length = 0;
      lastName = null;
    }
  }
  return runs;
}

export function replaceTextRuns(bytes, replacements) {
  const runs = scanTextRuns(bytes);
  const byIndex = new Map(replacements.map((replacement) => [replacement.runIndex, replacement.bytes]));
  const chunks = [];
  let cursor = 0;
  runs.forEach((run, index) => {
    if (!byIndex.has(index)) return;
    chunks.push(bytes.subarray(cursor, run.start));
    chunks.push(run.syntax === "hex" ? encodeHex(byIndex.get(index)) : encodeLiteral(byIndex.get(index)));
    cursor = run.end;
  });
  chunks.push(bytes.subarray(cursor));
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
