# Release notes

各versionのリリース内容を新しい順に記載します。H2見出しには、`v`付きversionとGitHub Releaseのtitleを記載します。

## v0.2.1 - Multi-run text search and replace

- **複数text runへ分割された語句の検索へ対応。** PDFは1つの語を複数のtext-showing operandとして描画することがあり（例: `令和6年度` が `[(令) 120 (和) -20 (6) 0 (年) 0 (度)] TJ` の5 operand）、v0.2.0のrun単位検索では1文字しか一致しませんでした
- high-level検索API `await editor.searchText(query)` を追加。利用者が見える文字列としてPDF本文を検索し、`{ id, text, before, after, runCount, fontName }` を一致ごとに返します。`id` はengineが解釈するopaque IDです
- high-level置換API `await editor.replaceTextMatch(matchId, replacement)` を追加。複数runにまたがる一致を1回の呼び出しで置換します。空文字を渡すと一致範囲の削除になります
- `TJ` 配列内のnumeric adjustment（字間調整）を検索の区切りとして扱わないよう変更。連続する `Tj` / `TJ` も同様に1つの文字列として検索できます
- 誤連結を防ぐcontinuity rule を engine 側へ実装。別content stream、別 `BT ... ET`、`Td` / `TD` / `Tm` / `T*`、`'` / `"`、font変更をまたいで検索しません。位置もfontも変えないoperator（`Tc`・`Tw`・`Tz`・`Tr`・`TL`・色指定・marked content）だけが連続とみなされます
- 複数runにまたがる一致で置換前後の文字数が異なる場合は、PDF本来の字間を壊さないため `error.code = "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"` として明示的に拒否します（削除と単一run置換は文字数が異なっても可能）
- 検索時点と現在の文書内容が食い違うmatch IDでの置換を `error.code = "MATCH_STALE"` として拒否します
- v0.2.0の公開API（`new PdfTextEditor(bytes)`・`listTextRuns(password?)`・`replaceText(id, replacement)`・`save()`・`ENGINE_VERSION`）は後方互換のまま維持しています
- 型定義の修正: `listTextRuns(password?: string)` が実装と一致するようになりました。`searchText()`・`replaceTextMatch()`・`PdfTextMatch` も `src/index.d.ts` へ追加しています

## v0.2.0 - Browser library formalization

- browser向けES Module bundleとして`dist/idontlovepdf-engine.js`を正式化
- 正式公開APIを`PdfTextEditor`と`ENGINE_VERSION`に整理
- bundle経由のPDF処理testとbrowser smoke testを追加
- bundleとSHA-256 checksumをGitHub Release assetとして配布
- xref、Object Stream、Predictor、ToUnicode、R4/AESV2、R6/AESV3を含む既存PDF互換機能を維持
