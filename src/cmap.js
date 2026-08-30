const latin1 = new TextDecoder("latin1");

/**
 * A bfrange cannot span more than the 2-byte codespace that ToUnicode CMaps use.
 * Anything wider is malformed, and expanding it entry by entry would hang the tab.
 */
const MAX_RANGE_LENGTH = 0x10000;

function utf16be(hex) {
  const units = [];
  for (let index = 0; index < hex.length; index += 4) units.push(Number.parseInt(hex.slice(index, index + 4), 16));
  return String.fromCharCode(...units);
}

function incrementHex(hex, amount) {
  return (BigInt(`0x${hex}`) + BigInt(amount)).toString(16).padStart(hex.length, "0");
}

export function parseToUnicodeCMap(bytes) {
  const source = latin1.decode(bytes);
  const mappings = new Map();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      mappings.set(match[1].toLowerCase(), utf16be(match[2]));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const match of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:<([0-9a-f]+)>|\[([^\]]+)\])/gi)) {
      const start = BigInt(`0x${match[1]}`);
      const end = BigInt(`0x${match[2]}`);
      if (end < start || end - start >= BigInt(MAX_RANGE_LENGTH)) continue;
      const destinations = match[4] ? [...match[4].matchAll(/<([0-9a-f]+)>/gi)].map((item) => item[1]) : null;
      for (let offset = 0n; start + offset <= end; offset += 1n) {
        const sourceCode = (start + offset).toString(16).padStart(match[1].length, "0");
        // A destination array shorter than the range leaves the tail unmapped; it must
        // not fall through to the single-destination form, which is absent here.
        const destination = destinations ? destinations[Number(offset)] : incrementHex(match[3], offset);
        if (destination) mappings.set(sourceCode, utf16be(destination));
      }
    }
  }
  return mappings;
}

export function decodeWithCMap(bytes, mappings) {
  if (!mappings?.size) return latin1.decode(bytes);
  const widths = [...new Set([...mappings.keys()].map((key) => key.length / 2))].sort((a, b) => b - a);
  let output = "";
  for (let cursor = 0; cursor < bytes.length;) {
    let matched = false;
    for (const width of widths) {
      const key = [...bytes.subarray(cursor, cursor + width)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (mappings.has(key)) {
        output += mappings.get(key);
        cursor += width;
        matched = true;
        break;
      }
    }
    if (!matched) {
      output += "\ufffd";
      cursor += 1;
    }
  }
  return output;
}

export function encodeWithCMap(text, mappings) {
  const reverse = new Map([...mappings].map(([bytes, unicode]) => [unicode, bytes]));
  const values = [];
  for (const character of text) {
    const hex = reverse.get(character);
    if (!hex) throw new Error(`The existing PDF font has no ToUnicode code for ${JSON.stringify(character)}`);
    for (let index = 0; index < hex.length; index += 2) values.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return Uint8Array.from(values);
}
