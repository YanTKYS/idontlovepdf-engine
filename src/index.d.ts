export interface PdfTextRun {
  readonly id: string;
  readonly objectNumber: number;
  /** Index of the enclosing `BT ... ET` block within its content stream, counted from 0. */
  readonly textObjectId: number;
  readonly fontName: string | null;
  readonly text: string;
  readonly bytes: Uint8Array;
}

export class PdfTextEditor {
  constructor(input: ArrayBuffer | Uint8Array);
  listTextRuns(): Promise<PdfTextRun[]>;
  replaceText(id: string, replacement: string | Uint8Array): Promise<this>;
  save(): Promise<Uint8Array>;
}
