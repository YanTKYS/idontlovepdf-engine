const whitespace = new Set([0, 9, 10, 12, 13, 32]);

function isWhite(byte) {
  return whitespace.has(byte);
}

function skipWhite(bytes, start) {
  let cursor = start;
  while (cursor < bytes.length) {
    if (isWhite(bytes[cursor])) {
      cursor += 1;
    } else if (bytes[cursor] === 0x25) {
      while (cursor < bytes.length && bytes[cursor] !== 10 && bytes[cursor] !== 13) cursor += 1;
    } else break;
  }
  return cursor;
}

function readLiteral(bytes, start) {
  let depth = 1;
  let cursor = start + 1;
  const value = [];
  while (cursor < bytes.length && depth > 0) {
    const byte = bytes[cursor++];
    if (byte === 0x5c) {
      if (cursor >= bytes.length) break;
      let escaped = bytes[cursor++];
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

function readHex(bytes, start) {
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

export function scanTextRuns(bytes) {
  const strings = [];
  const runs = [];
  let cursor = 0;
  let inText = false;
  let currentFont = null;
  let lastName = null;
  while (cursor < bytes.length) {
    cursor = skipWhite(bytes, cursor);
    if (cursor >= bytes.length) break;
    if (bytes[cursor] === 0x28) {
      const token = readLiteral(bytes, cursor);
      strings.push({ ...token, start: cursor });
      cursor = token.end;
      continue;
    }
    if (bytes[cursor] === 0x3c && bytes[cursor + 1] !== 0x3c) {
      const token = readHex(bytes, cursor);
      strings.push({ ...token, start: cursor });
      cursor = token.end;
      continue;
    }
    if (bytes[cursor] === 0x2f) {
      const start = ++cursor;
      while (cursor < bytes.length && !isWhite(bytes[cursor]) && !"()<>[]{}/%".includes(String.fromCharCode(bytes[cursor]))) cursor += 1;
      lastName = new TextDecoder("latin1").decode(bytes.subarray(start, cursor));
      continue;
    }
    const start = cursor;
    while (cursor < bytes.length && !isWhite(bytes[cursor]) && !"()<>[]{}/%".includes(String.fromCharCode(bytes[cursor]))) cursor += 1;
    if (cursor === start) {
      cursor += 1;
      continue;
    }
    const operator = new TextDecoder("latin1").decode(bytes.subarray(start, cursor));
    if (operator === "BT") {
      inText = true;
      currentFont = null;
      strings.length = 0;
    } else if (operator === "ET") {
      inText = false;
      strings.length = 0;
    } else if (inText && operator === "Tf") {
      currentFont = lastName;
      strings.length = 0;
    } else if (inText && (operator === "Tj" || operator === "'" || operator === "\"" || operator === "TJ")) {
      for (const string of strings) runs.push({ ...string, fontName: currentFont });
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
