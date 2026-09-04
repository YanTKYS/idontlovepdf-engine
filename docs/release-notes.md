# Release notes

各versionのリリース内容を新しい順に記載します。H2見出しには、`v`付きversionとGitHub Releaseのtitleを記載します。

## v0.4.4 - Fallback replacement must not overrun the text after it

- **実機で確認された視覚的な不具合の修正です。** `idontlovepdf` + engine v0.4.3 で公開PDF `22550.pdf` の `令和8年度` を編集し、`令和 → しょ` は成功しましたが、`令和 → しょうわ` は `allowed: true` となり置換・保存まで進んだ結果、保存後のプレビューで `しょうわ` の末尾 `わ` と後続の `8` が重なって描画されました
- **原因は、`TJ` fallback の adjustment 計算が「後続文字の開始位置を維持すること」だけを保証し、「置換文字列自身がその位置まで描画されないこと」を保証していなかったことです。** v0.4.1〜v0.4.3 の adjustment `n`（`n = 置換文字列の合計幅 - 元 match の合計幅 + match 内部の adjustment 合計`）は、後続文字の開始位置をどれだけ動かせば元の位置に戻るかを計算するだけで、置換文字列自身の描画幅がその位置を超えていないかは確認していませんでした。置換文字列が元の match より広い場合、adjustment は後続文字の開始位置を正しく元へ戻せても、置換文字列自身の glyph がその位置より右側まで描画され、後続文字と重なります
- **`checkTextMatchReplacement()` / `replaceTextMatch()` が共有する既存の TJ planner（`planTextArrayRewrite()`, `src/pdf-document.js`）に、置換前の安全性判定を追加しました。** 新しい計算式や新しい measurement はほぼ導入していません。同じ関数がすでに求めていた値を比較します。
  - `availableAdvance`: 置換開始位置から、同一 text flow 上で位置を維持すべき最初の後続文字が実際に描画される位置までの advance。`元の match の合計幅 - match 内部の adjustment 合計`（既存の adjustment 式が使う値）だけでは不十分で、match の直後（同じ配列の tail）や後続の別の `TJ` の先頭に adjustment 数値がある場合はそれも差し引く必要があります（レビューで指摘・修正: 当初の実装は `[(令和) 50 (8年度)] TJ` のように match 自身の tail に adjustment があるケースでこれを見落としており、`しょ` のような「ちょうど元の幅と同じ」置換が実際には 50 units 分 `8` へ食い込むケースを見逃していました）。この追加の gap は、`scanTextRuns()`（`src/content-stream.js`）が各 run にすでに記録している `displacement`（その run の直前で消費されず残っている数値の合計。`Tf` 等の operator が自分の operand として数値を消費した場合は 0 にリセットされるため、fallback rewrite 自身が出力する `/Fallback Tf [...] TJ /Original Tf [adjustment ...] TJ` という構造 — つまり一度 fallback 置換した箇所を再度編集する場合 — でも正しく読めます）から取得し、新しい parsing は追加していません
  - `replacementAdvance`（`glyphSpaceWidth()` の合計）: fallback font で置換文字列を自然に描画したときの advance。既存の計算をそのまま再利用しています

  `replacementAdvance > availableAdvance` の場合は置換前に拒否します。等しい場合は許可します（浮動小数点の曖昧な許容誤差は導入していません）。後続文字が実際にどこから描画されるか特定できない場合（対象範囲の直後で content stream が終わっている等）も、0 とみなさず `unsafeReason: "fallback-replacement-slot-unknown"` で拒否します。`checkTextMatchReplacement()` と `replaceTextMatch()` は同じ planner を通るため、判定が食い違うことはありません
- **`令和 → しょ` は引き続き成功します。** `令和 → しょうわ` は `allowed: false`（`code: "FALLBACK_LAYOUT_UNSUPPORTED"`、`unsafeReason: "fallback-replacement-overflows-slot"`）になり、置換・保存を実行する前に拒否されます。拒否時は `diagnostics: { replacementAdvance, availableAdvance }` を返し、原因を数値で確認できます
- **同一 text flow 上の後続文字が置換文字列の幅に依存しないと証明できる場合は、この判定を適用しません。** match の直後に同一 flow の文字が存在しない、`ET`、明示的な `Td`/`TD`/`Tm`/`T*` によって位置が再設定される場合がこれにあたります（v0.4.1 以来の「何も描画されない場合は adjustment 不要」というルールと同じ判定です）。「ページの右側に空きがありそうだから許可する」といった geometry の推測はしません
- **後続文字を右へ移動する、文字を横方向に縮小する、行を再流し込みする、といった代替策は実装していません。** 安全にその場所へ置けないなら断る、という既存方針のままです。ページ全体の汎用的な collision detection でもありません — 保証するのはあくまで同一 text flow 上で位置を維持する後続文字との衝突防止です
- **`fallback-font` / `fallback-font-partial` / `fallback-font-multi-run` のいずれにも同じ判定を適用します。** 判定は `TJ` で描画された match を扱う `planTextArrayRewrite()` 1 箇所にあり、この 3 つの `mode` はすべてそこを通るため、mode ごとに別の判定を持っていません。`Tj` で描画された match は元々このリスクがありません（後続文字は置換文字列の実際の幅から自然に続けて描画されるだけで、位置を「元へ戻す」処理をしないため、置換文字列が広くても後続文字と重なりません）
- **`FALLBACK_LAYOUT_UNSUPPORTED` を再利用しました。** 本件専用の新しい公開 error code は追加していません。開発者向けの詳細は `unsafeReason: "fallback-replacement-overflows-slot"`（幅が収まらない）・`"fallback-replacement-slot-unknown"`（後続文字の位置が特定できない）として区別できます
- **既存の v0.4.3 の成果は変更していません。** inline `/DescendantFonts` dictionary、`/W`・`/DW` の間接 object 解決、実 PDF `22550.pdf` の font metrics 解決は、そのまま再利用しています。今回判明したのは「font metrics を正確に取得できること」と「長い置換を視覚的に安全に配置できること」が別問題だという点です
- **fallback font の書体差は今回の対象外です。** `令和 → しょ` は重なりなく成功しますが、fallback font（BIZ UDGothic）は元 PDF のフォントと書体が異なります。明朝系 fallback の追加・Serif/Sans 判定・FontDescriptor の Flags による font 選択・複数 fallback font・font matching は実装していません。別課題として残しています
- **検証。** `test/fallback-font-overflow.test.js` を追加しました。availableAdvance と replacementAdvance が「狭い」「等しい」「広い」場合の許可・拒否、後続位置が置換文字列の幅に依存しないことを証明できる場合の許可、`TJ` 配列内部の adjustment（正・負・ゼロ）が実際の利用可能幅に反映されることに加え、レビュー指摘を受けて、match 自身の tail および後続の別 `TJ` の先頭にある adjustment（`[(令和) 50 (8年度)] TJ` / `[(令和) -50 (8年度)] TJ` / `[(令和)] TJ [50 (8年度)] TJ` / `[(令和)] TJ [-50 (8年度)] TJ`）が availableAdvance に正しく反映されること、および一度 fallback 置換した箇所（`/Fallback Tf ... TJ /Original Tf [adjustment ...] TJ` という、この engine 自身が書く構造）を再度編集しても誤って「後続位置不明」扱いにならないことを確認します。`test/fallback-font-tj.test.js` に、実際に報告された `令和 → しょうわ` の重なりと同じ形（同一 TJ 配列内・別 operator の `Tj`・別 operator の `TJ`）を対象にした拒否テストと、拒否時に document bytes / pending state / history / fallback font object のいずれも変化しないことを確認するテストを追加しました。既存の synthetic fixture の一部（`test/helpers/document-font.js` の `令`・`和` の width と、それに依存する `test/fallback-font-tj.test.js` / `test/font-metrics-indirect.test.js` / `test/font-metrics-inline-descendant.test.js` / `test/browser/fallback-font.test.js`）は、実際の fallback font（BIZ UDGothic）の kanji/kana が例外なく全角（1000 glyph-space units）であることに合わせて調整しました（従来の `和 = 950` は意図的な非全角フィクスチャでしたが、これを残すと `しょ` が real font 換算で必ず overflow してしまい、v0.4.3 で実 PDF で確認できていた `令和 → しょ` の成功シナリオを synthetic test で再現できなくなるため）
- 公開 API（`setFallbackFont()` / `searchText()` / `checkTextMatchReplacement()` / `replaceTextMatch()` / `save()` / `ENGINE_VERSION`）の形は変更していません。新しい `unsafeReason` の値（`fallback-replacement-overflows-slot`）と、拒否結果への `diagnostics` フィールドの追加のみです。追加依存もありません
- v0.4.3 までの挙動を維持: classic xref、xref stream、Object Stream、R4/AESV2、R6/AESV3、`ToUnicode`、direct/indirect/inline `/DescendantFonts`、`/W`、`/DW`、`Tj`、`TJ`、`'`、`"`、既存 font 置換、same-length、variable-length-safe、削除、複数 run 検索・置換、`fallback-font`・`fallback-font-partial`・`fallback-font-multi-run`、fallback font の再利用、save → reopen、check と replace の判定一致、atomic な置換、browser bundle、HTTP 環境（Web Crypto なし）対応

## v0.4.3 - Inline descendant CIDFont dictionaries

- **v0.4.2 で`/W 25 0 R`まで解決可能になった`22550.pdf`の`/F3`が、それでも`descendant-font-unresolved`だった原因を解決した version です。** 原因は`/DescendantFonts`が PDF 仕様の許すもう一つの書き方——CIDFont dictionary を array の中に直接書く inline dictionary（`/DescendantFonts [ << ... >> ] `）——で書かれていたことでした。`/DescendantFonts [7 0 R]`のような indirect reference ではありません
- **`parseReferenceArray()`は、この inline dictionary の内部にある reference（`/Ordering`・`/Registry`・`/FontBBox`・`/StemV`・`/FontFile2`・`/W`）を、すべて`/DescendantFonts`自身の array 要素であるかのように誤認していました。** その結果、要素 1 つの合法な array を「要素 6 つの仕様違反」と誤判定し、実際には存在する`/W`に到達できないまま拒否していました
- **`src/pdf-dictionary-text.js`に`topLevelArrayElements()`を追加しました。** 既存の`skipOneValue()`（dictionary は`skipDictionary()`、array は`skipArray()`に委譲）を再利用し、array の要素を値の境界を理解した上で 1 つずつ読みます。新しい PDF parser ではなく、既存 parser の再利用です。nested dictionary 内部の reference は 1 つの値として読み飛ばされるため、array 自身の要素として誤認されることはありません
- **`/DescendantFonts`の 3 形を区別して扱います。** direct reference array（`[7 0 R]`）・indirect array object（`11 0 R` → `[7 0 R]`）・inline dictionary（`[ << ... >> ]`）のいずれも、CIDFont dictionary が一意に 1 つ決まる場合だけ解決します。要素が 0 個・2 個以上、reference と dictionary の混在、CIDFontType0/2 以外の inline dictionary は、従来どおり`FALLBACK_FONT_METRICS_UNAVAILABLE`で拒否します
- **診断 CLI（`scripts/diagnose-font-metrics.js`）も同じ`resolveDescendantFont()`を使うため、production と食い違いません。** inline dictionary の場合は新しい`inline-dictionary` hop を trace に表示し、以前のように内部の reference を array 要素として表示することはありません
- **実 PDF（`22550.pdf`）で確認しました。** `令和 → しょ`（fallback font 経路）・`令和 → 平成`（既存 font 経路、回帰確認）の両方が、検索→ fallback font 設定 → `checkTextMatchReplacement()` → `replaceTextMatch()` → `save()` → 新しい`PdfTextEditor`で reopen → 再検索まで成功しました。置換後に続くテキストの描画位置は、この engine と実装を共有しない pdfminer.six で独立に確認し、置換前後で座標が一致することを確認しました。保存した PDF は qpdf（構造チェック）と Chromium 本体の PDF viewer でも問題なく開けます。詳細は [descendant font の診断](../docs/descendant-font-diagnosis.md) を参照してください
- **PR #26 で記録した、`resolveObject()`が indirect reference の generation 番号を検証せず object 番号だけで解決する件は、この version の対象外です。** 別の安全性レビュー課題として残しています

## v0.4.2 - Font widths a real PDF actually states

- **v0.4.1 の `TJ` fallback を、実務 PDF で成立させるための version です。** 実 PDF（`22550.pdf`）の `/F3` で `令和 → しょ` が `FALLBACK_FONT_METRICS_UNAVAILABLE` になっていました。同じ箇所の `令和 → 平成` は成功します（元 font で書けるため fallback 経路に入らない）。つまり `TJ` 対応そのものではなく、**元 font の glyph 幅を PDF から正確に読み取れないこと**が原因です
- **その `22550.pdf` はこのリポジトリにも開発環境にも無いため、`/F3` の構造を推測して実装することはしていません。** この version で行ったのは「原因を特定できる状態を作ること」と「PDF 自身の情報だけで幅を**正確に**決定できる構造を追加すること」の 2 つです。実 PDF での Go / No-Go は、下記の診断 CLI を `22550.pdf` に対して実行し、`/F3` の `VERDICT` 行で確認してください。`widths readable` なら v0.4.1 で読めなかった原因は間接 object であり、この version で解決しています。`non-identity-encoding` / `embedded-cmap-encoding` / `unsupported-type3` / `missing-widths` などが表示される場合は**引き続き No-Go**で、その font は推測なしには扱えません
- **原因の切り分けができるようにしました。** `loadFontWidths()` は「安全に読めないケース」をまとめて `null` にしていたため、実 PDF で何が原因かを判別できませんでした。内部では `unsupported-font-subtype` / `non-identity-encoding` / `embedded-cmap-encoding` / `descendant-font-unresolved` / `w-unresolved` / `widths-unresolved` / `invalid-width-array` / `missing-first-char` / `unsupported-type3` などに分類し、開発者向けに `unsafeReason` として返します。公開 `code` は `FALLBACK_FONT_METRICS_UNAVAILABLE` のままで、一般利用者向け API の形は変わりません
- **実 PDF の構造を確認するための診断 CLI を追加しました。** `node scripts/diagnose-font-metrics.js <file.pdf> [--password ...] [--text 令和]` が、各 font resource の object 番号・`/Subtype`・`/BaseFont`・`/Encoding`・descendant font・`/W`・`/DW`・`/Widths`・`/FirstChar`・`/ToUnicode`、各値が direct か indirect か、参照先の実体、対象文字の operand bytes と code ごとの幅、そして「読めない場合の理由」を表示します。読み取り専用で、ネットワークアクセスはありません
- **対応を広げたのは 1 点だけです: width を持つ entry が間接 object として書かれている構造。** `/Widths 123 0 R`・`/W 456 0 R`・`/DW`・`/FirstChar`・`/MissingWidth`・`/DescendantFonts` の間接参照を、engine が既に持つ PDF object resolver（`PdfStructure.resolveObject()`）で解決します。正規表現で PDF を展開するのではなく、通常の object 解決経路を通します。`/Encoding` の name 自体が間接 object の場合も、`/Identity-H` と確認できるときに限り解決します（writing mode の判定も同じ経路で `-H` / `-V` を見ます）。あわせて `PdfStructure.object()` が「値が array・name の indirect object」を読めるようにしました（従来は dictionary と整数のみ）
- **解決するのは「数値がどこにあるか」だけです。** 値そのものは従来どおり PDF が書いた数値をそのまま読み、推測は一切しません。`/DW` や `/FirstChar` が間接参照のときに **object 番号を値と取り違えていた読み取り**（`/FirstChar 12 0 R` を 12 と読む）も塞ぎました。誤った幅から誤った adjustment を書き得るため、これは v0.4.1 に対する修正でもあります
- **key はあるが値を読めない場合を「無い」扱いにしません。** 例えば数値でない `/DW` を 1000（spec の既定値）とみなすことはせず、拒否します
- **間接 number は実数（real）も読みます。** `10 0 obj 999.5 endobj` のような合法的な値を、Object Stream 内の number 解析と同じ文法（符号・小数点あり、指数表記なし）で読みます。従来 `PdfStructure.object()` は通常 object の scalar を整数しか読まなかったため、この形は拒否になっていました。`1.2.3` や `1e3` のような PDF number でない値は引き続き拒否します
- **診断 CLI も測定と同じ経路で descendant font へ到達します。** `/DescendantFonts 11 0 R` → `11 0 obj [7 0 R]` のように array object を挟む構造でも、実際の CIDFont の `/W`・`/DW` を表示します（測定側と同じ `resolveDescendantFont()` を共有）。診断が測定より手前で止まると、読めている font を「widths が無い」と誤って報告してしまうためです
- **次は引き続き No-Go（fail closed）です。**
  - `/Encoding` が `/Identity-H` 以外。predefined CMap（`/90ms-RKSJ-H` 等）は PDF 内に無く、embedded CMap stream は解析しません。`/ToUnicode` から CID を逆算することもしません（ToUnicode は Unicode 抽出用で、code → CID と同一とは限らないため）
  - Type 3 font、`/Widths` を持たない標準 14 font
  - 参照先 object が無い・array でない・数値として読めない、`/DW`・`/FirstChar` が数値でない
  - 埋め込み font program の `hmtx` しか手掛かりがない場合（PDF reader が位置決めに使うのは PDF 側の値のため）
- **`TJ` の安全条件は緩めていません。** `置換後の幅 - adjustment === 元の幅 - 元の adjustment` が成立することを、書き込む数値から検算したうえでのみ許可します。`FALLBACK_CHAR_SPACING_UNSUPPORTED` / `FALLBACK_WORD_SPACING_UNSUPPORTED` / `FALLBACK_MULTI_RUN_UNSUPPORTED` / `FALLBACK_LAYOUT_UNSUPPORTED` / `FALLBACK_WRITING_MODE_UNSUPPORTED` もそのままです
- **検証。** `test/font-metrics-indirect.test.js` を追加しました。間接 `/W`・`/DW`・`/DescendantFonts`・`/Widths`・`/FirstChar`・`/MissingWidth` を持つ最小 PDF で、`令和 → しょ` が `allowed: true` になり、置換後も後続文字（`8年度`）の x 座標が置換前と完全に一致すること、save → 開き直して「しょ」が検索でき「令和」が消えていること、font program が 1 回だけ埋め込まれることを確認します。座標の照合には v0.4.1 の**独立 text-advance simulator** を使い、`test/helpers/text-advance.js` として両 test file で共有しています（この simulator は `src/` を一切 import せず、間接 object も自前で解決します）
- **unsafe fixture も 20 件追加しました。** 参照先が存在しない `/W`・`/Widths`、array でない参照先、名前や参照が混ざった width array、数値でない `/DW`・`/FirstChar`、predefined CMap、embedded CMap stream、descendant font 不在・解決不能、CID font でない descendant、`/Widths` 無し、`/FirstChar` 無し、Type 3、未対応 subtype、adjustment として厳密に表現できない幅、間接 object で書かれた縦書き `/Encoding`。いずれも `checkTextMatchReplacement()` が `allowed: false`、`replaceTextMatch()` が同じ `code` で失敗し、**PDF の byte が 1 バイトも変わらない**ことを確認しています
- 公開 API（`setFallbackFont()` / `searchText()` / `checkTextMatchReplacement()` / `replaceTextMatch()` / `save()` / `ENGINE_VERSION`）は変更していません。追加依存もありません。browser bundle は約 506KB → 約 514KB になりました
- v0.4.1 までの挙動を維持: `Tj` / `TJ` fallback、partial-run、multi-run、既存 font による通常置換、same-length multi-run、`variable-length-safe`、削除、fallback font の必要時のみ埋め込みと重複埋め込み防止、ToUnicode 更新、save → reopen、`/P` permission、暗号化 PDF の対応範囲、Web Crypto なし環境、check と replace の判定一致、atomic な置換、`MATCH_STALE` / `UNKNOWN_MATCH`、`'` / `"` 非対応、縦書きの制限、外部通信なし

## v0.4.1 - Fallback font for text drawn by TJ

- **`TJ` 配列で描画された文字にも fallback font を適用できるようになりました。** v0.4.0 の fallback は実質 `Tj` 限定で、`TJ` は一律 `FALLBACK_OPERATOR_UNSUPPORTED` で拒否していました。`TJ` は一般的な PDF で普通に現れるため、`[(令和) -50 (8年度)] TJ` のような箇所で `令和 → しょ` が成立しないことが実用上の制約になっていました
- **対応の第一目標は「後続文字の開始位置が置換前と一致すること」です。** `TJ` を `Tj` へ単純変換したり、見た目が合うことを期待したりはしません。安全性を証明できる範囲だけ許可し、それ以外は従来どおり fail closed で拒否します
- **方式。** match が含まれる `[` から最後の `TJ` までを 1 つの要素列（string と字送り数値の並び）として読み、次の形へ組み替えます。隣接する `TJ` operator の境界そのものは描画に影響しないため、`[(令) 120] TJ [(和)] TJ` と `[(令) 120 (和)] TJ` は同じ列として扱われます

  ```text
  置換前: [(令和) -50 (8年度)] TJ
  置換後: /ILPFallback 36 Tf [<しょ>] TJ /FJP 36 Tf [50 -50 (8年度)] TJ
  ```

- **match の外にある要素は元の byte をそのまま複製します。** 数値の再フォーマット・並べ替え・統合・欠落・重複は起きず、`0` / `+0` / `-0` / `0.0` も書かれたとおりに残ります。engine が新しく書くのは補正用の adjustment 1 つだけです
- **補正値は計測して求めます。** PDF の字送りは `tx = ((w0 - Tj/1000) * Tfs + Tc + Tw) * Th` であり、glyph 幅と `TJ` adjustment はどちらも `Tfs * Th` 倍されるため、両者を等値に置く式から **font size と horizontal scaling が消えます**。残るのは glyph space（1/1000 em）同士の比較で、書くべき値は `n = 置換文字列の合計幅 - 元 match の合計幅 + match 内部にあった adjustment の合計` になります
  - 元の幅は **その PDF 自身の `/Widths`（simple font）または `/W`・`/DW`（CID font）** から取ります。PDF reader が実際に位置決めに使う数値です。埋め込み font program の `hmtx` は見ません
  - 置換後の幅は **埋め込む fallback font の `/W` に実際に書き込む値** から取ります。両者が同じ丸めを共有するよう、値を計算する関数を 1 つにしています
  - 「日本語はだいたい全角だから同じ幅だろう」という仮定は使いません。テスト fixture の font も意図的に等幅にしていません（和 = 950、8 = 500）
- **`Tc` / `Tw` の項は相殺を仮定せず、条件として課します。** `Tc` が 0 でない場合は置換後の glyph 数が元と同じときだけ許可します（`FALLBACK_CHAR_SPACING_UNSUPPORTED`）。`Tw` は 1 バイトの文字コード 32 にしか効かないため、match が 1 バイトのスペースを含み `Tw` が有効な場合は拒否します（`FALLBACK_WORD_SPACING_UNSUPPORTED`）。`q`/`Q` や `"` で値を追跡できない場合は 0 とみなさず拒否します
- **match の終端から何も描画されない場合**（match が列の末尾で、直後が `ET` / `BT` / `Td` / `TD` / `Tm` / `T*`）は adjustment 自体が不要なので書かず、font metrics も要求しません。v0.4.0 の `Tj` と同じ扱いです
- **新しい `mode` は増やしていません。** `TJ` で描画された match も `fallback-font` / `fallback-font-partial` / `fallback-font-multi-run` を返します。`TJ` かどうかを利用側が知る必要はなく、公開 API の形も変わりません
- **拒否理由に対応した `code` を返します。** `TJ` 自体は対応 operator になったため、一律の `FALLBACK_OPERATOR_UNSUPPORTED` は返しません
  - `FALLBACK_FONT_METRICS_UNAVAILABLE`（新規）: 元 font の glyph 幅を正確に読み取れない（`/Widths` も `/W`・`/DW` も無い、`/Encoding` が `/Identity-H` 以外で code から CID を決められない、Type 3 font、幅が間接参照で解決できない）
  - `FALLBACK_CHAR_SPACING_UNSUPPORTED`（新規）: `Tc` が有効で、置換後の glyph 数が元と異なる
  - `FALLBACK_WORD_SPACING_UNSUPPORTED`・`FALLBACK_MULTI_RUN_UNSUPPORTED`・`FALLBACK_LAYOUT_UNSUPPORTED`・`FALLBACK_WRITING_MODE_UNSUPPORTED` は既存 code を再利用します
  - `FALLBACK_OPERATOR_UNSUPPORTED` は `'` / `"`、および match が `Tj` と `TJ` にまたがる場合に限定しました
- **`'` / `"` は対象外のままです。** 描画前に改行を伴うため、`TJ` 対応に合わせて広げてはいません
- **`FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE` の考え方は弱めていません。** `Tj` の判定は v0.4.0 のままで、`TJ` については「後続位置を正確に維持できることを証明できたため許可範囲が増えた」という形の変更です
- **検証。** `test/fallback-font-tj.test.js` は PDF の字送り式を **engine とは独立に実装した simulator** を持ち、保存後の PDF から両 font の `/W` を読み直したうえで、置換前後の各 glyph の描画 x 座標を突き合わせます。目視やスクリーンショットではなく数値の一致で確認しています。`test/browser/fallback-font.test.js` には `TJ` 置換後の PDF を **Chromium 内蔵の PDF viewer** で開く検証を追加しました
- **安全性を証明できない fixture も用意しています。** font metrics を取得できない、writing mode 不明、対象範囲をまたぐ text state 変更などのケースで `checkTextMatchReplacement()` が `allowed: false` を返し、`replaceTextMatch()` が同じ `code` で失敗し、PDF が 1 バイトも変わらないことを確認しています
- **段落の reflow・行の折り返し・再レイアウトは行いません。** 目的は「既存 PDF が指定している後続文字位置を維持したまま、限定的に fallback font で文字を差し替える」ことです。**「`TJ` に対応したので任意の PDF を編集できる」わけではありません**
- 依存ライブラリは増やしていません。font metrics は PDF 自身の辞書から読み、fallback font 側は既存の opentype.js の解析結果を使います
- ファイルサイズへの影響は v0.4.0 と同じです（fallback を使う保存で font 1 本ぶん、以降の保存は数 KB）。`TJ` 対応で増えるのは adjustment 1 つぶんの数バイトです。browser bundle は約 488KB → 約 506KB になりました
- v0.4.0 までの挙動を維持: `Tj` fallback、partial-run、multi-run、既存 font だけで書ける通常置換、same-length multi-run、削除、`variable-length-safe`、fallback を使わない PDF への font 非埋め込み、重複埋め込み防止、ToUnicode 更新、save → reopen、`/P` permission、暗号化 PDF の制約、HTTP 環境（Web Crypto なし）対応、opaque match ID、`MATCH_STALE` / `UNKNOWN_MATCH`、check と replace の判定一致、atomic な置換

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
- 縦書きfont（`/Identity-V`・`/WMode 1` 等）、および writing mode を判定できないfontで描画されたテキストは `FALLBACK_WRITING_MODE_UNSUPPORTED` で拒否します。fallback fontは横書きで埋め込むためです。判定はfont自身のwriting modeによるもので、text matrixによる回転は拒否しません
- 同じeditorでfallback置換した箇所の再編集は `FALLBACK_EDIT_REQUIRES_SAVE` で拒否します（1つの描画命令を複数へ組み替えるため、その箇所のbyte位置が古くなります）。`save()` して開き直せば編集できます。同一editor内でも未置換の箇所は続けて置換できます。`searchText()` は置換後の内容を返すため、古い文字列を検索結果として返すことはありません。なお保存前の同一editorでは置換箇所が1つのrunとして扱われるため前後と連結して検索されますが、保存して開き直すとfont境界で分かれます
- fallback fontを一度使用した後の `setFallbackFont()` は `FALLBACK_FONT_ALREADY_IN_USE` で拒否します。置換済みテキストはそのfontのglyph IDを保持しているため、別fontへ差し替えると別の文字になってしまうためです
- 置換不能な文字を `error.characters` / `check.characters` として構造化して返します。利用側がCMapやglyphを解釈せずに「この文字は使用できません」と表示できます
- テストと動作確認には **BIZ UDGothic Regular 1.05**（SIL Open Font License 1.1）を使用しています。fontはengineに同梱せず、**呼び出し側がbytesを渡す**方式です。**engineは実行時に一切ネットワークアクセスしません**
- fallbackを使用した保存では、埋め込んだfont全体ぶんファイルサイズが増えます（BIZ UDGothicで約3MB）。subset化は未実施です
- **fontの埋め込みは1文書につき1回だけ**です。同一editor内はもちろん、`save()` → 開き直して置換を続けた場合も、engineが以前埋め込んだfontを検出して再利用します（widthsとToUnicode CMapだけを更新するため、2回目以降の保存の増分は数KBです）。1置換ごとにsave/reopenする利用でもファイルが膨らみません
- 埋め込み済みfontの同一判定は **font programのSHA-256** で行います。既存fontへ書き足すということは、そのfontのglyph IDで新しい文字を書くことなので、同一familyの別ビルド（名前もサイズも同じでglyph番号が異なり得る）を取り違えると、後から追加した文字だけが別の字形になり得るためです。digestが一致しない場合は別fontとして追加で埋め込みます
- ToUnicode CMapの `beginbfchar` を仕様どおり100件ずつに分割します（101件以上の1グループは不正）。1文書で100種類を超える文字をfallbackで使っても正しいCMapを生成します
- **HTTP運用（HTTPS化なし）を正式な動作要件としました。** `crypto.subtle`（Web Crypto API）は secure context 限定のため、庁内IISがHTTPで配信するページには存在しません（`localhost` / `127.0.0.1` は例外扱いのため、Node testもPlaywright testもこの状態を再現できていませんでした）。hash計算とAES-CBC復号は、Web Cryptoが使える環境ではWeb Cryptoを、使えない環境ではJavaScript実装を使うようになり、**fallback fontを含む全機能がHTTP配信下で動作します**。hashのJavaScript実装は自前実装ではなく [@noble/hashes](https://github.com/paulmillr/noble-hashes)（MIT、監査済、依存0）です
- CIは全testを2回実行します（通常、およびprocessからWeb Cryptoを取り除いた状態）。`npm run test:no-subtle` としてローカルでも実行できます
- browser bundle（`dist/idontlovepdf-engine.js`）から利用できます。font parserとhash実装を含むため bundle は約116KB → 約488KBになりました
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
