/**
 * 文字列検索・置換モデル（UX Phase 2）。
 *
 * `PdfTextEditor#listTextRuns()` が返す run は、PDFの描画命令1個に対応する断片で
 * あり、"令和8年度" が "令"/"和"/"8"/"年度" のように複数runへ分かれることがある。
 * このファイルは、それらを人間が検索できる文字列として扱うための純粋関数を提供する。
 * DOMにもNode専用APIにも依存しないため、ブラウザからも `node --test` からも読み込める。
 */

/** 検索結果に添える前後の文脈として表示する文字数。 */
const CONTEXT_RADIUS = 12;

/**
 * runを検索対象の「区間」へ束ねる。
 *
 * 同じcontent stream（`objectNumber`）由来で、かつ同じ`BT ... ET`（`textObjectId`）
 * 由来で、出現順が連続しているrunだけを連結する。`objectNumber`だけで区切ると、同じ
 * content stream内で別の位置へ移動して開始した別の`BT ... ET`（例: ページ上部の
 * "令和8" とページ下部の "年度" が同じstreamに収まっている場合）まで1本の文字列として
 * 連結してしまい、PDF上では無関係な箇所同士が誤って一致してしまう。`textObjectId`は
 * `BT`が現れるたびに採番される（`src/content-stream.js`）ため、これも区切りに使うこと
 * で、別の`BT ... ET`ブロックを跨いだ連結を防ぐ。
 *
 * `listTextRuns()` は content stream ごとにrunをまとめてから並べて返すため（オブジェ
 * クト番号ごとに1回だけ走査する）、同じ`objectNumber`・同じ`textObjectId`のrunは既に
 * 連続しており、いずれかが変わった時点で区切れば境界を跨いだ誤連結は起きない。
 */
function buildSegments(runs) {
  const segments = [];
  let current = null;
  for (const run of runs) {
    if (!current || current.objectNumber !== run.objectNumber || current.textObjectId !== run.textObjectId) {
      current = { objectNumber: run.objectNumber, textObjectId: run.textObjectId, text: "", runOffsets: [] };
      segments.push(current);
    }
    const start = current.text.length;
    current.text += run.text;
    current.runOffsets.push({ run, start, end: current.text.length });
  }
  return segments;
}

/** [start, end) と重なるrunのうち、一致に含まれる部分だけを取り出す。 */
function runSpanFor(segment, start, end) {
  return segment.runOffsets
    .filter((entry) => entry.start < end && entry.end > start)
    .map((entry) => ({
      runId: entry.run.id,
      objectNumber: entry.run.objectNumber,
      fontName: entry.run.fontName,
      runText: entry.run.text,
      charStart: Math.max(0, start - entry.start),
      charEnd: Math.min(entry.run.text.length, end - entry.start)
    }));
}

function contextAround(segmentText, start, end) {
  const beforeStart = Math.max(0, start - CONTEXT_RADIUS);
  const afterEnd = Math.min(segmentText.length, end + CONTEXT_RADIUS);
  return {
    before: (beforeStart > 0 ? "…" : "") + segmentText.slice(beforeStart, start),
    after: segmentText.slice(end, afterEnd) + (afterEnd < segmentText.length ? "…" : "")
  };
}

/**
 * `query` に一致する箇所をすべて返す。空文字列は「検索文字列なし」を表し、`[]` を返す
 * （PDF全体を1件として一致させたりはしない）。一致は区間内で前から非重複に探すため、
 * 同じ文字列が複数回現れる場合はすべて別々の結果になる。
 */
export function findMatches(runs, query) {
  if (!query) return [];
  const segments = buildSegments(runs);
  const matches = [];
  for (const segment of segments) {
    let cursor = 0;
    while (cursor <= segment.text.length - query.length) {
      const index = segment.text.indexOf(query, cursor);
      if (index === -1) break;
      const end = index + query.length;
      const runSpan = runSpanFor(segment, index, end);
      matches.push({
        // A content stream can hold several segments (one per BT ... ET block), so
        // objectNumber alone no longer identifies a segment; textObjectId disambiguates.
        id: `${segment.objectNumber}:${segment.textObjectId}:${index}`,
        objectNumber: segment.objectNumber,
        textObjectId: segment.textObjectId,
        text: segment.text.slice(index, end),
        start: index,
        end,
        runSpan,
        singleRun: runSpan.length === 1,
        context: contextAround(segment.text, index, end)
      });
      cursor = end;
    }
  }
  return matches;
}

/**
 * 一致箇所ごとの、置換前に分かる範囲での置換可否表示。
 * CMap逆引きの可否など、実際に `replaceText()` を試さないと分からないものは含めない
 * （その場合は実行時エラーとして表示する）。
 */
export function matchFeasibility(match) {
  // "構造上" is deliberate: a single run can still fail at replaceText() time (no
  // ToUnicode, no reverse CMap entry, a glyph missing from the existing font). This
  // badge only reports that the match doesn't need the multi-run splitting rule below.
  if (match.singleRun) return { level: "ok", label: "○ 単一run（構造上置換可能）" };
  return {
    level: "conditional",
    label: `△ ${match.runSpan.length}runに分割されています（置換後の文字数が元の一致と同じ場合のみ自動対応）`
  };
}

/**
 * 一致箇所を置換するための、run単位の更新計画を作る。
 *
 * - 単一run内に完全または部分的に収まる一致は、そのrun全体のテキストを
 *   「一致前の部分 + 置換文字列 + 一致後の部分」で置き換える1件の更新にする。
 *   既存の `replaceText()` はrun全体を置き換える方式のため、これで安全に部分置換できる。
 * - 複数runにまたがる一致は、置換後の文字列が元の一致と同じ文字数の場合に限り、
 *   元の各runが一致へ提供していた文字数と同じ割合で置換文字列を分割する。
 *   文字数が異なる場合は、content streamの再構成やレイアウト調整が必要になり本PoCの
 *   範囲を超えるため、明示的に対応不可を返す。
 */
export function planReplacement(match, replacementText) {
  if (match.runSpan.length === 0) return { kind: "unsupported", reason: "no-run" };

  if (match.runSpan.length === 1) {
    const run = match.runSpan[0];
    const newText = run.runText.slice(0, run.charStart) + replacementText + run.runText.slice(run.charEnd);
    return { kind: "single-run", updates: [{ runId: run.runId, newText }] };
  }

  if (replacementText.length !== match.text.length) {
    return { kind: "unsupported", reason: "length-mismatch" };
  }

  let cursor = 0;
  const updates = match.runSpan.map((run) => {
    const contributed = run.charEnd - run.charStart;
    const chunk = replacementText.slice(cursor, cursor + contributed);
    cursor += contributed;
    return { runId: run.runId, newText: run.runText.slice(0, run.charStart) + chunk + run.runText.slice(run.charEnd) };
  });
  return { kind: "multi-run", updates };
}
