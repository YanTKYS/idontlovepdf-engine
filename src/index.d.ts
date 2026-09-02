/** The engine's version, synced from package.json's "version" at build time (see scripts/sync-version.js). */
export const ENGINE_VERSION: string;

/**
 * One text-showing operand of a content stream: a low-level piece of the document, not
 * a word. A word a reader sees is very often drawn as several of these -- use
 * PdfTextEditor#searchText() to work with text as it reads.
 */
export interface PdfTextRun {
  readonly id: string;
  readonly objectNumber: number;
  /** Index of the enclosing `BT ... ET` block within its content stream, counted from 0. */
  readonly textObjectId: number;
  readonly fontName: string | null;
  readonly text: string;
  readonly bytes: Uint8Array;
}

/** One occurrence of a searchText() query, as returned to the caller. */
export interface PdfTextMatch {
  /**
   * Opaque handle for replaceTextMatch(). Its shape is not part of this API: do not
   * parse it, store it across saves, or pass it to a different PdfTextEditor. Ids stay
   * valid until the next searchText() call on the same editor.
   */
  readonly id: string;
  /** The matched text itself. */
  readonly text: string;
  /** Up to 12 code points of text immediately before the match, within the same string. */
  readonly before: string;
  /** Up to 12 code points of text immediately after the match, within the same string. */
  readonly after: string;
  /** How many text runs the match is drawn as. Informational; 1 means it sits in one run. */
  readonly runCount: number;
  /** The font the matched text is drawn in, when the PDF names one. */
  readonly fontName: string | null;
}

/** Stable `code` values carried by the errors searchText()/replaceTextMatch() throw. */
export type PdfTextEditorErrorCode =
  | "EMPTY_QUERY"
  | "UNKNOWN_MATCH"
  | "MATCH_STALE"
  | "REPLACEMENT_NOT_A_STRING"
  | "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"
  | "MULTI_RUN_FONT_CHANGE_UNSUPPORTED";

export class PdfTextEditor {
  constructor(input: ArrayBuffer | Uint8Array);

  /* ---------------------------------------------------------------- high-level API */

  /**
   * Finds every occurrence of `query` in the text the PDF actually shows, joining the
   * runs the content stream says are consecutive body text -- and never joining across
   * a content stream, a `BT`/`ET`, a `Td`/`TD`/`Tm`/`T*`, a `'`/`"`, or a font switch.
   * Rejects an empty query with `code: "EMPTY_QUERY"`.
   */
  searchText(query: string, password?: string): Promise<PdfTextMatch[]>;

  /**
   * Replaces one match from searchText(), across every run it spans, and stages it for
   * save(). An empty `replacement` deletes the matched text. Throws with a stable
   * `code` (see PdfTextEditorErrorCode) when the match no longer describes the current
   * document, or when a multi-run replacement cannot be written safely.
   */
  replaceTextMatch(matchId: string, replacement: string): Promise<this>;

  /* ----------------------------------------------------------------- low-level API */

  listTextRuns(password?: string): Promise<PdfTextRun[]>;
  replaceText(id: string, replacement: string | Uint8Array): Promise<this>;

  save(): Promise<Uint8Array>;
}
