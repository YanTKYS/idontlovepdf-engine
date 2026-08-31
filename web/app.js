/**
 * ブラウザPoCの画面制御。
 *
 * 判定ロジックは web/poc-core.js、検索・置換モデルは web/text-search.js、
 * PDF処理は ../src/ の自作モジュールが行う。このファイルはDOM操作とファイル入出力
 * だけを担当する。fetch / XMLHttpRequest / WebSocket は使わない。
 * 選択されたPDFは端末外へ出ない（プレビューもBlob URLでこのブラウザ内に閉じる）。
 */

import { PdfTextEditor } from "../src/index.js";
import { summarizeEncryption } from "../src/encryption.js";
import {
  STAGES,
  WRITEBACK_MODE,
  assessPdfBytes,
  classifyError,
  describeRun,
  displayText,
  editedFileName,
  errorDetail,
  failedRecord,
  messageOf,
  stageFromError,
  stageStatuses,
  statusText,
  summarize,
  toAssessmentJson
} from "./poc-core.js";
import { findMatches, matchFeasibility, planReplacement } from "./text-search.js";

const $ = (id) => document.getElementById(id);

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  for (const [key, value] of Object.entries(options.attributes ?? {})) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}

/**
 * ローカル保存。Blob URLはこのブラウザ内だけで有効で、通信は発生しない。
 */
function saveLocally(bytes, filename, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = element("a", { attributes: { href: url, download: filename } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/** 失敗内容を、原文・分類・「元PDFは無変更」の順で表示する。 */
function showError(container, { title, error, stage = null, keepsOriginal = true }) {
  clear(container);
  container.hidden = false;
  container.append(element("p", { className: "error-title", text: `× 失敗: ${title}` }));
  if (stage) container.append(element("p", { text: `失敗した段階: ${stage}` }));
  container.append(element("p", { text: `推定される原因: ${classifyError(messageOf(error))}` }));
  container.append(element("p", { className: "error-raw", text: `エラー内容（原文）: ${messageOf(error)}` }));
  if (keepsOriginal) {
    container.append(element("p", { text: "選択した元のPDFファイルは変更されていません。書き換えは常に新しいデータへ行い、保存操作をした場合のみ別ファイルとして出力します。" }));
  }
}

function hide(node) {
  node.hidden = true;
  clear(node);
}

function statusChip(value) {
  const status = statusText(value);
  return element("span", { className: `chip chip-${status.state}`, text: `${status.mark} ${status.label}` });
}

function setupDropZone(zone, input, onFiles, { multiple = false } = {}) {
  zone.addEventListener("click", (event) => {
    if (event.target !== input) input.click();
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });
  input.addEventListener("change", () => {
    const files = [...input.files];
    // 同じファイルを続けて選ぶと change が発火しないため、毎回選択状態を捨てる。
    input.value = "";
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });
}

/* ------------------------------------------------------------------ タブ */

function setupTabs() {
  const tabs = [
    { button: $("tab-single"), panel: $("panel-single") },
    { button: $("tab-multi"), panel: $("panel-multi") }
  ];
  for (const tab of tabs) {
    tab.button.addEventListener("click", () => {
      for (const other of tabs) {
        const active = other === tab;
        other.button.classList.toggle("active", active);
        other.button.setAttribute("aria-selected", String(active));
        other.panel.hidden = !active;
      }
    });
  }
}

/* -------------------------------------------------- 機能1・2: 単一PDF検証 */

// password is kept in memory only, for the lifetime of the currently loaded PDF --
// never persisted (no localStorage/sessionStorage), never sent anywhere, and reset
// on every new file selection. It exists purely so that a fresh PdfTextEditor
// built for replace/save (see runMatchReplacement()/runDebugReplacement()) can
// re-authenticate without asking the user to type the password again.
const single = { name: null, bytes: null, runs: [], previewUrl: null, debugSelectedId: null, password: undefined, modifyBlocked: false };
const search = { query: "", matches: [], selectedId: null };

/* --------------------------------------------------------- PDFプレビュー */

function showPreview(bytes) {
  revokePreview();
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  single.previewUrl = url;
  const frame = $("pdf-preview");
  frame.hidden = false;
  frame.src = url;
}

function revokePreview() {
  if (single.previewUrl) {
    URL.revokeObjectURL(single.previewUrl);
    single.previewUrl = null;
  }
  const frame = $("pdf-preview");
  frame.hidden = true;
  frame.removeAttribute("src");
}

/* ------------------------------------------------------ 暗号化PDFの診断表示 */
/*
 * error.encryptionDiagnosis (src/encryption.js の analyzeEncryption() の戻り値) を
 * 画面向けに整形するだけ。復号やパスワード検証は一切行わない。
 * 「確定できる情報」（Encrypt dictionaryの記載）と「推定」（V/R/CFMからの推測）は
 * 見出しを分け、混同されないようにする。
 */

const PERMISSION_LABELS = {
  print: "印刷",
  modify: "文書変更",
  copy: "内容コピー",
  annotate: "注釈",
  fillForms: "フォーム入力",
  extractForAccessibility: "アクセシビリティ抽出",
  assembleDocument: "文書構成変更",
  printHighQuality: "高品質印刷"
};

function permissionLine(name, value) {
  if (value === null) return `${PERMISSION_LABELS[name]}: 該当なし（/R 2 には定義がない項目）`;
  return `${PERMISSION_LABELS[name]}: ${value ? "許可されている" : "制限されている"}`;
}

/**
 * Encrypt dictionary直下の /Length（bit単位）の表示。/V 1・2 以外で /Length が
 * 省略されている場合、実際の鍵長はCrypt Filter（/CF）側が決めるため、仕様上の
 * 既定値40bitを当てはめると誤り（例: AES-128を40bit RC4のように見せてしまう）。
 * そのため「明記」「仕様上の既定値」「不明・Crypt Filter側で決まる」を区別する。
 */
function lengthBitsLine(diagnosis) {
  if (diagnosis.lengthBitsSource === "explicit") return `${diagnosis.lengthBits} bit`;
  if (diagnosis.lengthBitsSource === "default") return `${diagnosis.lengthBits} bit（/Length省略時の仕様上の既定値）`;
  return "未指定（/CF側の鍵長を参照。下記Crypt Filterを参照）";
}

function dl(rows) {
  const node = element("dl");
  for (const [label, value] of rows) node.append(element("dt", { text: label }), element("dd", { text: String(value) }));
  return node;
}

/** 通常ユーザー向けの構造化された診断ブロック。単なる赤いエラー表示の代わりに使う。 */
function renderEncryptionDiagnosis(container, diagnosis) {
  clear(container);
  container.hidden = false;
  container.append(element("p", { className: "error-title", text: "暗号化PDFを検出しました（診断のみ・復号や編集は行いません）" }));

  if (!diagnosis.standardHandler) {
    container.append(element("h4", { text: "確定できる情報（Encrypt dictionaryの記載）" }));
    container.append(dl([
      ["Filter", diagnosis.filter ?? "不明"],
      ["SubFilter", diagnosis.subFilter ?? "(なし)"]
    ]));
    container.append(element("p", { text: "Standard Security Handler以外（例: 公開鍵方式の /Adobe.PubSec）のため、これ以上の項目は解釈しません（診断のみ対応）。" }));
    container.append(element("p", { text: "パスワード状態: 未判定 / PoC対象外。このPoCはパスワードの検証・復号を一切行いません。" }));
    return;
  }

  container.append(element("h4", { text: "確定できる情報（Encrypt dictionaryの記載）" }));
  container.append(dl([
    ["Security Handler", "Standard"],
    ["V（バージョン）", diagnosis.version ?? "不明"],
    ["R（リビジョン）", diagnosis.revision ?? "不明"],
    ["Length（Encrypt辞書直下、bit単位）", lengthBitsLine(diagnosis)],
    ["EncryptMetadata", diagnosis.encryptMetadata === null ? "不明" : (diagnosis.encryptMetadata ? "true（メタデータも暗号化）" : "false（メタデータは平文）")]
  ]));

  if (diagnosis.cryptFilters.length) {
    container.append(element("h4", { text: "Crypt Filter（/CF）" }));
    const list = element("ul");
    for (const filter of diagnosis.cryptFilters) {
      const role = [
        filter.name === diagnosis.streamFilter ? "stream用" : null,
        filter.name === diagnosis.stringFilter ? "string用" : null
      ].filter(Boolean).join("・");
      // Crypt Filterの /Length は bytes 単位（Encrypt辞書直下の /Length とは単位が異なる）。
      const lengthText = filter.lengthBytes === null ? "不明" : `${filter.lengthBytes} bytes（${filter.lengthBits} bit）`;
      list.append(element("li", {
        text: `${filter.name}${role ? `（${role}）` : ""}: CFM=${filter.method ?? "不明"}（${filter.methodLabel ?? "不明"}） / Length=${lengthText} / AuthEvent=${filter.authEvent ?? "(なし)"}`
      }));
    }
    container.append(list);
  }

  container.append(element("h4", { text: "推定される暗号化方式（推定・参考情報）" }));
  container.append(element("p", { className: "estimate", text: diagnosis.estimatedMethod ?? "V / R / CFM の組み合わせからは推定できませんでした" }));

  container.append(element("h4", { text: "権限 /P（確定できる情報。復号・制限解除は行いません）" }));
  if (diagnosis.permissions) {
    const list = element("ul");
    for (const name of Object.keys(PERMISSION_LABELS)) list.append(element("li", { text: permissionLine(name, diagnosis.permissions[name]) }));
    container.append(list);
  } else {
    container.append(element("p", { text: "/P を解析できませんでした。" }));
  }

  container.append(element("h4", { text: "パスワード状態" }));
  container.append(element("p", {
    text: "未判定 / PoC対象外。このPoCはパスワードの検証・復号を一切行わないため判定できません。他の閲覧ソフトで開けたことは「パスワードなし」を意味しません。"
  }));
}

/** デバッグ用: Encrypt objectそのものの内部値。「詳細・デバッグ情報」の中だけに表示する。 */
function renderEncryptionDebug(container, diagnosis, encryptReference) {
  clear(container);
  container.hidden = false;
  container.append(element("h3", { text: "暗号化診断の内部情報" }));
  container.append(dl([
    ["Encrypt object", encryptReference ? `${encryptReference.number} ${encryptReference.generation} R` : "(不明)"],
    ["Filter", diagnosis.filter ?? "(なし)"],
    ["SubFilter", diagnosis.subFilter ?? "(なし)"],
    ["standardHandler", String(diagnosis.standardHandler)],
    ["V", String(diagnosis.version)],
    ["R", String(diagnosis.revision)],
    ["Length（Encrypt辞書直下, bit, raw）", `${diagnosis.lengthBits} (source: ${diagnosis.lengthBitsSource})`],
    ["StmF", diagnosis.streamFilter ?? "(なし)"],
    ["StrF", diagnosis.stringFilter ?? "(なし)"],
    ["EFF", diagnosis.encryptFileFilter ?? "(なし)"],
    ["EncryptMetadata（raw）", String(diagnosis.encryptMetadata)],
    ["P（raw）", String(diagnosis.permissionsRaw)]
  ]));
  const json = element("pre", { className: "mono", text: JSON.stringify(diagnosis, null, 2) });
  container.append(json);
}

/**
 * Shown once an encrypted PDF has actually been authenticated (see
 * src/security/decrypt.js) -- distinct from renderEncryptionDiagnosis() above,
 * which is for a PDF this engine only diagnoses (out of scope, or not yet
 * authenticated). Authentication and /P's modify permission are reported as two
 * separate facts on purpose: recovering the file key is a reading capability,
 * never grounds on its own for allowing edits -- see README.
 */
function renderEncryptionAuthenticated(container, security, passwordWasEntered) {
  clear(container);
  container.hidden = false;
  container.append(element("p", { className: "ok-title", text: "暗号化PDF（認証・復号に成功しました）" }));

  container.append(element("h4", { text: "方式" }));
  container.append(element("p", { text: summarizeEncryption(security.diagnosis) ?? "不明" }));

  container.append(element("h4", { text: "認証" }));
  const authLabel = security.authType === "owner"
    ? "○ owner passwordで認証成功"
    : `○ ${passwordWasEntered ? "入力された" : "空の"}user passwordで認証成功`;
  container.append(element("p", { text: authLabel }));

  container.append(element("h4", { text: "権限" }));
  const list = element("ul");
  list.append(element("li", { text: "閲覧・検索: 利用可能" }));
  list.append(element("li", {
    text: security.modifyAllowed ? "文書変更: 許可されています（/P上）" : "文書変更: 制限されています（/P上、このPoCでは置換を拒否します）"
  }));
  container.append(list);
  if (security.modifyAllowed) {
    container.append(element("p", { className: "warn", text: "/P上は文書変更が許可されていますが、暗号化PDFの再暗号化保存自体が未対応のため、このPoCでは保存できません（置換の一時的な確認のみ可能です）。" }));
  }
}

/**
 * The minimal password prompt for an encrypted PDF that needs one (see
 * src/pdf-document.js's `passwordRequired` error). The password never leaves this
 * function except as an in-memory argument to `onSubmit`: not logged, not put in
 * the URL, not written to localStorage/sessionStorage, not included in any error
 * text (see showError()/classifyError(), which only ever echo the engine's own
 * error message -- never user input).
 */
function renderPasswordPrompt(container, diagnosis, onSubmit) {
  clear(container);
  container.hidden = false;
  container.append(element("p", { className: "error-title", text: "暗号化PDF（パスワードが必要です）" }));
  container.append(element("p", { text: `方式: ${summarizeEncryption(diagnosis) ?? "不明"}` }));
  container.append(element("p", { text: "認証: × パスワードが必要です" }));
  container.append(element("p", { className: "sub", text: "入力したパスワードは送信・保存されません。このブラウザ内だけで認証に使い、画面を離れると破棄されます。" }));

  const input = element("input", {
    attributes: { type: "password", id: "encryption-password-input", placeholder: "パスワード", autocomplete: "off" }
  });
  const button = element("button", { text: "認証", attributes: { type: "button" } });
  const submit = () => onSubmit(input.value);
  button.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
  const actions = element("div", { className: "actions" });
  actions.append(input, button);
  container.append(actions);
  input.focus();
}

/* ------------------------------------------------------- デバッグ: run一覧 */

function renderRunRow(run) {
  const detail = describeRun(run);
  const row = element("tr");

  const radio = element("input", {
    attributes: { type: "radio", name: "selected-run", value: detail.id, "aria-label": `run ${detail.id} を選択` }
  });
  radio.addEventListener("change", () => selectDebugRun(detail));
  row.append(element("td", {}, [radio]));

  row.append(element("td", { className: "mono", text: detail.id }));
  row.append(element("td", { className: "mono num", text: String(detail.objectNumber) }));
  row.append(element("td", { className: "mono", text: detail.fontName ?? "(なし)" }));

  const textCell = element("td", { className: "run-text" }, [element("span", { text: detail.display })]);
  if (!detail.decodable) {
    textCell.append(element("span", { className: "chip chip-warn", text: "復号不可を含む" }));
  }
  row.append(textCell);

  row.append(element("td", { className: "num", text: String(detail.charCount) }));
  row.append(element("td", { className: "num", text: String(detail.byteCount) }));

  const bytesCell = element("td", { className: "mono bytes" });
  const preview = element("span", { text: detail.hexPreview });
  bytesCell.append(preview);
  if (detail.hexFull !== detail.hexPreview) {
    const toggle = element("button", { className: "link", text: "詳細", attributes: { type: "button" } });
    let expanded = false;
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      preview.textContent = expanded ? detail.hexFull : detail.hexPreview;
      toggle.textContent = expanded ? "簡略" : "詳細";
    });
    bytesCell.append(toggle);
  }
  row.append(bytesCell);
  return row;
}

function selectDebugRun(detail) {
  single.debugSelectedId = detail.id;
  const target = $("debug-replace-target");
  clear(target);
  target.append(element("p", { text: `選択中のrun: ${detail.id}（object ${detail.objectNumber} / font ${detail.fontName ?? "なし"}）` }));
  target.append(element("p", { text: `元テキスト: ${detail.display}` }));
  if (!detail.decodable) {
    target.append(element("p", { className: "warn", text: "このrunはUnicodeへ完全に復号できていません。置換結果の確認には特に注意してください。" }));
  }
  $("debug-replace-input").disabled = false;
  $("debug-replace-run").disabled = false;
  $("debug-replace-input").value = detail.text;
}

function resetDebugReplaceUi() {
  single.debugSelectedId = null;
  const target = $("debug-replace-target");
  clear(target);
  target.append(element("p", { text: "run一覧から1件選択してください。" }));
  $("debug-replace-input").value = "";
  $("debug-replace-input").disabled = true;
  $("debug-replace-run").disabled = true;
  hide($("debug-replace-error"));
  hide($("debug-replace-result"));
}

async function runDebugReplacement() {
  hide($("debug-replace-error"));
  hide($("debug-replace-result"));
  const id = single.debugSelectedId;
  const replacement = $("debug-replace-input").value;
  if (!id || !single.bytes) return;

  let output;
  try {
    const editor = new PdfTextEditor(single.bytes.slice());
    // Re-authenticates with the same password the initial load already verified
    // (see attemptLoad()) -- this is a fresh PdfTextEditor instance, so it has not
    // authenticated yet. A no-op for an unencrypted PDF.
    await editor.listTextRuns(single.password);
    await editor.replaceText(id, replacement);
    output = await editor.save();
  } catch (error) {
    const stage = /Unknown text run|ToUnicode|single-byte|modification is not permitted/.test(messageOf(error)) ? "replace" : "save";
    showError($("debug-replace-error"), { title: "置換または保存に失敗しました", error, stage });
    return;
  }

  try {
    const reopened = await new PdfTextEditor(output).listTextRuns();
    if (reopened.length === 0) throw new Error("saved PDF contains no editable text runs");
  } catch (error) {
    showError($("debug-replace-error"), { title: "保存後PDFの再読込に失敗しました", error, stage: "reopen" });
    return;
  }

  const filename = editedFileName(single.name);
  try {
    saveLocally(output, filename);
  } catch (error) {
    showError($("debug-replace-error"), { title: "編集済みPDFのローカル保存に失敗しました", error, stage: "save" });
    return;
  }

  const result = $("debug-replace-result");
  clear(result);
  result.hidden = false;
  result.append(element("p", { className: "ok-title", text: `○ 成功: ${filename} をローカルへ保存しました。` }));
  result.append(element("p", { text: `run ${id} を incremental update として追記しました（${output.length.toLocaleString("ja-JP")} バイト）。元のPDFファイルは変更していません。` }));
  result.append(element("p", { className: "warn", text: "保存できたことと、Acrobat Reader等で意図どおり表示されることは別です。保存したPDFを独立したreaderで必ず確認してください。" }));
}

/* --------------------------------------------------------------- 検索・置換 */

function matchLabel(match) {
  return `${displayText(match.context.before)}${displayText(match.text)}${displayText(match.context.after)}`;
}

function renderSearchResults() {
  const container = $("search-results");
  clear(container);
  const summary = $("search-summary");

  if (single.runs.length === 0) {
    summary.textContent = "本文runが0件のため検索できません。";
    return;
  }
  if (!search.query) {
    summary.textContent = "検索文字列を入力してください。";
    return;
  }
  summary.textContent = `検索結果: ${search.matches.length} 件`;

  search.matches.forEach((match, index) => {
    const feasibility = matchFeasibility(match);
    const row = element("div", { className: "match-row" });
    const label = element("label", { attributes: { for: `match-${index}` } });

    const radio = element("input", {
      attributes: { type: "radio", name: "selected-match", value: match.id, id: `match-${index}` }
    });
    radio.addEventListener("change", () => selectMatch(match));
    label.append(radio);

    const body = element("div", { className: "match-body" });
    body.append(element("span", { className: `chip chip-${feasibility.level === "ok" ? "ok" : "warn"}`, text: feasibility.label }));
    body.append(element("span", { className: "match-context", text: `${index + 1}. ${matchLabel(match)}` }));
    body.append(element("span", {
      className: "sub mono",
      text: `run: ${match.runSpan.map((r) => r.runId).join(" → ")}（${match.runSpan.length}run構成）`
    }));
    label.append(body);
    row.append(label);
    container.append(row);
  });
}

function runSearch(query) {
  search.query = query;
  search.matches = query ? findMatches(single.runs, query) : [];
  search.selectedId = null;
  renderSearchResults();
  resetMatchReplaceUi();
}

function selectMatch(match) {
  search.selectedId = match.id;
  hide($("replace-error"));
  hide($("replace-result"));

  const detail = $("match-detail");
  clear(detail);
  detail.hidden = false;
  detail.append(element("p", { text: `選択中の一致: ${displayText(match.text)}` }));
  detail.append(element("p", {
    className: "sub mono",
    text: `run: ${match.runSpan.map((r) => r.runId).join(" → ")}（${match.runSpan.length}run構成）`
  }));
  const feasibility = matchFeasibility(match);
  detail.append(element("p", { text: feasibility.label }));
  if (!match.singleRun) {
    detail.append(element("p", {
      className: "sub",
      text: "複数runにまたがる一致です。置換後の文字数が元の一致（" + match.text.length + "文字）と完全に同じ場合のみ自動で置換します。異なる場合は「現在のPoCでは置換不可」と表示します。"
    }));
  }

  if (single.modifyBlocked) {
    detail.append(element("p", { className: "warn", text: "このPDFでは文書変更が許可されていません（/P permission）。置換は実行できません。" }));
    $("replace-input").disabled = true;
    $("replace-run").disabled = true;
    return;
  }
  $("replace-input").disabled = false;
  $("replace-input").value = match.text;
  $("replace-run").disabled = false;
}

function resetMatchReplaceUi() {
  search.selectedId = null;
  hide($("match-detail"));
  $("replace-input").value = "";
  $("replace-input").disabled = true;
  $("replace-run").disabled = true;
  hide($("replace-error"));
  hide($("replace-result"));
}

async function runMatchReplacement() {
  hide($("replace-error"));
  hide($("replace-result"));
  const match = search.matches.find((candidate) => candidate.id === search.selectedId);
  const replacementText = $("replace-input").value;
  if (!match || !single.bytes) return;

  const plan = planReplacement(match, replacementText);
  if (plan.kind === "unsupported") {
    const detail = plan.reason === "length-mismatch"
      ? `複数run（${match.runSpan.length}run）にまたがる一致のため、置換後の文字数（${replacementText.length}）が元の一致の文字数（${match.text.length}）と異なる自動置換には対応していません。`
      : "この一致箇所は現在のPoCでは置換できません。";
    showError($("replace-error"), { title: "この一致箇所は現在のPoCでは置換不可です", error: detail, stage: "replace" });
    return;
  }

  // 置換のたびに元bytesの複製から新しいeditorを作る。元データには一切書き込まない。
  let output;
  try {
    const editor = new PdfTextEditor(single.bytes.slice());
    // 新しいeditorインスタンスは未認証のため、読込時に確認済みの同じパスワードで
    // 再認証する（暗号化PDFでない場合は無視される）。selectMatch()側で/P上
    // 文書変更が許可されていないPDFは置換UI自体を無効化しているが、ここでも
    // replaceText()自身のpermissionチェックにより二重に拒否される。
    await editor.listTextRuns(single.password);
    for (const update of plan.updates) await editor.replaceText(update.runId, update.newText);
    output = await editor.save();
  } catch (error) {
    const stage = /Unknown text run|ToUnicode|single-byte|modification is not permitted/.test(messageOf(error)) ? "replace" : "save";
    showError($("replace-error"), { title: "置換または保存に失敗しました", error, stage });
    return;
  }

  // 保存結果を再度読み込めることを確認してからダウンロードする。
  try {
    const reopened = await new PdfTextEditor(output).listTextRuns();
    if (reopened.length === 0) throw new Error("saved PDF contains no editable text runs");
  } catch (error) {
    showError($("replace-error"), { title: "保存後PDFの再読込に失敗しました", error, stage: "reopen" });
    return;
  }

  const filename = editedFileName(single.name);
  try {
    saveLocally(output, filename);
  } catch (error) {
    showError($("replace-error"), { title: "編集済みPDFのローカル保存に失敗しました", error, stage: "save" });
    return;
  }

  const result = $("replace-result");
  clear(result);
  result.hidden = false;
  result.append(element("p", { className: "ok-title", text: `○ 成功: ${filename} をローカルへ保存しました。` }));
  result.append(element("p", {
    text: `${plan.updates.length}件のrunを更新し、保存後PDFの再読込を確認してから incremental update として追記しました（${output.length.toLocaleString("ja-JP")} バイト）。元のPDFファイルは変更していません。`
  }));
  result.append(element("p", { className: "warn", text: "保存できたことと、Acrobat Reader等で意図どおり表示されることは別です。保存したPDFを独立したreaderで必ず確認してください。" }));
}

/* --------------------------------------------------------------- PDF読込 */

/**
 * The load/extract half of handleSingleFile(), split out so it can run again with
 * a different password when the first (empty-password) attempt reports
 * `passwordRequired` -- see renderPasswordPrompt(). `password` is `undefined` on
 * the very first call, which listTextRuns() treats as "try the empty password".
 */
async function attemptLoad(file, editor, password, passwordWasEntered) {
  const summary = $("single-summary");
  let runs;
  try {
    runs = await editor.listTextRuns(password);
  } catch (error) {
    hide(summary);
    const diagnosis = error.encryptionDiagnosis;
    if (error.passwordRequired) {
      // Recoverable: this encryption is within scope, just needs a (different)
      // password. Keep the file's own preview/summary state intact so the user
      // isn't staring at a blank screen while they try again.
      renderPasswordPrompt($("encryption-password-section"), diagnosis, (entered) => {
        void attemptLoad(file, editor, entered, true);
      });
      return;
    }
    hide($("encryption-password-section"));
    if (diagnosis?.encrypted) {
      // Out of this PR's decryption scope (not Standard/V4/R4/AESV2), or missing
      // /O//U/ID -- no password will fix this, so show the read-only diagnosis
      // instead of a password prompt. The raw error message is still shown
      // via showError() (never hidden), alongside the structured breakdown.
      showError($("single-error"), { title: `${file.name}: 暗号化PDFのため本文を抽出できません`, error, stage: "extract" });
      renderEncryptionDiagnosis($("single-encryption"), diagnosis);
      renderEncryptionDebug($("debug-encryption"), diagnosis, editor.document.encryptReference);
    } else {
      showError($("single-error"), { title: `${file.name}: 本文runを抽出できませんでした`, error, stage: "extract" });
    }
    return;
  }

  hide($("encryption-password-section"));
  hide($("single-error"));
  single.password = password;
  single.runs = runs;

  if (editor.security) {
    renderEncryptionAuthenticated($("single-encryption"), editor.security, passwordWasEntered);
    renderEncryptionDebug($("debug-encryption"), editor.security.diagnosis, editor.document.encryptReference);
  } else {
    hide($("single-encryption"));
    hide($("debug-encryption"));
  }

  clear(summary);
  const undecodable = runs.filter((run) => !describeRun(run).decodable).length;
  summary.append(element("p", {}, [
    element("strong", { text: file.name }),
    element("span", { text: `（${file.size.toLocaleString("ja-JP")} バイト）` })
  ]));
  const status = element("p", { className: "status-line" });
  status.append(element("span", { text: "load: " }), statusChip(true));
  status.append(element("span", { text: " extract: " }), statusChip(runs.length > 0));
  status.append(element("span", { text: ` 本文run: ${runs.length} 件` }));
  if (undecodable) status.append(element("span", { className: "warn", text: ` / 復号不可を含むrun: ${undecodable} 件` }));
  summary.append(status);
  if (runs.length === 0) {
    summary.append(element("p", { className: "warn", text: "本文runが0件です。テキストが画像化されている、または本PoCが解釈できない構造の可能性があります。検索・置換は利用できません。" }));
  }

  const body = $("run-body");
  clear(body);
  for (const run of runs) body.append(renderRunRow(run));

  $("search-section").hidden = false;
  $("search-input").disabled = runs.length === 0;
  // Search always works once runs are extracted -- authentication is a reading
  // capability. Only the replace UI (gated in selectMatch(), see below) is blocked
  // on /P's modify permission.
  single.modifyBlocked = editor.security?.modifyAllowed === false;
  if (single.modifyBlocked) {
    const notice = $("replace-permission-notice");
    notice.hidden = false;
    notice.textContent = "このPDFでは文書変更が許可されていません（/P permission）。検索はできますが、置換・保存はできません。";
  } else {
    hide($("replace-permission-notice"));
  }
  runSearch("");
}

async function handleSingleFile(file) {
  single.name = file.name;
  single.bytes = null;
  single.runs = [];
  single.password = undefined;
  hide($("single-error"));
  hide($("single-encryption"));
  hide($("debug-encryption"));
  hide($("encryption-password-section"));
  clear($("run-body"));
  revokePreview();
  $("editor-grid").hidden = true;
  $("preview-section").hidden = true;
  $("search-section").hidden = true;
  $("search-input").value = "";
  $("search-input").disabled = true;
  runSearch("");
  resetDebugReplaceUi();

  const summary = $("single-summary");
  clear(summary);
  summary.hidden = false;
  summary.append(element("p", { text: `読込中: ${file.name}（${file.size.toLocaleString("ja-JP")} バイト）` }));

  let bytes;
  try {
    bytes = await readBytes(file);
  } catch (error) {
    hide(summary);
    showError($("single-error"), { title: `${file.name}: ファイルの読み取りに失敗しました`, error, stage: "load" });
    return;
  }

  // editor-gridとプレビューは、この自作エンジンの解析結果とは独立に、読み取れた
  // bytesがあれば表示する。エンジンが本文runを抽出できないPDF（暗号化PDF含む）でも、
  // 目視確認の助けになる。
  $("editor-grid").hidden = false;
  $("preview-section").hidden = false;
  try {
    showPreview(bytes);
  } catch {
    // Blob/URL.createObjectURLが使えない環境でも、検索・置換自体は継続できる。
    // preview-section自体（説明文）は表示したまま、iframeだけ非表示にする。
    revokePreview();
  }

  let editor;
  try {
    editor = new PdfTextEditor(bytes);
  } catch (error) {
    hide(summary);
    showError($("single-error"), { title: `${file.name}: PDFとして読み込めませんでした`, error, stage: "load" });
    return;
  }

  single.bytes = bytes;
  await attemptLoad(file, editor, undefined, false);
}

/* -------------------------------------------- 機能3: 複数PDFの一括互換性評価 */

const corpus = { entries: [], running: false };

function assessmentRow(entry) {
  const { record, output } = entry;
  const statuses = stageStatuses(record);
  const row = element("tr");
  row.append(element("td", { className: "filename", text: record.file }));
  for (const stage of STAGES) row.append(element("td", {}, [statusChip(statuses[stage])]));
  row.append(element("td", { className: "num", text: String(record.runCount) }));

  const errorCell = element("td", { className: "error-cell" });
  if (record.error) {
    errorCell.append(element("div", { text: classifyError(record.error) }));
    errorCell.append(element("div", { className: "error-raw", text: errorDetail(record.error) }));
  } else {
    errorCell.append(element("span", { text: "-" }));
  }
  row.append(errorCell);

  const actionCell = element("td");
  if (output) {
    const button = element("button", { className: "link", text: "編集済PDFを保存", attributes: { type: "button" } });
    button.addEventListener("click", () => saveLocally(output, editedFileName(record.file)));
    actionCell.append(button);
  } else {
    actionCell.append(element("span", { text: "-" }));
  }
  row.append(actionCell);
  return row;
}

function renderCorpusSummary() {
  const records = corpus.entries.map((entry) => entry.record);
  const counts = summarize(records);
  const node = $("multi-summary");
  clear(node);
  node.hidden = records.length === 0;
  node.append(element("p", {
    text: `評価件数: ${records.length} 件 / ` + STAGES.map((stage) => `${stage} ${counts[stage]}`).join(" / ")
  }));
  const failures = records.filter((record) => record.error).length;
  if (failures) {
    const byStage = STAGES
      .map((stage) => [stage, records.filter((record) => stageFromError(record.error) === stage).length])
      .filter(([, count]) => count > 0)
      .map(([stage, count]) => `${stage} ${count}`)
      .join(" / ");
    node.append(element("p", { text: `失敗: ${failures} 件（失敗段階の内訳: ${byStage}）` }));
  }
}

async function handleCorpusFiles(files) {
  const body = $("assess-body");
  const progress = $("multi-progress");
  progress.hidden = false;
  $("assess-section").hidden = false;

  // 評価中の追加投入は結果とprogress表示が混ざるため受け付けない。
  if (corpus.running) {
    progress.textContent = `評価中のため ${files.length} 件は追加しませんでした。完了後にもう一度選択してください。`;
    return;
  }
  corpus.running = true;
  $("clear-corpus").disabled = true;
  try {
    await assessSequentially(files, body, progress);
  } finally {
    corpus.running = false;
  }

  progress.textContent = `評価完了: ${corpus.entries.length} 件（今回 ${files.length} 件を追加）`;
  $("download-json").disabled = corpus.entries.length === 0;
  $("clear-corpus").disabled = corpus.entries.length === 0;
}

/** 1件ずつ評価し、行を追記する。1件ごとに描画へ制御を返して画面が固まらないようにする。 */
async function assessSequentially(files, body, progress) {
  for (const [index, file] of files.entries()) {
    progress.textContent = `評価中 ${index + 1} / ${files.length}: ${file.name}`;
    let entry;
    try {
      entry = await assessPdfBytes(file.name, await readBytes(file));
    } catch (error) {
      // ファイル読み取り自体の失敗など想定外の例外もPoCを止めず、load失敗として記録する。
      entry = { record: failedRecord(file.name, "load", error), output: null };
    }
    corpus.entries.push(entry);
    body.append(assessmentRow(entry));
    renderCorpusSummary();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function clearCorpus() {
  if (corpus.running) return;
  corpus.entries = [];
  clear($("assess-body"));
  hide($("multi-summary"));
  $("multi-progress").textContent = "";
  $("multi-progress").hidden = true;
  $("assess-section").hidden = true;
  $("download-json").disabled = true;
  $("clear-corpus").disabled = true;
  $("multi-input").value = "";
}

/* ------------------------------------------------------------------ 初期化 */

function main() {
  setupTabs();
  resetDebugReplaceUi();
  resetMatchReplaceUi();

  setupDropZone($("single-drop"), $("single-input"), (files) => {
    void handleSingleFile(files[0]);
  });
  setupDropZone($("multi-drop"), $("multi-input"), (files) => {
    void handleCorpusFiles(files);
  }, { multiple: true });

  $("search-input").addEventListener("input", (event) => {
    runSearch(event.target.value);
  });
  $("replace-run").addEventListener("click", () => {
    void runMatchReplacement();
  });
  $("debug-replace-run").addEventListener("click", () => {
    void runDebugReplacement();
  });
  $("download-json").addEventListener("click", () => {
    const json = toAssessmentJson(corpus.entries.map((entry) => entry.record));
    saveLocally(new TextEncoder().encode(json), "assessment.json", "application/json");
  });
  $("clear-corpus").addEventListener("click", clearCorpus);

  $("writeback-mode").textContent = WRITEBACK_MODE;
}

main();
