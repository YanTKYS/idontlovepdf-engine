import { replaceTextRuns, scanTextRuns } from "./content-stream.js";
import { decodeWithCMap, encodeWithCMap, parseToUnicodeCMap } from "./cmap.js";
import { summarizeEncryption } from "./encryption.js";
import { deflate, decodeStreamBytes, filters } from "./flate.js";
import { PdfStructure, reference } from "./pdf-structure.js";
import { authenticateEncryptedPdf, decryptStreamBytes } from "./security/decrypt.js";

const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

function encodeSingleByte(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) throw new Error("String replacements are limited to single-byte characters; pass encoded Uint8Array data for composite fonts");
    bytes[index] = code;
  }
  return bytes;
}

/**
 * How much of the surrounding line searchText() hands back with each match, in Unicode
 * code points either side. Enough for a caller to tell two hits of the same word apart
 * in a list; short enough that a match object stays cheap.
 */
const CONTEXT_RADIUS = 12;

/** An error carrying a stable `code`, so callers can branch on the reason rather than
 * on message text (which is free to change, and is localised nowhere). */
function searchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The runs of every scanned content stream, decoded, in document order -- with the
 * continuity metadata that scanTextRuns() attached and that listTextRuns() drops.
 *
 * `text` is each run's *current* text: the pending replacement's, where one has already
 * been staged by replaceText()/replaceTextMatch(), and the original otherwise. Search
 * therefore sees the document as the caller has edited it so far, which is also what
 * makes the staleness check in replaceTextMatch() meaningful -- a match whose runs have
 * moved on since it was found no longer compares equal to its recorded snapshot.
 */
function internalRuns(editor) {
  return editor.streams.flatMap((stream) => stream.runs.map((run, runIndex) => {
    const id = `${stream.object.number}:${runIndex}`;
    const mappings = stream.fontMaps.get(run.fontName);
    return {
      id,
      objectNumber: stream.object.number,
      continuityId: run.continuityId,
      joinBefore: run.joinBefore,
      fontName: run.fontName,
      text: decodeWithCMap(editor.pending.get(id) ?? run.value, mappings)
    };
  }));
}

/**
 * Joins runs into the strings a reader of the page actually sees.
 *
 * Two runs belong to the same segment only when they come from the same content stream
 * object *and* carry the same `continuityId` -- the judgement scanTextRuns() already
 * made from the PDF's own operators (a new `BT`, an `ET`, `Td`/`TD`/`Tm`/`T*`, `'`/`"`,
 * a font switch, ... all end a segment). Nothing here re-derives that from geometry or
 * guesses at it, and nothing joins across content streams: a run's position in this
 * list is never, on its own, a reason to join it to its neighbour.
 *
 * Offsets are counted in Unicode code points, not UTF-16 code units, so a character
 * outside the BMP counts once (see the character-count rule in replaceTextMatch()).
 */
function buildSegments(runs) {
  const segments = [];
  let current = null;
  for (const run of runs) {
    if (!current || current.objectNumber !== run.objectNumber || current.continuityId !== run.continuityId) {
      current = { objectNumber: run.objectNumber, continuityId: run.continuityId, points: [], entries: [] };
      segments.push(current);
    }
    const points = [...run.text];
    current.entries.push({ run, start: current.points.length, end: current.points.length + points.length });
    current.points.push(...points);
  }
  return segments;
}

/** indexOf() over arrays of code points, from `from` onwards; -1 when absent. */
function indexOfPoints(haystack, needle, from) {
  for (let start = from; start + needle.length <= haystack.length; start += 1) {
    let offset = 0;
    while (offset < needle.length && haystack[start + offset] === needle[offset]) offset += 1;
    if (offset === needle.length) return start;
  }
  return -1;
}

/**
 * Encodes a replacement for one specific run, through that run's own existing font:
 * its `/ToUnicode` CMap when it has one (reverse-mapped by encodeWithCMap), and plain
 * single-byte codes when it does not. No font is embedded and no subset is rebuilt, so
 * a character the existing font cannot express fails loudly here -- which is the point.
 */
function encodeReplacement(editor, run, replacement) {
  if (typeof replacement !== "string") return Uint8Array.from(replacement);
  const stream = editor.streams.find((candidate) => candidate.object.number === run.objectNumber);
  const mappings = stream.fontMaps.get(run.fontName);
  return mappings ? encodeWithCMap(replacement, mappings) : encodeSingleByte(replacement);
}

/**
 * How replaceTextMatch() will write a given replacement. Reported by
 * checkTextMatchReplacement() so a caller can decide before committing to anything.
 */
const REPLACEMENT_MODE = {
  singleRun: "single-run",
  sameLength: "same-length",
  delete: "delete",
  variableLength: "variable-length-safe"
};

function refusal(code, reason, unsafeReason) {
  return unsafeReason ? { allowed: false, code, reason, unsafeReason } : { allowed: false, code, reason };
}

/**
 * Whether the runs of a match may have characters moved BETWEEN them -- the question a
 * variable-length replacement has to answer, and a stricter one than the search
 * continuity that let the runs be read as one string in the first place.
 *
 * Returns null when the move is safe, or a short reason why it is not.
 *
 * What makes it safe is narrow and provable, not estimated. Inside a group of operands
 * separated only by zero-valued `TJ` adjustments or by nothing at all, a zero adjustment
 * translates the text matrix by zero and an empty string operand shows no glyphs and
 * advances nothing -- so the page depends only on the concatenation of the operands, not
 * on how the characters are distributed among them. Moving them all into the first
 * operand is then exactly the single-operand replacement v0.2.1 already does, with no
 * glyph width, text matrix, or spacing arithmetic anywhere.
 *
 * "Separated only by zero-valued adjustments" is about the NET displacement between two
 * strings, not about where the numbers are written: a `TJ` number moves the next string
 * whether it sits at the end of one array, at the start of the next, or between two
 * operands of a single one, so `[(A) 120] TJ [(B)] TJ` is no more an adjacency than
 * `[(A) 120 (B)] TJ` is. scanTextRuns() sums across the operator boundary for exactly
 * this reason; reading only the numbers inside an array would let a kern be silently
 * relocated to after the replacement.
 *
 * Everything else is refused. A non-zero adjustment is real spacing between two specific
 * glyphs, and honouring it after moving characters would mean re-deciding what it should
 * be; a `Tc`/`Tw`/`Tz`/`Tr`, colour, or marked-content operator between two operands
 * means the two are drawn under different state, so a character moved across it would be
 * drawn differently than the PDF asked. Both are out of scope by design -- see the
 * README -- and neither is guessed at.
 */
function variableLengthObstacle(span, current) {
  for (let index = 1; index < span.length; index += 1) {
    const join = current.get(span[index].runId)?.joinBefore;
    // A null join means this run starts its own continuity group, which a match should
    // never span. Refuse rather than assume the scanner and the match agree.
    if (!join) return "unsupported-topology";
    if (join.kind === "state-change") return "text-state-boundary";
    // The two operands are adjacent only if nothing displaces the second relative to the
    // first. That holds for a `TJ` adjustment between two operands of one array and,
    // equally, for one spanning the operator boundary -- `[(A) 120] TJ [(B)] TJ` moves B
    // exactly as `[(A) 120 (B)] TJ` does, and a scanner that only looked inside arrays
    // would read it as a plain adjacency and quietly relocate the 120. Compared as a
    // number, so `0`, `0.0`, `+0`, `-0` and `-0.0` are all the same zero, and a pair
    // that cancels out (`[(A) 120] TJ [-120 (B)] TJ`) is genuinely adjacent.
    if (join.adjustment !== 0) return "non-zero-tj-adjustment";
  }
  return null;
}

/**
 * The single decision point for "may this match be replaced by this text, and with what
 * written where". Both checkTextMatchReplacement() and replaceTextMatch() go through it,
 * so a caller can never be told a replacement is allowed and then have it refused --
 * they are literally the same verdict, including the font encoding, which is attempted
 * here rather than left to fail later.
 *
 * Returns `{ allowed: false, code, reason, unsafeReason? }`, or `{ allowed: true, mode,
 * updates }` where `updates` is every run to rewrite, already encoded. Nothing is staged
 * here: the caller commits `updates` in one go, so a refusal -- or a character the font
 * cannot express -- leaves the document exactly as it was rather than half replaced.
 */
function planTextMatchReplacement(editor, matchId, replacement) {
  // /P's modify permission is a property of the PDF, checked on every attempt: finding
  // text is a reading capability, changing it is not. Reported rather than thrown so
  // checkTextMatchReplacement() can tell a caller up front that editing is not allowed.
  if (editor.security && editor.security.modifyAllowed === false) {
    return refusal("MODIFICATION_NOT_PERMITTED", "Document modification is not permitted: this PDF's /P permissions disallow content changes (modify permission denied)");
  }
  if (typeof replacement !== "string") {
    return refusal("REPLACEMENT_NOT_A_STRING", "replaceTextMatch() takes the replacement as a string; use replaceText() to write raw font-encoded bytes to a single run");
  }
  const match = editor.matches.get(matchId);
  if (!match) {
    return refusal("UNKNOWN_MATCH", `Unknown search match: ${matchId} (match ids come from this editor's most recent searchText() call and are superseded by the next one)`);
  }

  const current = new Map(internalRuns(editor).map((run) => [run.id, run]));
  for (const entry of match.span) {
    if (current.get(entry.runId)?.text !== entry.runText) {
      return refusal("MATCH_STALE", `This match is stale: the text it was found in has changed since searchText() returned it (run ${entry.runId}). Search again and replace the new match.`);
    }
  }

  const replacementPoints = [...replacement];
  let mode;
  let chunks;
  if (match.span.length === 1) {
    // One operand: rewritten whole, so its length was never constrained.
    mode = REPLACEMENT_MODE.singleRun;
    chunks = [replacementPoints];
  } else {
    const fonts = new Set(match.span.map((entry) => entry.fontName));
    if (fonts.size > 1) {
      return refusal("MULTI_RUN_FONT_CHANGE_UNSUPPORTED", `This match spans ${fonts.size} fonts; replacing it would have to encode its characters through more than one font, which is not supported`);
    }
    const matchLength = [...match.text].length;
    if (!replacementPoints.length) {
      // Deletion, unchanged from v0.2.1: every run keeps its own prefix and suffix and
      // gives up only its share of the match, so no character moves between operands.
      mode = REPLACEMENT_MODE.delete;
      chunks = match.span.map(() => []);
    } else if (replacementPoints.length === matchLength) {
      // Equal length, unchanged from v0.2.1: each run gets back exactly as many
      // characters as it contributed, so the original operand boundaries survive and
      // nothing depends on what sits between them.
      mode = REPLACEMENT_MODE.sameLength;
      let cursor = 0;
      chunks = match.span.map((entry) => {
        const contributed = entry.charEnd - entry.charStart;
        const chunk = replacementPoints.slice(cursor, cursor + contributed);
        cursor += contributed;
        return chunk;
      });
    } else {
      const obstacle = variableLengthObstacle(match.span, current);
      if (obstacle) {
        return refusal(
          "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED",
          `This match is drawn as ${match.span.length} separate text runs, so a replacement of ${replacementPoints.length} characters cannot be written over ${matchLength} without moving text relative to the PDF's own spacing (${obstacle}). Use an equal-length replacement, or an empty one to delete.`,
          obstacle
        );
      }
      // Safe topology: the whole replacement goes into the first operand and the rest of
      // the match's operands are emptied. Operand count, operator structure and every
      // adjustment stay exactly as they were.
      mode = REPLACEMENT_MODE.variableLength;
      chunks = match.span.map((_, index) => (index === 0 ? replacementPoints : []));
    }
  }

  const updates = [];
  try {
    match.span.forEach((entry, index) => {
      const points = [...entry.runText];
      const text = points.slice(0, entry.charStart).join("") + chunks[index].join("") + points.slice(entry.charEnd).join("");
      if (text === entry.runText) return;
      updates.push({ id: entry.runId, bytes: encodeReplacement(editor, entry, text) });
    });
  } catch (error) {
    // A character the existing font has no code for. Reported with the underlying
    // message intact, so callers matching on it keep working.
    return { ...refusal("FONT_ENCODING_UNSUPPORTED", error.message), cause: error };
  }
  return { allowed: true, mode, updates };
}

function planError(plan) {
  const error = new Error(plan.reason);
  error.code = plan.code;
  if (plan.unsafeReason) error.unsafeReason = plan.unsafeReason;
  if (plan.cause) error.cause = plan.cause;
  return error;
}

function concat(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Decrypts (when `security` is set -- an authenticated encrypted PDF) and then
 * inflates one stream object's bytes. Decryption always runs before FlateDecode:
 * the PDF spec encrypts the *filtered* stream bytes, so a Crypt Filter is
 * conceptually the outermost filter, applied first on read (and would be the last
 * one applied on write, which is exactly why save() refuses encrypted PDFs instead
 * of re-encrypting -- see PdfTextEditor#save()).
 */
async function decodeStream(object, kind, security) {
  const data = security
    ? await decryptStreamBytes(security, { objectNumber: object.number, generation: object.generation, bytes: object.data })
    : object.data;
  return decodeStreamBytes(object.dictionary, data, `${kind} object ${object.number}`);
}

function replacementDictionary(dictionary, length) {
  // save() re-deflates the decoded (already predictor-reversed) content directly,
  // without re-applying any predictor (see save()'s comment). A /DecodeParms carried
  // over from the original stream would tell a reader reopening this file to reverse
  // a predictor that the new bytes were never encoded with, so it is dropped here.
  const withoutDecodeParms = dictionary
    .replace(/\/DecodeParms\s*\[\s*<<[\s\S]*?>>\s*\]/, "")
    .replace(/\/DecodeParms\s*<<[\s\S]*?>>/, "");
  if (/\/Length\s+\d+\s+\d+\s+R/.test(withoutDecodeParms)) return withoutDecodeParms.replace(/\/Length\s+\d+\s+\d+\s+R/, `/Length ${length}`);
  if (/\/Length\s+\d+/.test(withoutDecodeParms)) return withoutDecodeParms.replace(/\/Length\s+\d+/, `/Length ${length}`);
  return withoutDecodeParms.replace(/>>\s*$/, `/Length ${length} >>`);
}

// The /Font sub-dictionary of /Resources can itself be an indirect object, and
// (like Resources, Pages, and Page) that indirect object can be compressed inside
// an Object Stream -- so this resolves it the same way pageContentObjects() does.
async function fontReferences(resources, structure, security) {
  const indirect = reference(resources.dictionary, "Font");
  const fontDictionary = indirect
    ? (await structure.resolveObject(indirect, security, decryptStreamBytes)).dictionary
    : resources.dictionary.match(/\/Font\s*<<(.*?)>>/s)?.[1] ?? "";
  return new Map([...fontDictionary.matchAll(/\/([^\s/<>{}\[\]()]+)\s+(\d+)\s+(\d+)\s+R/g)].map((match) => [
    match[1], { number: Number(match[2]), generation: Number(match[3]) }
  ]));
}

async function loadFontMaps(resources, structure, security) {
  const result = new Map();
  // A font dictionary can itself be compressed (a common PDF-writer optimization);
  // its own /ToUnicode target, however, is always a stream, and streams are never
  // stored in an Object Stream (PDF spec 7.5.7), so that lookup stays on the
  // synchronous, unchanged structure.object().
  for (const [name, fontReference] of await fontReferences(resources, structure, security)) {
    const font = await structure.resolveObject(fontReference, security, decryptStreamBytes);
    const toUnicode = reference(font.dictionary, "ToUnicode");
    if (!toUnicode) continue;
    const cmapObject = structure.object(toUnicode);
    result.set(name, parseToUnicodeCMap(await decodeStream(cmapObject, "ToUnicode stream", security)));
  }
  return result;
}

export class PdfTextEditor {
  constructor(input) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (latin1.decode(this.bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Input is not a PDF document");
    this.document = new PdfStructure(this.bytes);
    this.streams = null;
    this.pending = new Map();
    // Matches handed out by the most recent searchText() call, keyed by the opaque id
    // that call returned. Cleared by the next searchText() so a long-lived editor (the
    // browser PoC re-searches on every keystroke) cannot accumulate them without bound.
    this.matches = new Map();
    // Makes a match id from one editor meaningless to another, so a stale id can never
    // silently address a same-shaped run in a different document.
    this.matchNamespace = Math.random().toString(36).slice(2, 10);
    this.matchCounter = 0;
    // Set once an encrypted PDF has been authenticated (see listTextRuns()); null for
    // an unencrypted PDF or one not yet authenticated. Read by replaceText()/save()
    // to enforce /P permissions and by decodeStream() to decrypt stream bytes.
    this.security = null;
  }

  /**
   * `password` is only consulted the first time this resolves (later calls, e.g.
   * from replaceText()/save(), reuse whatever was already authenticated). Defaults
   * to the empty string, so a caller can always try "no password" first -- most
   * PDFs that a normal reader opens without prompting use an empty user password.
   * A failed attempt leaves `this.streams` unset, so calling this again with a real
   * password retries cleanly.
   */
  async listTextRuns(password) {
    if (!this.streams) {
      // The xref table may live in an xref stream, which needs Flate decompression
      // (async) to read. Resolving it here, on first use, keeps the constructor
      // itself synchronous and free of I/O.
      await this.document.ensureXref();
      // The xref table itself is unaffected by encryption, so it resolves either
      // way. Content extraction only continues once (a) the encryption in use is
      // something this engine actually decrypts (Standard/V4/R4/AESV2 or
      // Standard/V5/R6/AESV3 -- anything else throws, non-recoverable, from
      // authenticateEncryptedPdf itself) and (b) the given password authenticates
      // against it (recoverable: a caller can retry with a different password).
      // See src/security/decrypt.js. authenticateEncryptedPdf() is async because
      // revision 6 authentication hashes via crypto.subtle (Algorithm 2.B).
      if (this.document.encryptReference) {
        const security = await authenticateEncryptedPdf(this.document, password ?? "");
        if (!security.authenticated) {
          const summary = summarizeEncryption(security.diagnosis);
          const error = new Error(`Password required to open this encrypted PDF${summary ? ` (${summary})` : ""}`);
          error.encryptionDiagnosis = security.diagnosis;
          error.passwordRequired = true;
          throw error;
        }
        this.security = security;
      }
      this.streams = [];
      const seen = new Set();
      for (const { object, resources } of await this.document.pageContentObjects(this.security, decryptStreamBytes)) {
        // One content stream can be shared by several pages, and /Contents may even
        // list it twice. Run ids are keyed by object number, so scanning it more than
        // once would hand out duplicate ids and append the object twice on save.
        if (seen.has(object.number)) continue;
        seen.add(object.number);
        const decoded = await decodeStream(object, "content stream", this.security);
        const runs = scanTextRuns(decoded, `content stream object ${object.number}`);
        if (runs.length) this.streams.push({ object, decoded, runs, fontMaps: await loadFontMaps(resources, this.document, this.security) });
      }
    }
    return this.streams.flatMap((stream) => stream.runs.map((run, runIndex) => ({
      id: `${stream.object.number}:${runIndex}`,
      objectNumber: stream.object.number,
      textObjectId: run.textObjectId,
      text: decodeWithCMap(run.value, stream.fontMaps.get(run.fontName)),
      fontName: run.fontName,
      bytes: run.value.slice()
    })));
  }

  async replaceText(id, replacement) {
    const runs = await this.listTextRuns();
    // /P's modify permission is checked every call, not just once at open time: it
    // is a property of the PDF, not of this session, so nothing here should ever
    // let a caller stage an edit that permission forbids -- decrypting the content
    // is a reading capability, not an editing one. See README for why owner
    // authentication does not bypass this (it recovers the same file key a user
    // login would, nothing more).
    if (this.security && this.security.modifyAllowed === false) {
      throw new Error("Document modification is not permitted: this PDF's /P permissions disallow content changes (modify permission denied)");
    }
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`Unknown text run: ${id}`);
    this.pending.set(id, encodeReplacement(this, run, replacement));
    return this;
  }

  /**
   * Finds `query` in the text a reader of this PDF actually sees, across the run
   * boundaries the PDF happens to have split that text on.
   *
   * This is the high-level, caller-facing search. A word is very often drawn as several
   * text-showing operands -- "令和6年度" as `[(令) 120 (和) -20 (6) 0 (年) 0 (度)] TJ`
   * is five of them, hence five runs -- so searching the runs of listTextRuns() one by
   * one finds single characters and nothing longer. Runs are joined here instead, but
   * only where the content stream itself says they are consecutive body text: never
   * across content streams, a `BT`/`ET`, a `Td`/`TD`/`Tm`/`T*`, a `'`/`"`, or a font
   * switch (see buildSegments() and scanTextRuns()). Naively concatenating runs would
   * match text drawn in two unrelated places on the page and then rewrite one of them.
   *
   * Returns one entry per occurrence, in document order, each `{ id, text, before,
   * after, runCount, fontName }`. `before`/`after` are up to CONTEXT_RADIUS code points
   * of surrounding text, for telling repeated hits apart. `id` is opaque: pass it back
   * to replaceTextMatch() and do not parse it -- its shape is not part of this API and
   * it is meaningless to any other editor instance. Ids stay valid until the next
   * searchText() call on this editor, which supersedes them.
   *
   * An empty `query` is rejected with `code: "EMPTY_QUERY"` rather than matching every
   * run: a search for nothing is a caller mistake, and answering it with "everything"
   * invites a replace-all against the whole document.
   *
   * `password` is forwarded to listTextRuns() for an encrypted PDF not yet authenticated.
   */
  async searchText(query, password) {
    if (typeof query !== "string") throw searchError("EMPTY_QUERY", "searchText() requires a string query");
    if (query === "") throw searchError("EMPTY_QUERY", "searchText() requires a non-empty query; an empty string matches nothing rather than every text run");
    await this.listTextRuns(password);
    const queryPoints = [...query];
    this.matches.clear();
    const results = [];
    for (const segment of buildSegments(internalRuns(this))) {
      let cursor = 0;
      for (;;) {
        const start = indexOfPoints(segment.points, queryPoints, cursor);
        if (start === -1) break;
        const end = start + queryPoints.length;
        // Every run the match overlaps, with the slice of that run the match covers.
        // charStart/charEnd are code-point offsets into the run's own text, so the
        // characters on either side of the match are known and can be kept (see
        // replaceTextMatch()); a match need not start or end on a run boundary.
        const span = segment.entries
          .filter((entry) => entry.start < end && entry.end > start)
          .map((entry) => ({
            runId: entry.run.id,
            objectNumber: entry.run.objectNumber,
            fontName: entry.run.fontName,
            // Snapshot of the run as it read when this match was found; the staleness
            // check in replaceTextMatch() compares against it.
            runText: entry.run.text,
            charStart: Math.max(0, start - entry.start),
            charEnd: Math.min(entry.end - entry.start, end - entry.start)
          }));
        const id = `${this.matchNamespace}-${this.matchCounter += 1}`;
        const text = segment.points.slice(start, end).join("");
        this.matches.set(id, { id, text, span });
        results.push({
          id,
          text,
          before: segment.points.slice(Math.max(0, start - CONTEXT_RADIUS), start).join(""),
          after: segment.points.slice(end, Math.min(segment.points.length, end + CONTEXT_RADIUS)).join(""),
          // Informational only -- how many text-showing operands this match is drawn
          // as. A caller never needs it to replace the match; the browser PoC shows it.
          runCount: span.length,
          fontName: span[0]?.fontName ?? null
        });
        cursor = end;
      }
    }
    return results;
  }

  /**
   * Whether replaceTextMatch() would accept `replacement` for this match, decided
   * without changing anything. Returns `{ allowed: true, mode }` or `{ allowed: false,
   * code, reason, unsafeReason? }` -- never throws for a refusal, since a caller asking
   * "may I?" is not making a mistake by asking.
   *
   * `mode` names how the replacement would be written: "single-run" (the match sits in
   * one operand, rewritten whole), "same-length" (each operand gets back the characters
   * it contributed), "delete", or "variable-length-safe" (the length changes and the
   * structure permits it -- see planTextMatchReplacement()).
   *
   * This exists so a caller never has to inspect run counts, `TJ` arrays or operators to
   * decide whether an edit is possible: that judgement needs the content stream, and
   * belongs here. It shares planTextMatchReplacement() with replaceTextMatch(), so its
   * verdict is the same verdict -- including the font encoding, which is attempted here
   * too rather than left to surface only at replacement time.
   */
  async checkTextMatchReplacement(matchId, replacement) {
    await this.listTextRuns();
    const plan = planTextMatchReplacement(this, matchId, replacement);
    if (!plan.allowed) {
      const result = { allowed: false, mode: null, code: plan.code, reason: plan.reason };
      return plan.unsafeReason ? { ...result, unsafeReason: plan.unsafeReason } : result;
    }
    return { allowed: true, mode: plan.mode };
  }

  /**
   * Replaces one match from searchText(), across every run it spans, and stages the
   * result for save() -- so a caller never has to know that the match was split into
   * runs at all, nor call replaceText() once per piece.
   *
   * The verdict and the exact bytes both come from planTextMatchReplacement(), the same
   * decision checkTextMatchReplacement() reports; see it for what is allowed and why.
   * In short:
   *
   * - A match inside a single run is rewritten whole, at any length -- unchanged from
   *   v0.2.1, and unaffected by the multi-run rules below.
   * - A multi-run match of equal length is split back onto its original operands by how
   *   many characters each contributed; a deletion empties each operand's share. Both
   *   keep every operand boundary, so both work whatever sits between the operands.
   * - A multi-run match whose length changes is written only when the operands are
   *   joined by zero `TJ` adjustments or by nothing at all: then the whole replacement
   *   goes into the first operand and the rest are emptied, which the PDF draws exactly
   *   as the single-operand replacement above. Any other structure -- a non-zero
   *   adjustment, a `Tc`/`Tw`/`Tz`/`Tr`, colour or marked-content operator in between --
   *   is refused with `code: "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"` rather than
   *   re-spaced, re-flowed or estimated.
   *
   * Prefix and suffix around the match are always preserved. A match whose text has
   * changed since it was found is refused with `code: "MATCH_STALE"` rather than
   * rewriting whatever now sits there. Characters are counted in Unicode code points
   * (`[...text]`), so a surrogate pair counts once; grapheme clusters are not combined.
   *
   * Nothing is staged unless the whole replacement encodes: the updates are built and
   * encoded before any of them is committed, so a character the font cannot express
   * leaves the document untouched instead of half replaced.
   */
  async replaceTextMatch(matchId, replacement) {
    await this.listTextRuns();
    const plan = planTextMatchReplacement(this, matchId, replacement);
    if (!plan.allowed) throw planError(plan);
    for (const { id, bytes } of plan.updates) this.pending.set(id, bytes);
    return this;
  }

  async save() {
    await this.listTextRuns();
    if (!this.pending.size) return this.bytes.slice();
    // Persisting any edit to an encrypted PDF would need to re-encrypt the new
    // content stream bytes (and, per spec, could touch /O, /U, or the trailer's
    // /ID) -- deliberately out of scope for this PR (see README). This is separate
    // from the /P permission check in replaceText(): a modify-allowed encrypted PDF
    // can still stage an edit there, but cannot be saved here, since it is
    // re-encryption support that is missing, not permission.
    if (this.security) {
      throw new Error("Saving edits to an encrypted PDF is not supported yet (re-encryption is out of scope for this PR); this PDF can be searched but not saved.");
    }
    const updates = [];
    for (const stream of this.streams) {
      const replacements = stream.runs.flatMap((_, runIndex) => {
        const bytes = this.pending.get(`${stream.object.number}:${runIndex}`);
        return bytes ? [{ runIndex, bytes }] : [];
      });
      if (!replacements.length) continue;
      let data = replaceTextRuns(stream.decoded, replacements);
      // stream.decoded is already predictor-reversed (see decodeStreamBytes()); the
      // edited bytes are re-deflated as plain FlateDecode without reapplying a
      // predictor. replacementDictionary() drops any /DecodeParms accordingly.
      if (filters(stream.object.dictionary)[0] === "FlateDecode") data = await deflate(data);
      updates.push({ ...stream.object, dictionary: replacementDictionary(stream.object.dictionary, data.length), data });
    }
    const chunks = [this.bytes, encoder.encode(this.bytes.at(-1) === 10 ? "" : "\n")];
    const offsets = [];
    let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    for (const update of updates) {
      const head = encoder.encode(`${update.number} ${update.generation} obj\n${update.dictionary}\nstream\n`);
      const tail = encoder.encode("\nendstream\nendobj\n");
      offsets.push({ number: update.number, generation: update.generation, offset });
      chunks.push(head, update.data, tail);
      offset += head.length + update.data.length + tail.length;
    }
    const xrefOffset = offset;
    chunks.push(encoder.encode("xref\n"));
    offsets.sort((a, b) => a.number - b.number);
    for (const entry of offsets) {
      chunks.push(encoder.encode(`${entry.number} 1\n${String(entry.offset).padStart(10, "0")} ${String(entry.generation).padStart(5, "0")} n \n`));
    }
    chunks.push(encoder.encode(
      `trailer\n<< /Size ${this.document.size} /Root ${this.document.root.number} ${this.document.root.generation} R /Prev ${this.document.previousXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    ));
    return concat(chunks);
  }
}
