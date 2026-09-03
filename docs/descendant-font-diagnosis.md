# `descendant-font-unresolved` を実 PDF で特定する

`22550.pdf` の `/F3` で `令和 → しょ` が `FALLBACK_FONT_METRICS_UNAVAILABLE`
（開発者向け `unsafeReason: descendant-font-unresolved`）になる件の調査記録です。

**現状: 原因未確定。production コードは変更していません（engine は v0.4.2 のまま）。**
この document は「何が分かっていて、次に何を実行すれば確定するか」を残すためのものです。

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

なお、**generation 番号の不一致は原因になりません**。
`PdfStructure#object()` / `#resolveObject()` は object 番号だけで引くため、
generation が違っても解決自体は成功します。
**Object Stream 内にあること自体も原因になりません**（test で確認済み）。

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
    → PDF 9.7.6.2 は `/DescendantFonts` を「font ひとつの array」と定めており、
      複数要素は仕様違反です。どれを使うかは推測になるため fail closed を維持します。

いずれの場合も公開 error code は `FALLBACK_FONT_METRICS_UNAVAILABLE` のままで、
本体 `idontlovepdf` 側が新しい code に対応する必要はありません。
