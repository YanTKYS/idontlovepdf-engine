# `descendant-font-unresolved` を実 PDF で特定する

`22550.pdf` の `/F3` で `令和 → しょ` が `FALLBACK_FONT_METRICS_UNAVAILABLE`
（開発者向け `unsafeReason: descendant-font-unresolved`）になる件の調査記録です。

**現状: 原因未確定。`22550.pdf` に対する対応範囲の拡張は行っていません（engine は v0.4.2 のまま）。**
この document は「何が分かっていて、次に何を実行すれば確定するか」を残すためのものです。

なお、診断過程で発見した `/DescendantFonts` の direct / indirect 非対称
（direct array に複数要素があるときだけ先頭を採用して計測していた問題）は、
production の `resolveDescendantFont()` を変更して安全側へ統一しました。
対応範囲を**狭める**修正であり、`22550.pdf` の件を解決するものではありません。
詳細は下記「複数要素の扱い」を参照してください。

## なぜ engine 側で確定できなかったか

開発環境の egress policy が `www.city.itoman.lg.jp` への接続を拒否するため
（`example.com` も同様に 403 なので、対象サイト固有の問題ではなく外向き通信全体の制限です）、
`22550.pdf` を取得できませんでした。

実構造を見ずに「`/DescendantFonts` 対応を一般化する」実装へ進むことはしていません。
どの hop で失敗しているか分からないまま parser を広げると、
「解決できないものを解決できたことにする」変更になり得るためです。

## v0.4.2 が `/DescendantFonts` をどう辿るか

`resolveDescendantFont()`（`src/font-metrics.js`）が扱うのは次の 2 形だけです。

```text
/DescendantFonts [7 0 R]          → 7 を CIDFont dictionary として読む

/DescendantFonts 11 0 R           → 11 を解決し、それが [7 0 R] という
11 0 obj                            「参照ひとつだけの array」であれば
[7 0 R]                             7 を CIDFont dictionary として読む
endobj
```

間接参照を辿るのは 1 段までで、それ以上は評価しません。
`descendant-font-unresolved` になり得る箇所は次の 4 つです。

1. `parseReferenceArray()` が `/DescendantFonts` から参照を 1 つも取り出せない
2. 最初の参照が解決できない（xref に無い、offset が不正、Object Stream の展開に失敗 など）
3. 解決できたが dictionary でも array でもない
4. array だが中身が `<num> <gen> R` ひとつ**だけ**ではない

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
      parsed    <n> <g> R
    resolve-first-reference: <n> <g> R -> dictionary | array | stream | number-or-boolean | unresolved
      xref      ...
      error     ...                            ← 解決に失敗した場合のみ
      value     ...                            ← 実際に返ってきた object の中身
    array element: matched | DID NOT MATCH
      inner     ...                            ← array の中身そのもの
    resolve-nested-reference: <n> <g> R -> ...
  descendant font (object <n>): /Subtype /CIDSystemInfo /CIDToGIDMap /DW /W
  VERDICT     ...
```

## 判断の分かれ目

- **1〜3 で止まった場合**（参照先が無い・型が違う）
  → PDF 自身の情報だけでは CIDFont へ到達できないため、fail closed を維持します。
- **4 で止まった場合**（array の中身が読めない）
  → 中身次第です。
  - comment や複数の whitespace を含むだけで、参照は 1 つ
    → 現行の `^\s*(\d+)\s+(\d+)\s+R\s*$` が合法な array syntax を取りこぼしています。
      既存の PDF token parser を使う小さな修正で安全に解決できます（v0.4.3 候補）。
  - 参照が複数ある
    → 仕様違反であり、どれを使うかは推測になるため fail closed を維持します
      （direct / indirect いずれの書き方でも同じ扱いです）。

いずれの場合も公開 error code は `FALLBACK_FONT_METRICS_UNAVAILABLE` のままで、
本体 `idontlovepdf` 側が新しい code に対応する必要はありません。
