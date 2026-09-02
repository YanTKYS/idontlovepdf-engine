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

/**
 * Stable `code` values carried by the errors searchText()/replaceTextMatch() throw, and
 * reported by checkTextMatchReplacement() without throwing.
 */
export type PdfTextEditorErrorCode =
  | "EMPTY_QUERY"
  | "UNKNOWN_MATCH"
  | "MATCH_STALE"
  | "REPLACEMENT_NOT_A_STRING"
  | "MODIFICATION_NOT_PERMITTED"
  | "FONT_ENCODING_UNSUPPORTED"
  | "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"
  | "MULTI_RUN_FONT_CHANGE_UNSUPPORTED";

/** How replaceTextMatch() would write a replacement that is allowed. */
export type TextMatchReplacementMode =
  /** The match sits in one text run, which is rewritten whole -- any length. */
  | "single-run"
  /** Multi-run, same character count: each run gets back the characters it contributed. */
  | "same-length"
  /** Multi-run deletion: each run gives up only its own share of the match. */
  | "delete"
  /**
   * Multi-run, different character count, written because the operands are joined only
   * by zero `TJ` adjustments or by nothing at all: the whole replacement goes into the
   * first operand and the rest are emptied, which the PDF draws identically.
   */
  | "variable-length-safe";

/**
 * Why a length-changing multi-run replacement could not be written safely. Secondary
 * detail alongside `MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED`; describes the structure only,
 * never the document's content.
 */
export type TextMatchReplacementObstacle =
  /** A non-zero `TJ` adjustment sits between two of the match's operands. */
  | "non-zero-tj-adjustment"
  /** A `Tc`/`Tw`/`Tz`/`Tr`, colour, or marked-content operator sits between them. */
  | "text-state-boundary"
  /** The match's runs are not attached to each other in a shape this version knows. */
  | "unsupported-topology";

/** What checkTextMatchReplacement() reports. */
export type TextMatchReplacementCheck =
  | { readonly allowed: true; readonly mode: TextMatchReplacementMode }
  | {
      readonly allowed: false;
      readonly mode: null;
      readonly code: PdfTextEditorErrorCode;
      readonly reason: string;
      readonly unsafeReason?: TextMatchReplacementObstacle;
    };

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
   * Whether replaceTextMatch() would accept `replacement` for this match, decided
   * without changing anything and without throwing for a refusal. Shares its decision
   * with replaceTextMatch(), so "allowed" here is never refused there.
   *
   * Use this instead of inspecting `runCount`: whether a length change is possible
   * depends on the content stream, not on how many runs the match spans.
   */
  checkTextMatchReplacement(matchId: string, replacement: string): Promise<TextMatchReplacementCheck>;

  /**
   * Replaces one match from searchText(), across every run it spans, and stages it for
   * save(). An empty `replacement` deletes the matched text. Throws with a stable
   * `code` (see PdfTextEditorErrorCode) when the match no longer describes the current
   * document, or when a multi-run replacement cannot be written safely. A length change
   * across several runs is written only where the structure makes it provably safe --
   * see TextMatchReplacementMode and checkTextMatchReplacement().
   */
  replaceTextMatch(matchId: string, replacement: string): Promise<this>;

  /* ----------------------------------------------------------------- low-level API */

  listTextRuns(password?: string): Promise<PdfTextRun[]>;
  replaceText(id: string, replacement: string | Uint8Array): Promise<this>;

  save(): Promise<Uint8Array>;
}
