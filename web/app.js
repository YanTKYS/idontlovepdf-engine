/**
 * ブラウザPoCの画面制御。
 *
 * 判定ロジックは web/poc-core.js、PDF処理は ../src/ の自作モジュールが行う。
 * このファイルはDOM操作とファイル入出力だけを担当する。
 * fetch / XMLHttpRequest / WebSocket は使わない。選択されたPDFは端末外へ出ない。
 */

import { PdfTextEditor } from "../src/index.js";
import {
  STAGES,
  WRITEBACK_MODE,
  assessPdfBytes,
  classifyError,
  describeRun,
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

const single = { name: null, bytes: null, runs: [], selectedId: null };

function renderRunRow(run) {
  const detail = describeRun(run);
  const row = element("tr");

  const radio = element("input", {
    attributes: { type: "radio", name: "selected-run", value: detail.id, "aria-label": `run ${detail.id} を選択` }
  });
  radio.addEventListener("change", () => selectRun(detail));
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

function selectRun(detail) {
  single.selectedId = detail.id;
  const target = $("replace-target");
  clear(target);
  target.append(element("p", { text: `選択中のrun: ${detail.id}（object ${detail.objectNumber} / font ${detail.fontName ?? "なし"}）` }));
  target.append(element("p", { text: `元テキスト: ${detail.display}` }));
  if (!detail.decodable) {
    target.append(element("p", { className: "warn", text: "このrunはUnicodeへ完全に復号できていません。置換結果の確認には特に注意してください。" }));
  }
  $("replace-input").disabled = false;
  $("replace-run").disabled = false;
  // 選択し直したら必ずそのrunの元テキストに戻す。前のrunの文字列が残っていると、
  // 気づかないまま別のrunをその文字列で置換してしまう。
  $("replace-input").value = detail.text;
}

function resetSingleReplaceUi() {
  single.selectedId = null;
  const target = $("replace-target");
  clear(target);
  target.append(element("p", { text: "run一覧から1件選択してください。" }));
  $("replace-input").value = "";
  $("replace-input").disabled = true;
  $("replace-run").disabled = true;
  hide($("replace-error"));
  hide($("replace-result"));
}

async function handleSingleFile(file) {
  single.name = file.name;
  single.bytes = null;
  single.runs = [];
  resetSingleReplaceUi();
  hide($("single-error"));
  clear($("run-body"));
  $("run-section").hidden = true;

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

  let editor;
  try {
    editor = new PdfTextEditor(bytes);
  } catch (error) {
    hide(summary);
    showError($("single-error"), { title: `${file.name}: PDFとして読み込めませんでした`, error, stage: "load" });
    return;
  }

  let runs;
  try {
    runs = await editor.listTextRuns();
  } catch (error) {
    hide(summary);
    showError($("single-error"), { title: `${file.name}: 本文runを抽出できませんでした`, error, stage: "extract" });
    return;
  }

  single.bytes = bytes;
  single.runs = runs;

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
    summary.append(element("p", { className: "warn", text: "本文runが0件です。テキストが画像化されている、または本PoCが解釈できない構造の可能性があります。" }));
  }

  const body = $("run-body");
  clear(body);
  for (const run of runs) body.append(renderRunRow(run));
  $("run-section").hidden = runs.length === 0;
}

async function runReplacement() {
  hide($("replace-error"));
  hide($("replace-result"));
  const id = single.selectedId;
  const replacement = $("replace-input").value;
  if (!id || !single.bytes) return;

  // 置換のたびに元bytesの複製から新しいeditorを作る。元データには一切書き込まない。
  let output;
  try {
    const editor = new PdfTextEditor(single.bytes.slice());
    await editor.replaceText(id, replacement);
    output = await editor.save();
  } catch (error) {
    const stage = /Unknown text run|ToUnicode|single-byte/.test(messageOf(error)) ? "replace" : "save";
    showError($("replace-error"), { title: "置換または保存に失敗しました", error, stage });
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
  result.append(element("p", { text: `run ${id} を incremental update として追記しました（${output.length.toLocaleString("ja-JP")} バイト）。元のPDFファイルは変更していません。` }));
  result.append(element("p", { className: "warn", text: "保存できたことと、Acrobat Reader等で意図どおり表示されることは別です。保存したPDFを独立したreaderで必ず確認してください。" }));
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
  resetSingleReplaceUi();

  setupDropZone($("single-drop"), $("single-input"), (files) => {
    void handleSingleFile(files[0]);
  });
  setupDropZone($("multi-drop"), $("multi-input"), (files) => {
    void handleCorpusFiles(files);
  }, { multiple: true });

  $("replace-run").addEventListener("click", () => {
    void runReplacement();
  });
  $("download-json").addEventListener("click", () => {
    const json = toAssessmentJson(corpus.entries.map((entry) => entry.record));
    saveLocally(new TextEncoder().encode(json), "assessment.json", "application/json");
  });
  $("clear-corpus").addEventListener("click", clearCorpus);

  $("writeback-mode").textContent = WRITEBACK_MODE;
}

main();
