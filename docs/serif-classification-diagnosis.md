# なぜ `22550.pdf` で BIZ UDGothic が選ばれたか

`22550.pdf`（実 PDF; `令和8年度` の `令和`）で v0.5.0 の Serif/Sans 自動選択が
BIZ UD明朝ではなく BIZ UDゴシックを選んでいた件の調査記録と、v0.5.1 での対応内容です。

## 結論（v0.5.1）

**原因が確定しました。** `22550.pdf` の `/F3` は、`/DescendantFonts` の CIDFont
dictionary を array 内に直接書く inline dictionary であること（v0.4.3 で対応済み）に加え、
その CIDFont dictionary 自身の `/FontDescriptor` も **inline dictionary** として書かれています。
v0.5.0 の `classifyFontResource()`（`src/font-classification.js`）はこの構造を判定できず、
`/FontDescriptor` が全く無い場合と区別できないまま `unknown`（→ 常に BIZ UDゴシック）へ
落ちていました。**`/Flags` の値自体に問題はありません** -- engine がそこへ到達できていな
かっただけです。

この inline `/FontDescriptor` という制約は、v0.5.0 のリリースノート自身が「既知の非
blocker」としてすでに記録していたものです（[release-notes.md](release-notes.md) の
v0.5.0 セクション末尾）。今回、実際にこの制約が `22550.pdf` の `/F3` を `unknown` へ
落としていたこと自体を実 PDF で確認し、対応しました。

## 診断の経緯

### ローカル開発環境から `22550.pdf` を直接取得できない

このセッションの egress policy は `www.city.itoman.lg.jp` への接続を拒否します
（`docs/descendant-font-diagnosis.md` に記録した v0.4.2 開発時と同じ制約で、GitHub 関連
ホストへの接続は許可されています）。したがって、実装より先に本物の `22550.pdf` を
このローカル環境から直接診断することはできませんでした。

### それでも実 PDF の構造は既に確定していた

`22550.pdf` の `/F3` は v0.4.3 開発時に GitHub Actions の `Diagnose real PDF font
metrics` workflow（`.github/workflows/diagnose-real-pdf.yml`）で一度、実際に取得・
診断されています。その記録（`docs/descendant-font-diagnosis.md`）には、`/DescendantFonts`
の生の値がそのまま残っていました。

```text
/DescendantFonts [ <<
  /BaseFont /CIDFont+F3
  /CIDSystemInfo << /Ordering 20 0 R /Registry 21 0 R /Supplement 0 >>
  /CIDToGIDMap /Identity
  /FontDescriptor << ... /FontBBox 22 0 R /FontFile2 24 0 R /StemV 23 0 R ... >>
  /Subtype /CIDFontType2
  /W 25 0 R
>> ]
```

`/FontDescriptor` がここでは `12 0 R` のような indirect reference ではなく、CIDFont
dictionary の中に直接 `<< ... >>` として書かれています。`/FontBBox`・`/FontFile2`・
`/StemV` は個別に indirect reference ですが、`/FontDescriptor` という **dictionary
そのもの**は inline です。

v0.5.0 の `fontDescriptorOf()`（`src/font-classification.js`）は次の実装でした。

```js
const indirect = reference(holder, "FontDescriptor");
if (!indirect) return null;
```

`reference()` は `/FontDescriptor N G R` にしか一致しないため、inline dictionary の
場合は常に `null` を返し、「`/FontDescriptor` が全く無い」場合と区別できません。結果として
`classifyFontResource()` は `unknown` を返し、`selectFallbackFont()` は `unknown` を
常に `sans`（BIZ UDゴシック）へフォールバックします。**これは `/Flags` の値を読み違えた
のではなく、`/FontDescriptor` 自体に engine が到達できていなかったということです。**

## v0.5.1 の対応

`src/font-classification.js` の `fontDescriptorOf()` に、`/FontDescriptor` を
indirect reference と inline dictionary の両方から読む分岐を追加しました。

```text
/FontDescriptor 12 0 R          → 従来どおり、12 を resolve する
/FontDescriptor << ... >>       → dictionary そのものをそのまま使う（v0.5.1 で追加）
```

inline dictionary の抜き出しには、`src/encryption.js` が Encrypt dictionary の inline
`/CF` サブ dictionary を読むのに既に使っている `nestedDictionaryText()`
（`src/pdf-dictionary-text.js`）をそのまま再利用しています。新しい PDF parser は
追加していません。`/Flags` 自身の direct/indirect 読み取りは、v0.5.0 から変更のない
`resolvedNumber()`（`src/font-metrics.js`）が引き続き行います。

### 分類理由を構造化した（developer 診断専用）

`classifyFontResource()`（文字列 3 値 `"serif"`/`"sans"`/`"unknown"` を返す既存の
公開シグネチャ）はそのまま維持しつつ、内部で `classifyFontResourceDetailed()` を追加し、
`unknown` になった理由を区別できるようにしました。

```js
{
  classification: "unknown",
  reason: "font-descriptor-missing", // | "font-descriptor-unresolved" | "flags-missing"
                                      // | "flags-unresolved" | "flags-invalid" | "flags-zero"
                                      // | "serif-flag-set" | "serif-flag-not-set"
  fontDescriptor: { form: "inline" | "indirect" | null, object: "N G R" | null, text: "..." | null },
  flags: { value: number | null, serifBit: boolean | null }
}
```

これは通常利用者向けの公開 API・error ではありません。`diagnoseFallbackFontSelection(editor,
matchId)`（`src/pdf-document.js`）が同じ detail を追加のフィールド（`reason`・
`fontDescriptor`・`flags`）として返すようにし、developer 向け診断 CLI
`scripts/diagnose-font-classification.js` から確認できます。

```bash
node scripts/diagnose-font-classification.js 22550.pdf --text 令和
```

`22550.pdf` はリポジトリへ commit していません。ローカル環境でこの PDF を取得できる場合
（または GitHub Actions の `Diagnose real PDF font metrics` workflow 上）でこのコマンドを
実行すると、`classification`・`classificationReason`・`fontDescriptor.form`・
`flags.value`・`flags.serifBit`・埋め込み font program の有無（`/FontFile`・
`/FontFile2`・`/FontFile3`）が確認できます。

### `/Flags` 自体は上書きしていない

v0.5.1 は `/FontDescriptor` へ到達できる経路を広げただけで、`/Flags` の Serif bit の
意味づけは一切変更していません。到達した FontDescriptor が Serif bit を立てていなければ
`sans` のまま、`/Flags` 自体が読めない・0 の場合は引き続き `unknown` → `sans`
（BIZ UDゴシック）です。font 名の文字列辞書、embedded font program（`name` table・
`OS/2`・PANOSE 等）による補助判定は、今回の `22550.pdf` の原因が inline FontDescriptor
そのものだったため追加していません。実 PDF の `/Flags` が Serif bit を立てていない
ケースに遭遇した場合は、優先順位（1. PDF FontDescriptor `/Flags`、2. embedded font
program 自身の標準 metadata、3. 判定不能なら `unknown` → BIZ UDGothic）に従って次の
フェーズで検討します。

## 回帰テスト

`test/font-classification-diagnosis.test.js` に追加しました。

- unit レベル（`classifyFontResourceDetailed()` を直接呼ぶ、fallback font 依存なし、
  常時実行）: `CLASSIFICATION_REASONS` の全 8 種類（`font-descriptor-missing` /
  `font-descriptor-unresolved` / `flags-missing` / `flags-unresolved` / `flags-invalid` /
  `flags-zero` / `serif-flag-set` / `serif-flag-not-set`）と、`22550.pdf` の実構造
  そのもの（Type0 → inline CIDFontType2 → inline FontDescriptor、`/Flags` に Serif bit）
- document レベル（`PdfTextEditor` の public API 経由、`npm run test:font` で取得した
  BIZ UDGothic/BIZ UDMincho が必要 -- 既存 CI が既に取得しているため skip 0 を維持）:
  `22550.pdf` の実構造を再現した fixture（`test/helpers/document-font-inline-descriptor.js`）
  で `令和 → しょ`（serif 選択・BIZ UD明朝埋め込み）・`令和 → 平成`（既存 font 経路、
  fallback font 非埋め込み）・`令和 → しょうわ`（BIZ UD明朝自身の実 glyph 幅で
  再判定、allowed/refused いずれでも整合性を確認）・save → reopen（埋め込んだ
  BIZ UD明朝自身が再度 serif と分類され、再利用されること）・malformed（`/Flags` が
  存在しないオブジェクトを指す dangling indirect reference）が `unknown` へ
  fail closed **ではなく** 現行互換の BIZ UDゴシックへ戻ること

既存の baseline（indirect FontDescriptor + Serif bit → `serif`、indirect + Serif
bit 無し → `sans`、FontDescriptor 無し → `unknown`）は `test/fallback-font-
classification.test.js` が既に確認済みで、今回変更していません。

## 実 PDF での最終確認（確認済み・v0.5.1）

`.github/workflows/diagnose-real-pdf.yml`（既存の manual workflow。新規 workflow は
追加していません）に、Serif/Sans 分類診断のステップ（`scripts/diagnose-font-
classification.js`、常時実行）を追加し、`run_edit_test: true` の編集 smoke test
（`scripts/verify-real-pdf-edit.js`）を `--serif-font`（BIZ UDMincho）対応へ拡張しました。
このセッションからは `22550.pdf` を直接取得できないため（`www.city.itoman.lg.jp` は
このセッションの egress policy で拒否されます）、GitHub Actions 上（GitHub-hosted
runner はこのホストへ到達できます）で実行し、結果を確認しました。

**実行**: `Diagnose real PDF font metrics` workflow を `run_edit_test: true`・
`text: 令和`・`font: F3` で実行（run ID
[33887555829](https://github.com/YanTKYS/idontlovepdf-engine/actions/runs/33887555829)、
branch `claude/biz-ud-gothic-diagnosis-stbt7a`、commit `ac0f723`）。

**`scripts/diagnose-font-classification.js` の出力**（`22550.pdf` の `/F3`、実測）:

```text
sourceFontResource: /F3
subtype: /CIDFontType2
descendantFonts: inline dictionary, no object of its own
fontDescriptor:
  form: inline
  object: (none)
  fontName: /CIDFont+F3
flags:
  value: 6
  serifBit: true
embeddedFont:
  present: true
  type: FontFile2
classification: serif
classificationReason: serif-flag-set
```

**確定した原因**: `/Flags` の値は `6`（Symbolic (4) + Serif (2)）で、Serif bit は
実際に立っていました。v0.5.0 が `unknown`（→ BIZ UDゴシック）へ落ちていたのは `/Flags`
の意味づけの問題ではなく、`/FontDescriptor` 自身が inline dictionary で書かれていたため
到達できていなかったことだけが原因です。上の「原因が確定しました」の節で述べた
inline `/FontDescriptor` 対応により、この値へ正しく到達できるようになりました。

**編集 smoke test**（`scripts/verify-real-pdf-edit.js --serif-font`、`22550.pdf`
本体・`令和8年度` の該当箇所、実測）:

- `diagnoseFallbackFontSelection()`: `classification: "serif"`, `reason:
  "serif-flag-set"`, `fontDescriptor.form: "inline"`, `flags: { value: 6, serifBit:
  true }`, `selectedRole: "serif"`
- `令和 → しょ`: `checkTextMatchReplacement()` → `{ allowed: true, mode:
  "fallback-font-multi-run" }` → `replaceTextMatch()` → `save()` → 保存後 4,562,587
  bytes（元 615,690 bytes、+3,946,897 bytes）→ 埋め込まれた fallback font の
  `BaseFont` は **`BIZUDMincho-Regular`**（`BIZUDGothic` は埋め込まれていません）
- 保存後 reopen → `searchText("しょ")` 1 件、`searchText("令和")` 33 件
  （34 → 33、置換した 1 件分だけ減少）
- 後続テキスト（`8年度 糸満市放...`）の描画位置を pdfminer.six（engine と無関係な実装）
  で独立に確認 → `dx=0.0000 dy=0.0000`（置換前後で位置が変わっていません）
- `qpdf --check` は置換前・置換後どちらも exit code 0（構造エラーなし）
- 置換後の PDF は Chromium 本体の PDF viewer（Playwright 経由）で page error 0 件で開けました
- `令和 → 平成`（既存 font 経路、regression）: `{ allowed: true, mode: "same-length"
  }` で成功。fallback font を経由しないため embed は発生しません
- `令和 → しょうわ`（BIZ UD明朝自身の実 glyph 幅で再判定、v0.4.4 の安全判定）:
  `{ allowed: false, code: "FALLBACK_LAYOUT_UNSUPPORTED", unsafeReason:
  "fallback-replacement-overflows-slot", diagnostics: { replacementAdvance: 4000,
  availableAdvance: 2250 } }` で **拒否**されました（BIZ UD明朝で描画すると後続の `8`
  まで届いてしまうため）。`replaceTextMatch()` も同じ理由で reject され、document は
  変更されていません。v0.4.4 で確立した安全判定は、選ばれた fallback font が
  BIZ UDGothic から BIZ UD明朝へ変わっても、そのまま機能しています

**Go**: `22550.pdf` の実構造から Gothic が選ばれていた理由を確定し、最小 fix を実装、
実 PDF に対して修正後 `serif` 判定・BIZ UD明朝の選択・埋め込み・save/reopen・
後続テキスト位置維持・既存安全判定の維持のすべてを確認しました。

## font subsetting について（対象外）

`令和 → しょ` の fallback 置換で PDF が約 600KB → 約 3.6MB へ増える件は、fallback font
program 全体を埋め込む既存の既知の制約であり、Serif/Sans 判定とは無関係です。今回の
対応では変更していません。独立した PoC として別途検討します。
