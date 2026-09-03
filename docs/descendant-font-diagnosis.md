# `descendant-font-unresolved` を実 PDF で特定する

`22550.pdf` の `/F3` で `令和 → しょ` が `FALLBACK_FONT_METRICS_UNAVAILABLE`
（開発者向け `unsafeReason: descendant-font-unresolved`）になっていた件の調査記録と、
v0.4.3 での解決内容です。

**解決済み（v0.4.3）。** 原因は `/DescendantFonts` が PDF 仕様の許す別の書き方
（CIDFont dictionary を array の中に直接書く inline dictionary）で書かれており、
v0.4.2 までの parser がその書き方を読めなかったことでした。詳細は下記
「原因が確定した: inline dictionary」を参照してください。`22550.pdf` での
`令和 → しょ` は GitHub Actions の `Diagnose real PDF font metrics` workflow
（`run_edit_test: true`）で実際に成功を確認しています。

なお、診断過程で発見した `/DescendantFonts` の direct / indirect 非対称
（direct array に複数要素があるときだけ先頭を採用して計測していた問題）は、
v0.4.2 の時点で production の `resolveDescendantFont()` を変更して安全側へ統一済みです。
詳細は下記「複数要素の扱い」を参照してください。

## 原因が確定した: inline dictionary

GitHub Actions の `Diagnose real PDF font metrics` workflow で `22550.pdf` を
実際に取得し、`/F3` の `/DescendantFonts` の生の値を確認したところ、次の形でした。

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

`/DescendantFonts [7 0 R]` のような indirect reference ではなく、array の
1 要素（PDF 9.7.6.2 が定める「要素 1 つの array」のその 1 つ）が CIDFont
dictionary そのものとして直接書かれています。v0.4.2 までの
`parseReferenceArray()` は `/DescendantFonts [ ... ]` の `[` `]` の間を
reference 用の正規表現でまるごと検索していたため、この inline dictionary
**の内部**にある `/Ordering 20 0 R`・`/Registry 21 0 R`・`/FontBBox 22 0 R`・
`/StemV 23 0 R`・`/FontFile2 24 0 R`・`/W 25 0 R` という 6 つの reference を、
すべて `/DescendantFonts` の array 要素であるかのように誤認していました。
その結果 `targets.length > 1` となり、実際には要素 1 つの合法な array を
「要素 6 つの仕様違反」と誤判定して `descendant-font-unresolved` を返して
いました。**PDF に font metrics が存在しない問題ではなく、存在する
`/W 25 0 R` に engine が到達できていなかっただけです。**

v0.4.3 では `src/pdf-dictionary-text.js` に `topLevelArrayElements()` を追加し、
array の要素を「値の境界を理解した上で 1 つずつ」読むようにしました。
これは新しい PDF parser ではなく、同ファイルの `topLevelValueOffset()` が
key/value を読むのに使っている `skipOneValue()`（dictionary は
`content-stream.js` の `skipDictionary()`、array は同 `skipArray()` に委譲）を
そのまま array の要素区切りにも使う形です。nested dictionary の内部にある
reference は `skipOneValue()` が dictionary ごと 1 つの値として読み飛ばすため、
array 自身の要素として数えられることはありません。`resolveDescendantFont()`
はこれを使って要素数を確認し、要素が 1 つで、それが dictionary であれば
そのまま CIDFont dictionary として、reference であれば従来どおり resolver へ
渡します。要素が 0 個・2 個以上、reference と dictionary の混在、
CIDFontType0/2 以外の inline dictionary は、従来どおり
`FALLBACK_FONT_METRICS_UNAVAILABLE`（fail closed）です。

## なぜ v0.4.2 の時点では確定できなかったか

v0.4.2 開発時点では、開発環境の egress policy が `www.city.itoman.lg.jp` への
接続を拒否しており、`22550.pdf` を取得できませんでした（`example.com` も同様に
403 だったため、対象サイト固有の問題ではなく外向き通信全体の制限でした）。

実構造を見ずに「`/DescendantFonts` 対応を一般化する」実装へ進むことはしませんでした。
どの hop で失敗しているか分からないまま parser を広げると、
「解決できないものを解決できたことにする」変更になり得るためです。
v0.4.3 では GitHub Actions の manual workflow から実際に `22550.pdf` を
取得できる状態になっており、上記の通り実構造を確認した上で対応しました。

## v0.4.3 が `/DescendantFonts` をどう辿るか

`resolveDescendantFont()`（`src/font-metrics.js`）が扱うのは次の 3 形です。

```text
/DescendantFonts [7 0 R]          → 7 を CIDFont dictionary として読む

/DescendantFonts 11 0 R           → 11 を解決し、それが [7 0 R] という
11 0 obj                            「参照ひとつだけの array」であれば
[7 0 R]                             7 を CIDFont dictionary として読む
endobj

/DescendantFonts [ << ... >> ]    → array の要素（1 つだけ）が dictionary
                                     そのものであれば、そのまま CIDFont
                                     dictionary として読む（v0.4.3 で追加）
```

間接参照を辿るのは 1 段までで、それ以上は評価しません。
`descendant-font-unresolved` になり得る箇所は次の 4 つです。

1. `topLevelArrayElements()`（direct array の場合）/ `reference()`（indirect の場合）が
   `/DescendantFonts` から要素を 1 つも取り出せない
2. array の要素、または間接参照先が解決できない（xref に無い、offset が不正、
   Object Stream の展開に失敗、reference でも dictionary でもない、など）
3. 間接参照が指す先が dictionary でも array でもない
4. array の要素が 1 つだけではない（0 個・2 個以上・reference と dictionary の混在）

### 複数要素の扱い

`/DescendantFonts` は PDF 9.7.6.2 で「要素ひとつの array」と定められています。
複数要素はいずれも仕様違反であり、どれを使うかは file に書かれていないため、
**direct / indirect のどちらの書き方でも拒否します**（4 に該当）。
以前は direct array のときだけ先頭要素を採用して計測していましたが、
これは「最初に見つかった CIDFont を使う」推測にあたるため取り除きました。
writer がどちらの書き方を選んだかで、計測するか拒否するかが変わってはいけません。

### 原因から除外できるもの

**generation 番号の不一致は原因になりません**。
`PdfStructure#object()` / `#resolveObject()` は object 番号だけで引くため、
generation が違っても解決自体は成功します。
これは以前からの挙動で本件の原因ではありませんが、
fail closed を原則とする engine としては後日の安全性レビュー対象です（本 document の範囲外）。
**Object Stream 内にあること自体も原因になりません**（test で確認済み）。

## ローカル環境を用意しない場合

ローカルへ Node.js の依存関係を構築しなくても、GitHub Actions の
`Diagnose real PDF font metrics`（`.github/workflows/diagnose-real-pdf.yml`）
を手動実行すれば、GitHub-hosted runner 上で同じ診断を実行できます。
GitHub の Actions タブから `workflow_dispatch` で実行し、PDF URL・検索文字・font 名を
指定してください（初期値はこの `22550.pdf` の調査用です）。結果は job log にそのまま出力されます。
通常の push/PR CI（`ci.yml`）とは分離されており、通常の CI では実行されません。

## 実行してほしい診断コマンド

```bash
curl -L -o /tmp/22550.pdf https://www.city.itoman.lg.jp/uploaded/attachment/22550.pdf
node scripts/diagnose-font-metrics.js /tmp/22550.pdf --font F3 --text 令和
```

`22550.pdf` は repository に commit しないでください（fixture にもしません）。
CLI は読み取り専用で、ネットワークアクセスは一切しません。

出力の `/DescendantFonts walk` が、上の 1〜4 のどれで止まったかを示します。
この trace は幅計測が呼ぶ `resolveDescendantFont()` 自身が記録するので、
診断用の別実装が本番と食い違うことはありません。

```text
/F3  (object <n> <g> R, content stream <n>)
  xref        regular object at offset <n>, generation <g>   ← または in object stream <n> at index <i>
  /Subtype    /Type0
  /BaseFont   ...
  /Encoding   ...
  /DescendantFonts walk (resolveDescendantFont(), the same one the widths use):
    entry written as direct-array | indirect-reference | absent
      raw       "/DescendantFonts ..."        ← dictionary が書いている生の値
      parsed    <n> <g> R                     ← array 要素のうち reference だったものだけ
    inline-dictionary: the array's own element is a dictionary, not a reference to one
      value     ...                            ← array の要素そのもの（dictionary の場合のみ出力）
    resolve-first-reference: <n> <g> R -> dictionary | array | stream | number-or-boolean | unresolved
      xref      ...
      error     ...                            ← 解決に失敗した場合のみ
      value     ...                            ← 実際に返ってきた object の中身
    array element: matched | DID NOT MATCH
      inner     ...                            ← indirect array object の中身そのもの
    resolve-nested-reference: <n> <g> R -> ...
  descendant font (object <n> | inline dictionary, no object of its own): /Subtype /CIDSystemInfo /CIDToGIDMap /DW /W
  VERDICT     ...
```

`inline-dictionary` の hop は、array の要素が dictionary だった場合にのみ現れます
（このとき `resolve-first-reference` 以降の hop は現れません — 解決すべき参照が
そもそも無いためです）。要素が reference だった場合は従来どおり
`resolve-first-reference` から始まり、必要なら `resolve-nested-reference` まで進みます。

## 判断の分かれ目（v0.4.3 時点）

- **1〜3 で止まった場合**（参照先が無い・型が違う）
  → PDF 自身の情報だけでは CIDFont へ到達できないため、fail closed を維持します。
- **4 で止まった場合**（array の要素が 1 つだけではない）
  → 仕様違反であり、どれを使うかは推測になるため fail closed を維持します
    （direct / indirect いずれの書き方でも、reference と dictionary の混在でも同じ扱いです）。
- **`inline-dictionary` まで進んだが `VERDICT` が widths readable にならない場合**
  → その inline dictionary 自体の問題です（`/Subtype` が CIDFontType0/2 でない
    → `unsupported-cid-font`、`/W` が読めない → `w-unresolved` / `invalid-width-array`
    など）。array 構造の問題ではないため、`/DescendantFonts` を疑う必要はありません。

いずれの場合も公開 error code は `FALLBACK_FONT_METRICS_UNAVAILABLE` のままで、
本体 `idontlovepdf` 側が新しい code に対応する必要はありません。

## 実 PDF での確認結果（v0.4.3）

GitHub Actions の `Diagnose real PDF font metrics` workflow を `run_edit_test: true`
で実行し、`22550.pdf` に対して次を確認しました（PDF 自体は取得のたびに破棄され、
commit・cache・workflow artifact のいずれにも残していません）。

- `searchText("令和")`: 34 件
- 先頭の match（`令和8年度 ...`）を `setFallbackFont()` + `checkTextMatchReplacement()`
  で確認 → `{ allowed: true, mode: "fallback-font-multi-run" }`
- `replaceTextMatch()` → `save()` → 新しい `PdfTextEditor` で reopen →
  `searchText("しょ")` 1 件、`searchText("令和")` 33 件（34 → 33、置換した 1 件分だけ減少）
- 同じ箇所の `令和 → 平成`（fallback 経路を通らない既存 font での置換）も
  `{ allowed: true, mode: "same-length" }` で成功（回帰確認）
- 置換後に続く `8年度 糸満市放...` の描画位置を、engine と無関係な実装である
  pdfminer.six で独立に読み取り、置換前後で座標が一致すること（dx = 0, dy = 0）を確認
- `qpdf --check` が置換前後どちらのファイルでも exit code 0（構造エラーなし）
- 置換後の PDF を Chromium 本体の PDF viewer（Playwright 経由）で開き、
  page error が 0 件であることを確認

詳しい手順は `scripts/verify-real-pdf-edit.js`・`scripts/verify-real-pdf-position.py`・
`scripts/verify-real-pdf-viewer.js` と、それらを呼び出す
`.github/workflows/diagnose-real-pdf.yml` の `run_edit_test` 入力を参照してください。
