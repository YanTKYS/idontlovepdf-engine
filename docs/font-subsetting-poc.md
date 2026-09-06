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

この時点で、**「GID を変えない sparse subset」を選べば、save → reopen の認識ロジックに
一切手を入れずに済む** ことが分かった (`adoptExistingFallbackFont()` は無変更)。

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
  (`expandGlyphSet()`)。循環参照は「訪問済みならスキップ」で安全に停止する。
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
* `adoptExistingFallbackFont()` は **完全に無変更** — 既存の「source font digest で
  fallback font を認識する」仕組みがそのまま、subset の GID 集合を読み戻す仕組みとして
  機能する。

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

### save → reopen → glyph 追加 (item 11, 最重要回帰) -- `22550.pdf` 実ファイルで確認

1回目 (`令和 → しょ`, 上記) → save → reopen → 2回目 (`しょ → たい`) を実行:

```text
1st save:  802,131 bytes (+186,441 bytes)
2nd save:  988,674 bytes (+186,543 bytes, 前回 save からの増分)
embedded fallback font digest: 1種類のみ (両方とも同一 source font として認識・拡張)
2回目 reopen 後:
  searchText("たい") -> 1件
  searchText("しょ") -> 0件 (2回目の置換で上書きされたため; 破損ではなく意図通り)
  searchText("令和") -> 33件 (34件中1件を置換; 元の baseline どおり)
```

以前 fixture で確認していたのと同じ結果を実 `22550.pdf` でも再現した:
同じ fallback font (BIZ UD明朝) が2回の save にわたり正しく認識・拡張され、
別 font として重複埋め込みされることはない。

### `22550.pdf` での独立検証 (item 19、全項目 success)

`22550.pdf` に対する GitHub Actions 実行では、engine 自身のテストとは無関係な
以下のツール・確認をすべて実施し、いずれも問題を検出しなかった:

* **pdfminer.six**（座標比較）: `令和 → しょ` の直後に続く `8年度` の描画位置が
  `dx=0.0000 dy=0.0000`（tolerance 1.0）と、完全に不動であることを確認。
* **qpdf `--check`**: 元ファイル・1回目 save 後・2回目 save 後のいずれも
  exit code 0（構造エラーなし）。
* **Chromium 自身の PDF viewer**: 1回目・2回目とも編集後ファイルを
  エラーなく開けることを確認（page error 0）。
* **fontTools (`checkChecksums=2`, strict)**: 1回目 save 後の PDF に埋め込まれた
  **全 5 font program**（`22550.pdf` が元々持っていた 4 font 含む）と、
  2回目 save 後の **全 6 font program** を、それぞれ独立に checksum 検証。
  今回 subset 化した BIZ UD明朝 (417,824 bytes → 417,976 bytes へ拡張) も含め、
  すべて strict checksum を通過。
* **FreeType**: 同じく全 font program をロードし、正しく解析できることを確認
  （subset 化した font は sample 200 glyph 中 1 glyph のみ outline を持つことも
  確認 — sparse subset が実際に機能している証拠）。
* **MuPDF (PyMuPDF)**: 編集後 PDF をレンダリングし、ページテキストとして
  1回目は `"しょ8 年度\n糸満市放課後児童クラブ運営事業者\n..."`、2回目は
  `"たい8 年度\n..."` を正しく抽出。別実装 (MuPDF) が engine の埋め込んだ
  subset font から実際に「しょ」「たい」という文字を読み取れることを確認した。

fixture での事前検証時の save → reopen → glyph 追加 (参考、BIZ UDGothic, sans 側):

```text
1st save: +181,788 bytes (subset: 2 requested / 3 included glyphs, 417,620 bytes)
2nd save: +181,943 bytes (subset は 417,732 bytes へ拡張)
/FontFile2 の出現回数: 2 (save ごとに1回、subset が育つため)
埋め込み font の digest: 1種類のみ (両方とも同じ source font として認識・拡張)
2回目 reopen 後:
  searchText("たい")  -> 1件
  searchText("しょ")  -> 0件 (2回目の置換で上書きされたため; 破損ではなく意図通り)
```

fontTools (`checkChecksums=2`, strict) と FreeType (`freetype-py`) で両方の
subset font を独立検証し、いずれも正常にロードできることを確認した
(`scripts/verify-real-pdf-font-subset.py`)。qpdf `--check` も両方の保存後ファイルで
exit code 0。

## 8. bundle size

新規の外部依存は追加していない (`src/font-subset.js` は自前実装、既存の
`opentype.js` 依存はそのまま)。`dist/idontlovepdf-engine.js`:

```text
変更前: 531.5 KB
変更後: 543.0 KB (+11.8 KB, +2.2%)
```

## 9. テスト

* `test/font-subset.test.js` (新規): planFontSubsetSupport の判定、composite 展開・
  循環参照・範囲外 glyph・重複 glyph・.notdef・checksum 再構築 (合成 font)、
  実 font での GID 不変性・subset 拡張の非破壊性・80%以上の削減・2/10/50/100 glyph
  の計測、`buildFallbackFontObjects()` の subset/full-font 分岐と実行時
  フォールバック。
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

* BIZ UDゴシック/明朝ともに subset 生成成功、GID 不変、composite 依存を正しく解決。
* checksum は TrueType 仕様どおり再構築し、fontTools (strict) / FreeType /
  MuPDF (PyMuPDF) の独立実装で検証済み。
* save → reopen → glyph 追加で、最初に書いた fallback 文字を壊さないことを
  fixture で確認 (実 `22550.pdf` は GitHub Actions 実行で最終確認)。
* Serif/Sans 双方が独立して subset 化され、v0.5.1 の自動選択・fail-closed 安全性
  (`FALLBACK_LAYOUT_UNSUPPORTED` 等) は無変更。
* bundle size 増加は +11.8KB (+2.2%) と小さく、新規外部依存もなし。
* 削減率は実測で 91〜95% 前後 (目標の80%を大きく上回る)。
