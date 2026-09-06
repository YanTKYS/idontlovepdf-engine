# fallback font subsetting PoC (v0.6.0 候補)

`令和 → しょ` のような fallback 置換1回で PDF が数MB膨れる問題 (v0.5.1) に対し、
実際に使用した glyph だけを含む TrueType subset を `/FontFile2` へ埋め込むことで、
容量増加を大幅に抑えられるかを検証した記録です。engine のみを対象とし、
`idontlovepdf` 本体は変更していません。

## 1. 現行実装の把握 (変更前)

`src/fallback-font.js` / `src/pdf-document.js` を確認した結果:

* `parseFallbackFont()` は opentype.js でパースし、TrueType (`glyf`) outline
  であることだけを確認する。subsetting は一切行わず、`buildFallbackFontObjects()`
  が font 全体を deflate して `/FontFile2` へ書く。
* fallback font の識別は **font program 全体の SHA-256** (`fallback.digest`)。
  `FALLBACK_FONT_MARKER` (`/ILPFallbackFont <digest>`) として Type0 dict に書かれ、
  `adoptExistingFallbackFont()` が save → reopen 後にこれを見て「同じ font か」を判定する。
* `/CIDToGIDMap /Identity` が前提: content stream に書く CID は **そのまま元 font の
  glyph ID**。`glyphsFor()` は `font.charToGlyph()` で文字→glyph ID を引くだけで、
  独自の CID 割り当ては一切行っていない。
* `glyphsFromToUnicode()` は ToUnicode CMap の `<code> <unicode>` を
  `code = glyph ID` として読み戻し、save → reopen 後の「既に embed 済みの glyph 集合」
  として使われる。**この読み戻しは code=GID を前提にしているだけで、subsetting の
  有無に関係なく成立する** — これが今回 GID を一切 renumber しない設計を選んだ最大の理由。
* serif/sans は `editor.fallbackFonts` / `editor.fallbackEmbeddings` に role ごと
  (`"sans"` / `"serif"`) に独立管理されており、font program が同一でないことを
  `assertFallbackDigestsDistinct()` が保証している。

この時点で、**「GID を変えない sparse subset」を選べば、save → reopen の認識ロジック
(digest マーカーによる同一性判定、ToUnicode からの既存 glyph 集合読み戻し) 自体は
書き直さずに済む** ことが分かった。ただし後述 (§3・レビュー指摘) のとおり、
`adoptExistingFallbackFont()` は **完全に無変更では済まなかった** ---
`/BaseFont` の secondary check と、既存 `/FontFile2` object 番号の回収の2点は
subset 対応のため実際に修正が必要だった。

## 2. 既存 OSS の調査と不採用の理由

`fontkit` / `@pdf-lib/fontkit` 等、browser 対応の TrueType subsetter を検討した。
これらの subsetter は共通して **glyph ID を詰め直す (renumber)** 設計になっている
(未使用 glyph のスロットを削除して `numGlyphs` を縮める)。理由:

* renumber 後の新旧 GID 対応表を安定して取得・保存できる API がない
  (内部実装であり、公開契約として保証されていない)。
* 1回目の save で `新GID = f(旧GID)` を作った後、2回目の save で新しい文字を
  追加すると `f` 自体が変わりうる (含まれる glyph 集合が変わるので、詰め直し結果も
  変わる) — 1回目に書いた content stream の GID が指す glyph が変わってしまう
  リスクを完全には除去できない。
* このリスクを安全に扱うには「一度 embed した subset の GID 対応表を PDF 側に
  永続化し、次回はそれを見て差分だけ追加する」実装が必要になるが、これは
  事実上 CIDToGIDMap を Identity でなく明示的な mapping に変える設計変更であり、
  今回の「最小 PoC」の範囲を超える。

→ **既存 OSS は不採用**。理由は速度や bundle size ではなく、
「save → reopen → 追加編集で GID の意味が変わらない」という最重要条件を
安全側で証明できなかったため。

## 3. 採用した方式: sparse subset (GID 維持)

`src/font-subset.js` に自前実装した、**GID を一切 renumber しない** 最小 TrueType
subsetter。

* `glyf` / `loca` **以外の全テーブル** (`cmap`, `hmtx`, `post`, `name`, `OS/2`,
  `head`, `hhea`, `maxp`, `GSUB`, `vhea`/`vmtx` 等) は **1バイトも変更せず** コピー。
* `glyf` は「使用する glyph だけ実データを残し、使わない glyph は長さ0にする」
  sparse な作り方。`loca` は元 font と同じ `numGlyphs+1` 個のエントリを常に持つ
  ので、**未使用 glyph も GID としては消えない** (中身が空になるだけ)。
* composite glyph の component は raw `glyf` バイト列を自前でパース
  (`readCompositeComponents()`) し、再帰的に必要 glyph 集合へ展開
  (`expandGlyphSet()`)。2つの composite が同じ component を共有する場合 (diamond)
  は正しく1回だけ展開するが、真の循環参照 (ある glyph が自分自身を composite
  経由で再度参照する) は `FONT_SUBSET_INVALID` として例外を投げ、安全に
  full-font embedding へフォールバックする (「訪問中」と「展開済み」を明示的な
  stack で区別することで判定)。
* `.notdef` (GID 0) は常に含める。
* table checksum と `head.checkSumAdjustment` は TrueType 仕様どおりに再計算
  (`writeSfnt()`)。`head` 自身の directory checksum は
  「checkSumAdjustment=0 として計算した値」のまま残す — これは全 TrueType writer
  に共通する、仕様上想定された挙動 (`head` テーブルだけは自分自身の checksum が
  厳密には一致しない)。**実装初期にここでバグを作り込み** (adjustment 確定後に
  `head` の checksum を再計算し直していたため、file 全体の checksum が
  0xB1B0AFBA にならなかった)、fontTools の `checkChecksums=2` (strict) で
  初めて検出できた。opentype.js の再パースや Chromium 表示だけでは
  検出できなかった不具合であり、「Chromeで見えた」だけでは完了扱いにしない、
  という要件の正しさを PoC 自体が証明した形になった。
* 対応 font 形式: `sfntVersion == 0x00010000` (TrueType) かつ `CFF `/`CFF2` なし、
  `fvar` (variable font) なし、`glyf`/`loca`/`head`/`hhea`/`hmtx`/`maxp` が揃っている
  こと (`planFontSubsetSupport()`)。BIZ UDゴシック/明朝はどちらも該当し、`glyf` が
  全体の 93% 前後を占めることを実測済み (§7)。対応外の font (CFF/CFF2/variable font
  など) は **v0.5.1 と同じ full-font embedding へ自動的にフォールバック**。
  subset 生成が実行時に失敗した場合 (glyph 参照不正・checksum 生成失敗等) も
  同様に安全に full-font embedding へ切り替え、以後そのセッションでは
  subsetting を再試行しない。

### GID/CID 変更なしで得られるもの

* `/CIDToGIDMap /Identity` は不変。
* `glyphsFor()` / `glyphsFromToUnicode()` は無変更。
* `adoptExistingFallbackFont()` の「source font digest で fallback font を認識する」
  というマーカー判定ロジック自体は無変更で成立する。ただし **初回実装では実際には
  正しく動いていなかった** ---
  PR レビューで指摘・修正した2点は以下のとおり (§コードレビューで見つかった不具合):
  1. `/BaseFont` の secondary check が subset tag prefix (`ABCDEF+`) を
     考慮しておらず、subset 対応 font は digest が一致してもこの check で
     弾かれ、**adopt が一度も成立していなかった**。
  2. adopt 成功時に返す `numbers.fontFile` が `null` のままで、既存の
     `/FontFile2` object を実際に書き直す先が失われていた。
  
  この2点を修正し、`/BaseFont` の secondary check を prefix 許容にした上で、
  既存 FontDescriptor から `/FontFile2 N 0 R` を実際に解決して
  `numbers.fontFile` に渡すようにした。

## 4. subset の再構築タイミングと fingerprint の分離

* **source font digest** (`fallback.digest = sha256(元 font 全体)`) は不変。
  fallback font の「同一性」判定に使われ、subsetting 前と全く同じ意味を持つ。
* **subset font bytes 自体の digest** は特に PDF へは書き込まない
  (書く必要がない: GID を変えないので、後から subset を拡張しても
  「以前 embed した subset ⊆ 新しい subset」が常に成立し、古い content stream の
  参照は常に有効であり続けるため)。
* `buildFallbackFontObjects()` は **呼ばれるたびに、その時点で editor が把握している
  「使用済み glyph 全集合」から subset を作り直す**。1回の `save()` の中で複数の
  fallback 置換があっても、`editor.fallbackEmbeddings` に集約されるため
  subset は1つにまとまる (§6)。save → reopen 後は `adoptExistingFallbackFont()` が
  ToUnicode から前回の glyph 集合を読み戻し、それに新しい glyph を union してから
  subset を作り直す。
* `/BaseFont` には PDF の慣例に沿った subset tag (`ABCDEF+BIZUDMincho-Regular`) を
  付与する。tag は **source font digest から決定的に導出** され、subsetting の
  成否や glyph 集合の変化とは無関係に安定する。ただし **識別には一切使っておらず**
  (`adoptExistingFallbackFont()` は digest マーカーのみを見る)、名前は表示上の
  慣例に従っただけ。

## 5. 未対応 font へのフォールバック (item 15/16)

`planFontSubsetSupport()` が false を返す場合、または `buildSparseSubsetFont()` が
実行時に例外を投げた場合は、v0.5.1 と同じ「font 全体を deflate して埋め込む」
経路にフォールバックする。判定は `fallback.subset = { supported, reason }` に保持され、
`diagnoseFallbackFontEmbedding()` (developer diagnostics、非公開 API) で
`embedding.mode` (`"subset"` / `"full-font"`) と理由を確認できる。

**subset → full-font への降格時、既存 `/FontFile2` を必ず書き直す。** 初回実装では
「`programAlreadyEmbedded` が true なら以後 `/FontFile2` を触らない」という
v0.5.1 由来の判定をそのまま流用しており、既に subset が embed 済みの状態で
subset 生成が実行時に失敗し full-font へ降格する場合に、**古い (小さい) subset の
ままの `/FontFile2` を残しつつ `/W`・ToUnicode だけ新 glyph を含む状態へ
更新してしまう** 不具合があった (PR レビューで指摘)。「現在 live な
`/FontFile2` が実際に full font かどうか」を `priorEmbeddingIsFullFont` として
追跡し (adopt 時は既存 `/FontFile2` 自身の `/Length1` を `fallback.bytes.length`
と比較して判定、同一セッション内は前回呼び出しの `fallback.lastEmbedding.mode`
から判定)、`full-font へ降格 && 既存が subset だった` 場合は必ず `/FontFile2` を
書き直すよう修正した。

**composite の循環参照は例外として扱う (item 6 の要件どおり)。** 初回実装は
「訪問済みならスキップ」という緩い判定で無限ループこそ避けていたが、真の循環
(ある glyph が composite 経由で自分自身を再度参照する) を検出して拒否しては
いなかった。「訪問中」と「展開済み」を明示的な stack で区別する実装へ修正し、
循環を検出した場合は `FONT_SUBSET_INVALID` を投げて安全に full-font embedding へ
フォールバックするようにした (二つの composite が同じ component を共有する
diamond 依存は、循環ではないため引き続き正しく1回だけ展開される)。

## 6. 複数 glyph・複数 role の扱い

* 同一 `save()` 内で複数箇所を fallback 置換しても、**同じ role・同じ font なら
  1つの subset** にまとめられる (`editor.fallbackEmbeddings` が role ごとに
  glyph 集合を集約するため)。
* serif / sans は完全に独立 (`fallbackFonts` / `fallbackEmbeddings` が role ごとの
  Map)。1 PDF 内で両方使われる場合、Mincho subset と Gothic subset がそれぞれ
  独立して embed される。

## 7. 実測結果

### BIZ UDMincho / BIZ UDGothic 単体

| 対象 | full font | glyf の割合 |
|---|---:|---:|
| BIZ UDMincho Regular 1.06 | 6,153,932 bytes | 5,736,581 bytes (93.2%) |
| BIZ UDGothic Regular 1.05 | 4,667,376 bytes | (同様に大部分) |

`令和 → しょ` (2 glyph) の subset (deflate 前 / 後):

| Font | subset (raw) | subset (deflate) | 削減率 (raw) |
|---|---:|---:|---:|
| BIZ UDMincho | 417,824 bytes | 184,114 bytes | 93.2% |
| BIZ UDGothic | 417,908 bytes | 180,304 bytes | 91.1% |

2/10/50/100 glyph (BIZ UDMincho, `test/font-subset.test.js` で実測、CI runner 上):

| glyph 数 | subset (raw) | 生成時間 |
|---:|---:|---:|
| 2 | 417,896 bytes | 数 ms |
| 10 | 420,648 bytes | 数 ms |
| 50 | 430,092 bytes | 数 ms |
| 100 | 443,160 bytes | 数 ms |

glyph 数が増えても大部分は「他の全テーブル (cmap 等) のベースコスト」であり、
glyph 自体の追加コストは 1 glyph あたり数十〜百数十 byte 程度に留まる。

### `22550.pdf` 実ファイルでの結果

ローカル開発環境からは `www.city.itoman.lg.jp` へ到達できない (別記録
`docs/descendant-font-diagnosis.md` と同じ egress 制限) ため、実ファイルでの検証は
`.github/workflows/diagnose-real-pdf.yml`（`run_edit_test: true`、GitHub-hosted runner、
新しい workflow は追加せず既存 workflow を拡張）で実行した
([run 34008785037](https://github.com/YanTKYS/idontlovepdf-engine/actions/runs/34008785037)、
全ステップ success)。ローカルでは同一構造・同一文字集合の fixture PDF で engine 経由の
save/reopen フローを事前に再現・検証している。

v0.5.1 baseline (既知):

```text
original:            615,690 bytes
full-font embedding: 4,562,587 bytes
increase:            +3,946,897 bytes
```

`22550.pdf` 実ファイルでの v0.6.0 実測 (1回目 `令和 → しょ`, BIZ UD明朝, serif 側
-- `/F3` は Serif bit が立っており `diagnoseFallbackFontSelection()` が
`classification: "serif"` / `selectedRole: "serif"` を正しく選択):

```text
original:  615,690 bytes
saved:     802,131 bytes
increase:  +186,441 bytes
embedding: subset (417,824 / 6,153,932 bytes, 93.2% smaller than the whole program)
mode:      fallback-font-multi-run (実PDFの構造上、複数 run にまたがる一致)
```

**v0.5.1 baseline 比で 95.3% 削減**（3,946,897 → 186,441 bytes）。目標の
80%削減を大きく上回り、追加容量500KB以下という stretch goal も達成した
(186KB)。`checkTextMatchReplacement("しょうわ")` は `availableAdvance: 2250` /
`replacementAdvance: 4000` で `FALLBACK_LAYOUT_UNSUPPORTED`
(`fallback-replacement-overflows-slot`) として引き続き拒否され (v0.4.4 の
fail-closed safety は無変更)、`令和 → 平成` は fallback font を一切使わず
(`mode: "same-length"`) 元 font 経由で成功した。

### save → reopen → glyph 追加 (item 11, 最重要回帰) -- コードレビューで発覚した不具合と再検証

初回の実 `22550.pdf` 検証 ([run 34008785037](https://github.com/YanTKYS/idontlovepdf-engine/actions/runs/34008785037)) は、
2回目の編集を **1回目と同じ場所** (`しょ` を検索して `たい` へ再置換) に対して
行っていた。これは PR レビューで明確に指摘された盲点で、この方法では
「既存 subset を正しく拡張できている」ことと「adopt が実は失敗しており、
同じ場所を上書きしたことで偶然2つ目の (孤立した) fallback font 系列が
見えなくなっているだけ」の2つを区別できない。

実際、レビューはコードを直接指摘した:

1. `adoptExistingFallbackFont()` の `/BaseFont` secondary check が
   subset tag prefix (`ABCDEF+`) を考慮しておらず、subset 対応 font は
   digest が一致してもこの check で弾かれ、**adopt が一度も成立していなかった**。
2. adopt 成功時に返す `numbers.fontFile` が `null` のままで、既存の
   `/FontFile2` object を実際に書き直す先が失われていた。

この2点により、v0.6.0 の初回実装は「reopen 後にglyph集合をunionして、
別font resourceとして重複埋め込みしない」という **今回の最重要要件を
実際には満たしていなかった**。1回目の save で FontFile2 が1つ、2回目の save
後で FontFile2 が計6つ (実測ログにそのまま出ていた) という数字自体は
このバグの兆候だったが、検証スクリプト側が「同じ場所を上書きする」設計
だったために見逃していた。

**修正内容:**

* `/BaseFont` の secondary check を、subset tag prefix を許容する正規表現へ変更。
* `adoptExistingFallbackFont()` が既存 FontDescriptor から `/FontFile2 N 0 R`
  を実際に解決し、`numbers.fontFile` として返すよう修正。
* `priorEmbeddingIsFullFont` (adopt 時は既存 `/FontFile2` 自身の `/Length1` と
  `fallback.bytes.length` を比較して判定) を追加し、「subset → full-font へ
  降格する際は既存 `/FontFile2` を必ず書き直す」ことを保証。

**修正後、`scripts/verify-real-pdf-edit.js` 自体も、2回目の編集を
「1回目とは別の、未編集のまま残っている `令和` 出現箇所」に対して行うよう
書き直した** (`--second-fallback` は同じ場所を上書きしない)。あわせて、
2回目 save 後の live Type0/FontFile2 object 番号が **1回目 save が作成した
object 番号と同一である** (新規 object を割り当てていない) ことを、
実際に xref を辿って直接検証するチェックを追加した — これがまさに
今回のバグを検出できるはずだった検証である。

`test/fallback-font.test.js` にも、同じ観点の合成 fixture テスト
(`extends the SAME subset for a second, untouched location, ...`) を追加した。
このテストは **修正前のコードに対して意図的に実行し、実際に失敗することを
確認済み** (`found 7,12` — 2つの異なる Type0 object 番号が検出された)。

修正後、ローカルの複数箇所 fixture (3箇所の `令和`、うち1箇所を1回目・
別の1箇所を2回目に置換) で再検証した結果:

```text
live Type0 object number(s) named by a fallback /Font resource entry: 単一
first save's own FontFile2 object number: 単一
second save's LIVE FontFile2 object number: 1回目と同一の object 番号
qpdf --check: exit code 0
fontTools (strict): 1 font program のみ検出、checksum 検証通過
MuPDF page text: "しょ8年度\nたい8年度\n令和8年度\n"
  (1回目の置換・2回目の置換・未編集の3箇所目、いずれも正しく共存)
```

### `22550.pdf` 実ファイルでの再検証 -- 2回目の false positive とその修正

[run 34011896819](https://github.com/YanTKYS/idontlovepdf-engine/actions/runs/34011896819)
の結果 (2回目編集を「1回目とは別の `令和` 出現箇所」へ変更した直後の実行) を
「object 番号レベルで確認できた」として一度報告したが、**これも誤りだった**。
再度の PR レビューで指摘された:

2回目の `checkTextMatchReplacement()` の結果は
`{"allowed":true,"mode":"same-length"}` であり、**fallback font を一切
経由していなかった**。`令和 → たい` は `22550.pdf` 自身の埋め込み font
(`/F3`) に `た`・`い` の glyph が既にあったため、通常の「元 font で書ける
置換」経路 (`same-length`) で成功していた。このため、

* 2回目 save の +902 bytes
* live Type0 object 72 のまま
* live FontFile2 object 75 のまま
* font program 数が5個のまま
* 独立検証ログの BIZ UD明朝 subset の `/Length1` が 417,824 bytes のまま
  (1回目から **変化していない**)

という一連の観測結果は、**「fallback font を経由せずに置換できたので、
そもそも subset を触っていない」ことの証拠**であり、「既存 subset へ
`た`・`い` を追加できた」証拠には全くなっていなかった。検証スクリプトが
`round2Check.allowed` だけを見て `round2Check.mode` を確認していなかった
ため、この false positive を検出できなかった。

**修正内容 (`scripts/verify-real-pdf-edit.js`):**

* 2回目の置換候補を固定文字列ではなく、**preflight で選ぶ**方式に変更した。
  1回目とは別の残存 `令和` 出現箇所それぞれに対し、候補文字列 (CLI 指定の
  ヒント文字列に加え、`ゐゑ`・`麒麟`・`檸檬`・`蜥蜴`・`鴛鴦`・`薔薇`・`躑躅`
  等、現代の行政文書には通常現れない仮名・漢字) を順に
  `checkTextMatchReplacement()` へ渡し、**`allowed` かつ `mode` が
  `fallback-font`/`fallback-font-partial`/`fallback-font-multi-run` の
  いずれかで始まる**組み合わせを実際に見つけてから採用するようにした。
  該当する組み合わせが1つも見つからない場合は、成功扱いにせず `FAIL` して
  終了する。
* 2回目の置換を実行した直後 (save 前) に `diagnoseFallbackFontEmbedding()`
  で `embedding.mode === "subset"` であること、かつ2回目の subset バイト数が
  **1回目より厳密に大きい**ことをその場で assert するようにした。
* save 後、live な `/FontFile2` object の `/Length1` 自体が1回目の subset
  サイズより厳密に大きいことも直接確認するようにした (object 番号が同じ
  だけでは、中身が変わっていない可能性を排除できないため)。

修正後のローカル検証 (合成 fixture で、意図的に「たい」を文書自身の font
へ追加して、実 `22550.pdf` と同じ状況を再現): preflight が正しく `たい`
を** skip し**、`ゐゑ` を選んで fallback 経由での2回目編集に成功することを
確認した (`subset grew from 417620 to 418244 bytes (+624)`)。

### `22550.pdf` 実ファイルでの最終確認 (false positive 修正後)

[run 34014242061](https://github.com/YanTKYS/idontlovepdf-engine/actions/runs/34014242061)
(全ステップ success)。preflight が `22550.pdf` 上で実際に選んだ組み合わせと
結果:

```text
2nd round preflight: "ゐゑ" (2回目とは別の令和出現箇所)
checkTextMatchReplacement: {"allowed":true,"mode":"fallback-font-multi-run"}
  -- 今度こそ実際に fallback font 経路 (mode が "fallback-font" で開始)

diagnoseFallbackFontEmbedding() (2回目, save 前):
  embedding.mode: "subset"
  requestedGlyphs: 4, includedGlyphs: 5
  subsetBytes: 417,824 -> 418,664 (+840 bytes, 1回目より厳密に増加)

2nd save: 988,747 bytes (1回目 802,131 bytes から +186,616 bytes)
live Type0 object number: 72 (1回目と同一)
live FontFile2 object number: 75 (1回目と同一)
live FontFile2 /Length1: 418,664 (1回目の 417,824 から実際に増加)
distinct fallback font digest: 1種類のみ
```

今回は「fallback font を実際に経由した」ことを `mode` で確認した上での
結果であり、2回目 save の増分 (+186,616 bytes) は前回の false positive
(+902 bytes) とは異なり、**新しい glyph を含む subset を deflate し直した
本物のコスト**を反映している (§10 のとおり、baseline table を含む subset
全体を毎回再 deflate する設計のため、新 glyph 自体のコストは僅かでも
増分自体は full-font 再 deflate 相当の規模になる)。

**独立検証 (item 19、全項目 success)**:

* **pdfminer.six**（座標比較）: `令和 → しょ` の直後に続く `8年度` の描画位置が
  `dx=0.0000 dy=0.0000`（tolerance 1.0）。
* **qpdf `--check`**: 元ファイル・1回目 save 後・2回目 save 後のいずれも
  exit code 0。
* **Chromium 自身の PDF viewer**: 1回目・2回目とも編集後ファイルをエラーなく
  開けることを確認（page error 0）。
* **fontTools (`checkChecksums=2`, strict) / FreeType**: 1回目・2回目 save
  後、いずれも **全 5 font program**（`22550.pdf` 元々の4つ + BIZ UD明朝
  subset 1つ、object 番号は共通のまま）を独立に checksum 検証、すべて通過。
  2回目の font program #5 は `418,664` decoded bytes（1回目は `417,824`）で、
  **同じ object 番号のまま中身が実際に大きくなっている**ことを確認できた。
* **MuPDF (PyMuPDF)**: 1回目 save 後は `"しょ8 年度\n...令和8 年8 月\n"`、
  2回目 save 後は `"しょ8 年度\n...ゐゑ8 年8 月\n"` を正しく抽出。
  **1回目の置換 (しょ) が2回目の save でも壊れずに残り**、かつ2回目の
  置換 (ゐゑ、別の元「令和8 年8 月」箇所) も同時に正しく描画されていることを、
  engine と無関係な実装 (MuPDF) で確認した。

以上により、「reopen 後に glyph 集合を union して、別 font resource として
重複埋め込みしない」という最重要要件を、**実際に fallback font 経路を
経由したことを確認した上で**、実 `22550.pdf` に対して object 番号・
`/Length1` レベルで確認できた。

## 8. bundle size

新規の外部依存は追加していない (`src/font-subset.js` は自前実装、既存の
`opentype.js` 依存はそのまま)。`dist/idontlovepdf-engine.js`:

```text
変更前: 531.5 KB
変更後: 545.4 KB (+13.9 KB, +2.6%)
```

## 9. テスト

* `test/font-subset.test.js` (新規): planFontSubsetSupport の判定、composite 展開・
  循環参照の拒否・diamond 依存 (循環ではない共有 component) の正しい展開・
  範囲外 glyph・重複 glyph・.notdef・checksum 再構築 (合成 font)、
  実 font での GID 不変性・subset 拡張の非破壊性・80%以上の削減・2/10/50/100 glyph
  の計測、`buildFallbackFontObjects()` の subset/full-font 分岐と実行時
  フォールバック (runtime downgrade 時の `/FontFile2` 再書き込みを含む)。
* `test/fallback-font.test.js` (新規テスト): 1回目と2回目で **別の箇所** を
  編集し、live な Type0/CIDFont/FontDescriptor/FontFile2 object 番号が
  2回の save で同一であること (別 font resource として重複埋め込みされて
  いないこと) を、実際に xref を辿って直接検証する。修正前のコードに対して
  実行し、実際に失敗する (`found 7,12` のように2つの異なる Type0 object 番号
  が検出される) ことを確認済み。
* 既存 `test/fallback-font*.test.js` / `test/font-classification-diagnosis.test.js`:
  「font program は1回だけ embed される」という v0.5.1 の assertion を
  「save ごとに subset が育つ (小さい増分)」という新しい前提へ更新。BaseFont の
  正規表現に subset tag prefix を許容。
* `test/browser/fallback-font.test.js`: 実 Chromium での embed サイズ期待値を
  「full font 分 (+1MB超)」から「subset 分 (+50KB〜1MB)」へ更新。
* 全てのテストは実 BIZ UDフォントを使用しており、skip は発生しない
  (`npm run test:font` 前提)。

## 10. 残る制約 / 今回やらないこと

* CFF/CFF2/variable font は subsetting 非対応 (full-font embedding へ自動
  フォールバック)。今回のスコープ外 (item 15 のとおり)。
* 同一 role の font に対し、別セッションでの save を重ねるたびに `cmap` 等の
  ベースコスト (~180KB 前後) を含む subset を再度 embed する
  (「diff だけ追記」はしていない)。数回程度の編集では baseline (削減目標) を
  大きく下回るが、非常に多数回の独立した save を繰り返す運用では増加量が
  累積する。今回の PoC の対象 (数箇所の fallback 編集) では問題にならない
  規模だが、将来的な最適化の余地として記録しておく。
* `/CIDToGIDMap /Identity` を前提とした sparse subset のみ対応。CID を
  glyph ID と切り離す設計 (§2 で不採用とした renumber 方式) は行っていない。
* レイアウトエンジン・reflow・font size 自動縮小・bold/italic weight matching・
  PDF/画像の一般的な圧縮などは一切変更していない (item 31 のとおり)。

## 11. Go / No-Go

**Go (v0.6.0 候補)。**

この結論に至るまでに、PR レビューで2つの重大な問題が指摘され、いずれも
修正・再検証済みである:

1. **実装バグ**: 初回実装は「save → reopen → 別箇所への追加編集で、既存
   subset を正しく拡張し、別 font resource として重複埋め込みしない」と
   いう最重要要件を実際には満たしていなかった (`adoptExistingFallbackFont()`
   の `/BaseFont` secondary check が subset tag prefix を弾いていた、
   `numbers.fontFile` が `null` のままだった)。修正した (§3・§5 参照)。
2. **検証の false positive (2回)**: 実 `22550.pdf` での検証が、1回目は
   「同じ場所を2回編集する」設計のため、2回目は「2回目の置換が実際に
   fallback font を経由したか (`mode`) を確認していなかった」ため、
   2回とも「拡張できた」と誤って報告していた (§前セクション参照)。
   検証スクリプトを、実際に fallback 経路を通る候補を preflight で選び、
   subset バイト数・live `/FontFile2` の `/Length1` が実際に増加した
   ことを直接 assert するよう修正した。

**修正後、実 `22550.pdf` に対する最終確認
([run 34014242061](https://github.com/YanTKYS/idontlovepdf-engine/actions/runs/34014242061)、
全ステップ success) で、以下をすべて確認した:**

* `checkTextMatchReplacement()` の `mode` が実際に `fallback-font-multi-run`
  (fallback font 経路) であったこと。
* 2回目の subset が 417,824 → 418,664 bytes へ、1回目より厳密に増加したこと。
* live Type0 object 番号 (72)・live FontFile2 object 番号 (75) が2回の save
  で同一であり、かつ live FontFile2 の `/Length1` 自体が 417,824 → 418,664
  へ実際に増加していたこと (object 番号が同じなだけでなく、中身も変化)。
* 1回目の置換 (しょ) が2回目の save 後も壊れずに残り、2回目の置換 (ゐゑ)
  と同時に MuPDF で正しく描画・共存すること。
* qpdf `--check`・pdfminer.six (dx=dy=0)・Chromium・fontTools (strict
  checksum)・FreeType がすべて成功。

* BIZ UDゴシック/明朝ともに subset 生成成功、GID 不変、composite 依存 (diamond)
  を正しく解決し、真の循環参照は `FONT_SUBSET_INVALID` として拒否する。
* checksum は TrueType 仕様どおり再構築し、fontTools (strict) / FreeType /
  MuPDF (PyMuPDF) の独立実装で検証済み (この過程で checksum 再構築自体の
  実装バグも1件発見・修正した)。
* save → reopen → **別箇所への** glyph 追加で、最初に書いた fallback 文字を
  壊さず、live な Type0/FontFile2 object 番号が2回の save で同一である
  (別 font resource として重複埋め込みしていない) ことを、合成 fixture
  テスト (`test/fallback-font.test.js`、修正前のコードに対しては実際に
  失敗することも確認済み) と、**実際に fallback 経路を通ったことを
  確認した上での実 `22550.pdf`** の両方で直接検証した。
* Serif/Sans 双方が独立して subset 化され、v0.5.1 の自動選択・fail-closed 安全性
  (`FALLBACK_LAYOUT_UNSUPPORTED` 等) は無変更。
* bundle size 増加は +13.9KB (+2.6%) と小さく、新規外部依存もなし。
* 削減率は実測で 91〜95% 前後 (目標の80%を大きく上回る、1回目 save 単体の値、
  これは fallback 経路が確実に使われた実測であり、今回の false positive の
  影響を受けていない)。
