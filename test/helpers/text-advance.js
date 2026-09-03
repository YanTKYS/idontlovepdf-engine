// An independent reader for what a PDF draws and where.
//
// Nothing here imports from src/. It parses the saved file itself and applies PDF 9.4.4's
// text-advance formula on its own, so when a test says "8年度 is drawn at exactly the x it
// was drawn at before", that is a second opinion about the file's bytes -- not the engine
// restating its own arithmetic. Shared by test/fallback-font-tj.test.js (v0.4.1) and
// test/font-metrics-indirect.test.js (v0.4.2), which must be measured the same way.
import assert from "node:assert/strict";

const latin1 = new TextDecoder("latin1");

/** Reads a bracketed value from `text` at `start`, tracking depth, and returns its end. */
function balancedEnd(text, start, open, close) {
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    if (text.startsWith(open, cursor)) {
      depth += 1;
      cursor += open.length;
    } else if (text.startsWith(close, cursor)) {
      depth -= 1;
      cursor += close.length;
      if (!depth) return cursor;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

/**
 * Every indirect object, keyed by object number, taking the LAST definition of each --
 * which is what a reader following an incremental update's xref chain arrives at.
 *
 * `{ dictionary }` for a dictionary or stream (located by `<<`/`>>` depth rather than by
 * `endobj`, so a deflated font program's bytes cannot be mistaken for structure),
 * `{ array }` for a bare array object -- the text between its outer brackets -- and
 * `{ number }` for a bare number. A PDF may write a `/Widths`, `/W`, `/DW` or `/FirstChar`
 * as any of these, and this reader has to follow the same references a PDF viewer would.
 */
export function objectsOf(pdf) {
  const text = latin1.decode(pdf);
  const objects = new Map();
  for (const header of text.matchAll(/(?:^|[\r\n])(\d+) \d+ obj[\s]*/g)) {
    const start = header.index + header[0].length;
    const number = Number(header[1]);
    if (text.startsWith("<<", start)) {
      objects.set(number, { dictionary: text.slice(start, balancedEnd(text, start, "<<", ">>")) });
    } else if (text[start] === "[") {
      objects.set(number, { array: text.slice(start + 1, balancedEnd(text, start, "[", "]") - 1) });
    } else {
      const scalar = /^[+-]?(?:\d+\.?\d*|\.\d+)(?![0-9.])/.exec(text.slice(start));
      if (scalar) objects.set(number, { number: Number(scalar[0]) });
    }
  }
  return objects;
}

/** Just the dictionaries, for tests that only look at those. */
export function dictionariesOf(pdf) {
  const dictionaries = new Map();
  for (const [number, object] of objectsOf(pdf)) {
    if (object.dictionary) dictionaries.set(number, object.dictionary);
  }
  return dictionaries;
}

/** The text of `key`'s array value, direct or indirect, without its outer brackets. */
function arrayTextOf(dictionary, key, objects) {
  const opener = new RegExp(`/${key}\\s*\\[`).exec(dictionary);
  if (opener) {
    const bracket = opener.index + opener[0].length - 1;
    return dictionary.slice(bracket + 1, balancedEnd(dictionary, bracket, "[", "]") - 1);
  }
  const indirect = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictionary);
  return indirect ? objects.get(Number(indirect[1]))?.array ?? null : null;
}

/** The object number of the one font in `/DescendantFonts`, whether the array is direct or indirect. */
function descendantNumberOf(type0, objects) {
  const direct = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(type0);
  if (direct) return Number(direct[1]);
  const indirect = /\/DescendantFonts\s+(\d+)\s+\d+\s+R/.exec(type0);
  const array = indirect ? objects.get(Number(indirect[1]))?.array : null;
  const inner = array ? /(\d+)\s+\d+\s+R/.exec(array) : null;
  return inner ? Number(inner[1]) : null;
}

/** The value of `key`'s number, direct or indirect. */
function numberOf(dictionary, key, objects) {
  const direct = new RegExp(`/${key}\\s+([+-]?(?:\\d+\\.?\\d*|\\.\\d+))(?![0-9.])(?!\\s+\\d+\\s+R)`).exec(dictionary);
  if (direct) return Number(direct[1]);
  const indirect = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictionary);
  const object = indirect ? objects.get(Number(indirect[1])) : null;
  return object && typeof object.number === "number" ? object.number : null;
}

/** `/W` -> CID -> width, parsed here rather than by the engine's own reader. */
function cidWidthsOf(dictionary, objects) {
  const widths = new Map();
  const text = arrayTextOf(dictionary, "W", objects);
  if (text !== null) {
    const tokens = text.match(/\[|\]|-?[\d.]+/g) ?? [];
    let index = 0;
    while (index < tokens.length) {
      const first = Number(tokens[index += 1] && tokens[index - 1]);
      if (tokens[index] === "[") {
        index += 1;
        for (let cid = first; tokens[index] !== "]"; index += 1, cid += 1) widths.set(cid, Number(tokens[index]));
        index += 1;
      } else {
        const last = Number(tokens[index]);
        const width = Number(tokens[index + 1]);
        index += 2;
        for (let cid = first; cid <= last; cid += 1) widths.set(cid, width);
      }
    }
  }
  return { widths, defaultWidth: numberOf(dictionary, "DW", objects) ?? 1000 };
}

/** Resource name -> how wide each code of that font is, read out of the file. */
export function fontTable(pdf) {
  const objects = objectsOf(pdf);
  const dictionaries = new Map([...objects].flatMap(([number, object]) => (object.dictionary ? [[number, object.dictionary]] : [])));
  const page = [...dictionaries.values()].filter((dictionary) => /\/Type\s*\/Page\b/.test(dictionary)).at(-1);
  const fonts = new Map();
  for (const entry of (/\/Font\s*<<([\s\S]*?)>>/.exec(page)?.[1] ?? "").matchAll(/\/([^\s/]+)\s+(\d+)\s+0\s+R/g)) {
    const type0 = dictionaries.get(Number(entry[2])) ?? "";
    const descendant = descendantNumberOf(type0, objects);
    if (!/\/Subtype\s*\/Type0\b/.test(type0)) {
      // A simple font: one byte per code, widths indexed from /FirstChar.
      const first = numberOf(type0, "FirstChar", objects);
      const table = (arrayTextOf(type0, "Widths", objects)?.match(/-?[\d.]+/g) ?? []).map(Number);
      fonts.set(entry[1], Object.assign((code) => table[code - first] ?? 0, { codeBytes: 1 }));
      continue;
    }
    if (descendant === null) {
      // A Type0 with no descendant font states no widths at all. Only the fixtures that
      // exist to be refused look like that, and none of them compares positions.
      fonts.set(entry[1], Object.assign(() => 1000, { codeBytes: 2 }));
      continue;
    }
    const { widths, defaultWidth } = cidWidthsOf(dictionaries.get(descendant) ?? "", objects);
    fonts.set(entry[1], Object.assign((code) => widths.get(code) ?? defaultWidth, { codeBytes: 2 }));
  }
  return fonts;
}

/**
 * Walks a content stream applying PDF 9.4.4's text-advance formula
 *
 *     tx = ((w0 - Tj / 1000) * Tfs + Tc + Tw) * Th
 *
 * and reports where every glyph is drawn: `{ font, code, x }`, x in text space from the
 * text object's origin. Only what these fixtures use is implemented -- 1- and 2-byte
 * codes, `Tf`, `Tc`, `Tw`, `Tz`, `Td`, `Tm` translations, `Tj` and `TJ` -- and anything
 * else throws rather than being silently ignored.
 */
export function simulate(content, fonts) {
  const tokens = content.match(/<[0-9a-fA-F]*>|\[|\]|[+-]?(?:\d+\.?\d*|\.\d+)|\/[^\s/[\]<>]+|[A-Za-z*'"]+/g) ?? [];
  const drawn = [];
  let font = null;
  let size = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let scale = 1;
  let line = 0;
  // Glyph-space units and glyph count since the text position was last set outright. Kept
  // apart from the metres so that two content streams which advance by the same amount
  // compute the same double, rather than the same amount to within a rounding error.
  let units = 0;
  let count = 0;
  let name = null;
  const operands = [];
  let spaces = 0;
  const at = () => line + ((units / 1000) * size + count * charSpacing + spaces * wordSpacing) * scale;
  const reset = (position) => {
    line = position;
    units = 0;
    count = 0;
    spaces = 0;
  };
  // The formula below folds the text state out of the accumulator, which is only valid
  // while that state holds still over a drawn line -- true of every fixture here, and
  // worth failing loudly on rather than mis-simulating.
  const settle = (label, current, next) => {
    if (count && current !== next) throw new Error(`the simulator does not implement ${label} changing mid-line`);
    return next;
  };
  const show = (hex) => {
    const width = fonts.get(font);
    const digits = width.codeBytes * 2;
    for (let index = 0; index < hex.length; index += digits) {
      const code = Number.parseInt(hex.slice(index, index + digits), 16);
      drawn.push({ font, code, x: at() });
      units += width(code);
      count += 1;
      // Word spacing applies to the single-byte code 32 and nothing else, so a 2-byte
      // encoding never sees it however its codes happen to decode.
      if (width.codeBytes === 1 && code === 32) spaces += 1;
    }
  };
  for (const token of tokens) {
    if (token.startsWith("<")) {
      operands.push(token.slice(1, -1));
      continue;
    }
    if (token.startsWith("/")) {
      name = token.slice(1);
      continue;
    }
    if (token === "[" || token === "]") continue;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push(Number(token));
      continue;
    }
    switch (token) {
      case "BT": reset(0); break;
      case "ET": break;
      case "Tf": font = name; size = settle("Tf", size, operands.at(-1)); break;
      case "Tc": charSpacing = settle("Tc", charSpacing, operands.at(-1)); break;
      case "Tw": wordSpacing = settle("Tw", wordSpacing, operands.at(-1)); break;
      case "Tz": scale = settle("Tz", scale, operands.at(-1) / 100); break;
      case "TL": break;
      case "Td": reset(line + operands.at(-2)); break;
      case "Tm":
        assert.deepEqual(operands.slice(-6, -2), [1, 0, 0, 1], "the simulator only implements a translation Tm");
        reset(operands.at(-2));
        break;
      case "Tj": show(operands.at(-1)); break;
      case "TJ":
        for (const operand of operands) {
          if (typeof operand === "number") units -= operand;
          else show(operand);
        }
        break;
      default: throw new Error(`the simulator does not implement ${token}`);
    }
    operands.length = 0;
  }
  return drawn;
}
