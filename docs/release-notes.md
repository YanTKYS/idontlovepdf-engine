# Release notes

各versionのリリース内容を新しい順に記載します。H2見出しには、`v`付きversionとGitHub Releaseのtitleを記載します。

## v0.4.0 - Fallback Japanese font

- **元PDFの既存fontに存在しない文字へ置換できるようになりました。** PDFの埋め込みfontは通常subset化されており、`/ToUnicode` にはその文書が実際に使った文字しか載りません。そのため v0.3.0 までは `令和 → しょうわ` のような置換が `FONT_ENCODING_UNSUPPORTED` で失敗していました
- 正式API `await editor.setFallbackFont(fontBytes)` を追加。TrueType fontのbytesを渡すと、**既存fontで書けない文字に限って**そのfontをPDFへ埋め込んで描画します
- 設定すると `checkTextMatchReplacement()` / `replaceTextMatch()` が自動的に判断します。利用側が「通常置換を試して失敗したらfallback API」という二重ロジックを持つ必要はありません。**既存fontで書ける置換は従来どおり**で、fontは埋め込まれません
- **fallback font未設定時の挙動は v0.3.0 と同一**です
- 対応範囲（いずれも `Tj` で描画され、matchの終端位置から他のテキストが描画されない場合）
  - `fallback-font`: run全体の置換。**置換前後の文字数が異なっていても可**
  - `fallback-font-partial`: runの一部だけを置換し、前後は元fontのまま維持（`申請は令和です → 申請はしょうわです`）
  - `fallback-font-multi-run`: 複数runにまたがるmatchを1つとして描画。v0.3.0の隣接判定をそのまま再利用します
- 安全に置換できない構造は明示的に拒否します: `FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE`（matchの終端から後続テキストが描画される）、`FALLBACK_OPERATOR_UNSUPPORTED`（`TJ` / `'` / `"`）、`FALLBACK_MULTI_RUN_UNSUPPORTED`、`FALLBACK_FONT_MISSING_GLYPH`、`FALLBACK_WORD_SPACING_UNSUPPORTED`（`Tw` 有効時に置換文字列が半角スペースを含む。`Tw` は1バイトコード32にしか効かないため、2バイト符号化のfallback fontでは同じ字間にならない）、`FALLBACK_LAYOUT_UNSUPPORTED`、`FALLBACK_FONT_INVALID`
- fallback fontを一度使用した後の `setFallbackFont()` は `FALLBACK_FONT_ALREADY_IN_USE` で拒否します。置換済みテキストはそのfontのglyph IDを保持しているため、別fontへ差し替えると別の文字になってしまうためです
- 置換不能な文字を `error.characters` / `check.characters` として構造化して返します。利用側がCMapやglyphを解釈せずに「この文字は使用できません」と表示できます
- テストと動作確認には **BIZ UDGothic Regular 1.05**（SIL Open Font License 1.1）を使用しています。fontはengineに同梱せず、**呼び出し側がbytesを渡す**方式です。**engineは実行時に一切ネットワークアクセスしません**
- fallbackを使用した保存では、埋め込んだfont全体ぶんファイルサイズが増えます（BIZ UDGothicで約3MB）。subset化は未実施で、1文書内では何回置換してもfontは1つだけ埋め込まれます
- browser bundle（`dist/idontlovepdf-engine.js`）から利用できます。font parserを含むため bundle は約116KB → 約472KBになりました
- v0.3.0の挙動を維持: 検索、同文字数multi-run置換、削除、単一run異文字数置換、`variable-length-safe`、opaque match ID・`MATCH_STALE`・`UNKNOWN_MATCH`、`/P` permission、暗号化PDFの保存制限、incremental update

## v0.3.0 - Safe variable-length multi-run replacement

- **複数runにまたがる一致について、安全性をengineが証明できる構造に限り、置換前後の文字数が異なる置換へ対応**しました。v0.2.1では一律に拒否していたケースの一部が置換できます
- 対応する条件は次の2つを**同時に**満たす場合だけです
  - 対象run間に他のoperator（`Tc`・`Tw`・`Tz`・`Tr`・色指定・marked content等）が一切ないこと
  - 対象run間の`TJ` numeric adjustmentの**合計が0**であること。同一`TJ`配列内（`[(実) 0 (績)] TJ`）に限らず、配列末尾・次の配列先頭・両者の相殺（`[(実) 120] TJ [-120 (績)] TJ`）も同じ字送りとして合計します。隣接operand、`0.0`・`+0`・`-0`等の数値表現も0として扱います
- この条件下では、合計0の調整は文字送りを動かさず、空のstring operandは何も描画せず何も進めないため、描画結果はoperandの連結だけで決まります。したがってreplacement全体を先頭operandへ入れ残りを空にする書き換えは、既存の単一run置換と同一の結果になります
- 事前判定API `await editor.checkTextMatchReplacement(matchId, replacement)` を追加。`{ allowed, mode }` または `{ allowed: false, code, reason, unsafeReason? }` を返します。`mode` は `single-run` / `same-length` / `delete` / `variable-length-safe`。利用側が`runCount`や`TJ`構造を見て可否を判断する必要はありません
- 事前判定と `replaceTextMatch()` は同一の内部replacement planを使うため、「事前判定はallowedだったが実行時に非対応」は発生しません。font encode不能（既存fontに該当glyphがない）も事前判定で検出します
- 上記を満たさない場合（合計が0でない`TJ` adjustment、`Tc`/`Tw`/`Tz`/`Tr`・色指定・marked content等をまたぐ場合）は、引き続き `error.code = "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"` として明示的に拒否します。numeric adjustmentの削除・合算・再配置・再計算、glyph幅からの文字送り計算、text matrix再構成は一切行いません。構造の種別は `unsafeReason`（`non-zero-tj-adjustment` / `text-state-boundary` / `unsupported-topology`）で区別できます
- 置換はatomicです。全runのencodeに成功してから一括で反映するため、途中のencode失敗で一部runだけ書き換わった状態にはなりません
- v0.2.1の挙動を維持: `searchText()` の continuity rule と一致件数、複数run同文字数置換（元のrun境界へ配分する方式）、複数run削除、単一runの異文字数置換、opaque match ID・`MATCH_STALE`・`UNKNOWN_MATCH`、既存の暗号化PDF対応

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
