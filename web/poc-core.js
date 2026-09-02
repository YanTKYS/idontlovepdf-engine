/**
 * ブラウザPoCの中核処理。
 *
 * このファイルはDOMにもNode専用APIにも依存しないため、ブラウザからも
 * `node --test` からも同じコードを読み込める。DOM操作は web/app.js が担当する。
 * ネットワークアクセス（fetch / XMLHttpRequest / WebSocket）は一切行わない。
 */

// 評価パイプライン（load/extract/writeback/save/reopen）は Node版 CLI と共有する。
// この画面固有なのは「どう見せるか」だけ。
import { STAGES, WRITEBACK_MODE, assessPdfBytes, failedRecord, messageOf, summarize } from "../src/assessment.js";

export { STAGES, WRITEBACK_MODE, assessPdfBytes, failedRecord, messageOf, summarize };

/** assessment.json に必ず含める項目。 */
export const ASSESSMENT_FIELDS = [
  "file",
  "load",
  "extract",
  "writeback",
  "writebackMode",
  "save",
  "reopen",
  "runCount",
  "readerDisplay",
  "error",
  // Present only when extract failed on an encrypted PDF (see src/encryption.js);
  // null otherwise. A short summary, not the full diagnosis, to keep this schema small.
  "encryption"
];

const ERROR_CATEGORIES = [
  { pattern: /object stream/i, label: "object stream解析失敗（/ObjStm・xref streamのtype 2 entry）" },
  { pattern: /cross-reference stream/i, label: "xref stream解析失敗（/W・/Index・stream長など）" },
  { pattern: /predictor/i, label: "Predictor未対応または不正（値・row長・bit depthなど）" },
  {
    pattern: /Password required to open this encrypted PDF/i,
    label: "暗号化PDF（パスワードが必要）",
    detail: (text) => text.match(/Password required to open this encrypted PDF \(([^)]+)\)/)?.[1] ?? null
  },
  { pattern: /modification is not permitted.*modify permission denied/i, label: "暗号化PDF（文書変更が許可されていません／P permission）" },
  { pattern: /Saving edits to an encrypted PDF is not supported/i, label: "暗号化PDF（再暗号化保存は未対応）" },
  { pattern: /Perms validation failed/i, label: "暗号化PDF（/Perms検証失敗。file keyが不正または/Perms自体が破損している可能性）" },
  {
    pattern: /Encrypted PDFs are not supported|\/Encrypt/i,
    label: "暗号化PDF",
    // "Encrypted PDFs are not supported (Standard / AES-128 / R4)" のように、
    // src/encryption.js の診断が付いている場合はその要約を括弧内に添える。
    detail: (text) => text.match(/Encrypted PDFs are not supported \(([^)]+)\)/)?.[1] ?? null
  },
  { pattern: /Unsupported stream filter/i, label: "unsupported filter（未対応の圧縮・符号化）" },
  { pattern: /missing from the xref table|Unsupported non-dictionary PDF object/i, label: "objectがxrefに存在しない（破損の可能性）" },
  { pattern: /no editable text-showing operands/i, label: "本文runなし" },
  { pattern: /single-byte characters/i, label: "ToUnicodeなし（CMap不在のため多バイト文字を書けない）" },
  { pattern: /has no ToUnicode code for/i, label: "CMap逆引き失敗（既存fontにその文字のglyphがない可能性）" },
  { pattern: /Input is not a PDF/i, label: "PDFとして読めない（先頭が%PDF-ではない）" },
  { pattern: /requires the browser (De)?[Cc]ompression[Ss]tream/i, label: "ブラウザのCompressionStream非対応" },
  { pattern: /startxref was not found|Malformed xref entry|xref offset for PDF object/i, label: "xref解析失敗（破損または未対応の構造）" },
  { pattern: /must contain \/Root and \/Size|has no \/Pages reference/i, label: "PDF構造が想定外（Root/Pagesをたどれない）" },
  { pattern: /length does not end at endstream|has no valid \/Length/i, label: "stream長の解析失敗" },
  { pattern: /Unknown text run/i, label: "run IDが存在しない" },
  { pattern: /Malformed PDF (literal string|hex string|dictionary in content stream|array in content stream)/i, label: "content stream解析失敗（文字列トークンまたはdictionary/arrayが壊れている）" },
  { pattern: /Circular \/(Kids|Prev)/i, label: "PDF構造が循環している（破損の可能性）" },
  { pattern: /Maximum call stack size exceeded/i, label: "構造が深すぎる、または循環している" },
  { pattern: /saved PDF contains no editable text runs/i, label: "再読込失敗（保存結果から本文runを取り出せない）" },
  {
    pattern: /separate text runs, so a replacement of/,
    label: "複数runにまたがる一致で、字間調整・書式境界のため文字数を変える置換ができない構造（MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED）",
    // engineが付ける内部診断（non-zero-tj-adjustment / text-state-boundary /
    // unsupported-topology）。PDFの中身そのものではなく構造の種別だけを示す。
    detail: (text) => text.match(/\(((?:non-zero-tj-adjustment|text-state-boundary|unsupported-topology))\)/)?.[1] ?? null
  },
  { pattern: /spans \d+ fonts/, label: "複数fontにまたがる一致のため置換不可（MULTI_RUN_FONT_CHANGE_UNSUPPORTED）" },
  { pattern: /match is stale|This match is stale/, label: "検索結果が古くなっている（対象の文字列が変化したため置換を中止）" },
  { pattern: /Unknown search match/, label: "match IDが無効（検索をやり直してください）" },
  { pattern: /searchText\(\) requires a non-empty query/, label: "検索文字列が空" }
];

/**
 * 既存のエラーメッセージを、人間が読める失敗理由に分類する。
 * 元のメッセージは呼び出し側で必ずそのまま併記すること（握り潰さない）。
 */
export function classifyError(message) {
  if (!message) return null;
  const text = String(message);
  const category = ERROR_CATEGORIES.find((entry) => entry.pattern.test(text));
  if (!category) return "その他のエラー（原文を参照）";
  const detail = category.detail?.(text);
  return detail ? `${category.label}（${detail}）` : category.label;
}

/** `"extract: ..."` 形式のエラー文字列から失敗段階を取り出す。 */
export function stageFromError(error) {
  const stage = String(error ?? "").match(/^([a-z]+):/)?.[1] ?? null;
  return STAGES.includes(stage) ? stage : null;
}

/** エラー文字列から段階名を取り除いた本文を返す。 */
export function errorDetail(error) {
  if (!error) return "";
  const stage = stageFromError(error);
  return stage ? String(error).slice(stage.length + 1).trim() : String(error);
}

/**
 * 各段階の表示状態を返す。
 * true: 成功 / false: この段階で失敗 / null: 未実施
 */
export function stageStatuses(record) {
  const failed = stageFromError(record.error);
  return Object.fromEntries(STAGES.map((stage) => {
    if (record[stage] === true) return [stage, true];
    if (stage === failed) return [stage, false];
    return [stage, null];
  }));
}

/** 表示用の記号と文字ラベル。色だけに頼らないため両方を返す。 */
export function statusText(value) {
  if (value === true) return { mark: "○", label: "成功", state: "ok" };
  if (value === false) return { mark: "×", label: "失敗", state: "ng" };
  return { mark: "-", label: "未実施", state: "skip" };
}

/** 保存ファイル名。`sample.pdf` は `sample.edited.pdf` になる。 */
export function editedFileName(name) {
  const base = String(name || "document").replace(/\.pdf$/i, "");
  return `${base}.edited.pdf`;
}

/** バイト列を16進表示する。limitを超える分は省略する。 */
export function formatHex(bytes, limit = Number.POSITIVE_INFINITY) {
  const all = [...(bytes ?? [])];
  const shown = Number.isFinite(limit) ? all.slice(0, limit) : all;
  const hex = shown.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  if (shown.length < all.length) return `${hex} … (全${all.length}バイト)`;
  return hex || "(空)";
}

/** 制御文字を可視化する。復号できなかった U+FFFD はそのまま残して判別できるようにする。 */
export function displayText(text) {
  if (text === "") return "(空文字列)";
  return String(text).replace(/[\u0000-\u001f\u007f]/g, "\u00b7");
}

/**
 * listTextRuns() の1件を画面表示用に整形する。
 * 復号に失敗していても例外にせず、decodable: false として区別できるようにする。
 */
export function describeRun(run) {
  const text = typeof run.text === "string" ? run.text : "";
  return {
    id: run.id,
    objectNumber: run.objectNumber,
    fontName: run.fontName ?? null,
    text,
    display: displayText(text),
    charCount: [...text].length,
    byteCount: run.bytes?.length ?? 0,
    hexPreview: formatHex(run.bytes, 12),
    hexFull: formatHex(run.bytes),
    // 空のPDF文字列 `()` は「復号できなかった」ではなく本当に空。U+FFFD の有無だけで判定する。
    decodable: !text.includes("�")
  };
}

/** assessment.json 本文を作る。readerDisplay は常に null（人間が別途確認する）。 */
export function toAssessmentJson(records) {
  const results = records.map((record) => Object.fromEntries(ASSESSMENT_FIELDS.map((field) => [field, record[field] ?? null])));
  return `${JSON.stringify({ total: results.length, writebackMode: WRITEBACK_MODE, summary: summarize(records), results }, null, 2)}\n`;
}
