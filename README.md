# idontlovepdf-engine

既存 PDF の content stream にあるテキスト表示オペランドを、ブラウザ内だけで置換する PDF 処理エンジンです。Apryse WebViewer や Foxit PDF SDK for Web が提供する「既存本文編集」のうち、最小限の置換処理を、サーバー送信・外部 API・実行時依存パッケージなしで実現します。

> **スコープ:** PDF の文字列は、見た目の文章ではなく、フォント固有の文字コードと描画命令です。本エンジンはレイアウトを再構成せず、既存の `Tj`、`TJ`、`'`、`"` の文字列オペランドを置換します。行の折返し、段落の再流し込み、ページ全体の再レイアウトは行いません。元 PDF の font で書けない文字は、呼び出し側が渡した fallback font を埋め込んで描画できます（`Tj` は v0.4.0、`TJ` は v0.4.1 から。いずれも**後続文字の位置を維持できることを証明できる範囲に限り**対応し、それ以外は拒否します）。**任意の PDF を完全に編集できることを保証するものではありません。** 暗号化 PDF は認証・復号・検索まで対応しますが、**暗号化 PDF への変更の再保存（再暗号化）は未対応**です。複数の text run にまたがる一致で置換前後の文字数が変わる場合は、**engine が安全性を証明できる構造に限って**対応し、それ以外は拒否します（理由と対応範囲は [`replaceTextMatch()`](#await-editorreplacetextmatchmatchid-replacement) を参照）。

## 目的・位置付け

このリポジトリは PDF 編集エンジンそのものを開発する `idontlovepdf-engine` です。今後、

- **`idontlovepdf-engine`** = PDF 処理エンジン（このリポジトリ）
- **`idontlovepdf`** = 一般利用者向け PDF 編集 UI（別リポジトリ）

として責務を分離します。このリポジトリの役割は、`idontlovepdf` を含む外部リポジトリから安定して利用できる、依存なしの browser 向け ES Module bundle を作れる状態にしておくことです。このリポジトリ単体では一般利用者向け UI は提供せず、後述の GitHub Pages ブラウザ PoC は PDF 互換性検証用のコンソールにとどまります。

## 対応済み主要PDF構造

- literal string と hexadecimal string、および `TJ` 配列
- 無圧縮および `/FlateDecode` content stream。`/DecodeParms /Predictor`（TIFF Predictor 2 の 8bit、PNG Predictor 10〜15）
- classic xref と `/Length` からのオブジェクト境界解析（本文中の `endobj` 等を境界と誤認しない）
- PDF 1.5 以降の **cross-reference stream**（`/Type /XRef`）。classic xref との `/Prev` 混在、Predictor 付きの xref stream にも対応
- **Object Stream**（`/Type /ObjStm`）。xref のtype 2 entryを解決し、Catalog/Pages/Page/Resources/Font 等の通常 dictionary が Object Stream 内に格納されていても本文抽出を継続
- Catalog → Pages → Page → Contents をたどり、ページ本文以外の stream を除外
- content stream 内の dictionary operand（`<< ... >>`、marked-content の `BDC`/`DP` 等）を構造的に skip し、本文runと誤認しない
- 既存フォントの `/ToUnicode` CMap（`bfchar`・`bfrange`）による Unicode 復号と再エンコード。日本語本文の抽出・置換を含む
- **Standard Security Handler R4 / AESV2**、および **R6 / AESV3（AES-256）** で暗号化された PDF の user/owner password 認証・復号（`/P` の文書変更 permission を尊重）。R6 の `/O`・`/U` zero-padding 互換形式にも対応
- **複数の text run へ分割された語句の検索・置換。** PDF は 1 つの語を複数の text-showing operand として描画することがあり（`令和6年度` が `[(令) 120 (和) -20 (6) 0 (年) 0 (度)] TJ` の 5 operand など）、その場合でも `searchText()` が 1 件の一致として扱います
- **元 PDF の font に無い文字への置換**（`setFallbackFont()` で渡した TrueType font を埋め込み、書けない文字だけそちらで描画）
- 非暗号化 PDF での既存文字置換
- 元ファイルを壊さず、PDF incremental update として変更を追記。保存後の再読込みに対応

対応範囲外・既知の制約（詳細は各モジュールのコメントを参照）:

- `/ASCII85Decode`、画像化された文字（OCR 相当）は未対応
- 暗号化 PDF は `Standard` ハンドラの上記 2 組（R4/AESV2, R6/AESV3）のみ対応。`/R 2`・`/R 3`・`/R 5`・`/Adobe.PubSec` 等は診断のみで停止
- **暗号化 PDF への変更の保存（再暗号化）は未対応**。変更がなければ元 bytes をそのまま返せます
- ページ座標・フォントサイズは公開していません。置換後の文字幅に応じた再レイアウトはしません
- 元 PDF の font に無い文字へ置換するには `setFallbackFont()` で font を渡す必要があります。渡さない場合は `FONT_ENCODING_UNSUPPORTED` になります
- fallback font を使うと font 全体が埋め込まれ、ファイルサイズが数 MB 増えます（subset 化は未対応）
- fallback font で置換した箇所は前後と font が変わるため、**保存して開き直した後**は `searchText()` で前後をまたいだ 1 つの文字列としては検索されません（置換した文字列自体は検索できます）。保存前の同じ editor では、その run はまだ 1 つの run として扱われるため前後と連結して検索されます。この差が問題になる場合は `save()` して開き直してください
- 複数の text run にまたがる一致で文字数が変わる置換は、対象 run 間に他の operator がなく、かつ対象 run 間の `TJ` numeric adjustment の合計が 0 の場合のみ対応します。字間調整が残る場合や `Tc`/`Tw`/`Tz`/`Tr`・色指定・marked content をまたぐ場合は `error.code = "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED"` として拒否します（同じ文字数への置換と削除は構造によらず可能です）
- `TJ` 置換で後続位置を維持するために必要な glyph 幅は、PDF 自身の `/Widths`・`/W`・`/DW`（間接 object も解決）からのみ取得します。`/Identity-H` 以外の `/Encoding`、Type 3 font、`/Widths` の無い標準 14 font などは幅を確定できないため `FALLBACK_FONT_METRICS_UNAVAILABLE` で拒否します
- 字間調整（`TJ` の numeric adjustment）の削除・合算・再計算、glyph 幅からの文字送り計算、text matrix の再構成は行いません
- 検索は `Td` / `TD` / `Tm` / `T*`、別 `BT ... ET`、font 変更等をまたぎません。これらをまたいで 1 つの語が描画されている PDF では、その語は分断されたまま検索されます

## 正式公開API と 内部実装

外部リポジトリ（`idontlovepdf` を含む）から利用してよいのは `src/index.js`（および bundle 後の `dist/idontlovepdf-engine.js`）が export する、以下の**正式公開 API のみ**です。

```ts
import { PdfTextEditor, ENGINE_VERSION } from "@idontlovepdf/engine"; // またはbundle経由
```

**高レベル API（一般利用側はこちらを使ってください）**

- `await editor.setFallbackFont(fontBytes)` — 既存 font で書けない文字用の font を渡す（任意）
- `await editor.searchText(query, password?)` — 利用者が見える文字列として本文を検索する
- `await editor.checkTextMatchReplacement(matchId, replacement)` — その置換が可能かを、何も変更せずに判定する
- `await editor.replaceTextMatch(matchId, replacement)` — 検索結果をそのまま置換する

**低レベル API（デバッグ・技術検証用途。互換のため維持）**

- `await editor.listTextRuns(password?)` — content stream の text-showing operand を 1 件ずつ返す
- `await editor.replaceText(id, replacement)` — その run 1 件を丸ごと置換する

**共通**

- `new PdfTextEditor(bytes)`
- `await editor.save()`
- `ENGINE_VERSION`（文字列。エンジンのバージョン、後述）

`listTextRuns()` が返す run は**語ではなく描画命令の断片**です。PDF が `令和6年度` を 1 文字ずつ別の operand として描画していれば run も 5 件に分かれるため、run の `text` を部分一致検索しても 1 文字しか見つかりません（v0.2.0 で実際に問題になった構造です）。どの run を連結してよいかの判断には content stream・`BT ... ET`・text positioning operator・font の知識が要るため、**その判断は engine 側の責務**とし、`searchText()` として提供しています。利用側で `listTextRuns().map((run) => run.text).join("")` のように連結しないでください。ページ上の離れた位置に描画された文字まで 1 つの文字列として扱ってしまいます。

`PdfStructure`、xref parser、`Predictor`、CMap internals、Object Stream parser、暗号化 internals、AES primitives など、`src/` 配下の他のモジュールは**内部実装**であり、いつでも変更され得ます。外部リポジトリはこれらを直接 import しないでください。（`test/` 配下がテスト目的でこれらを直接 import しているのは、内部実装の回帰テストのためであり、公開契約ではありません。）

## API利用例

```js
import { PdfTextEditor, ENGINE_VERSION } from "./idontlovepdf-engine.js";

const bytes = new Uint8Array(await file.arrayBuffer());
const editor = new PdfTextEditor(bytes);

console.log(ENGINE_VERSION);

// 検索。PDF 内部で "令"/"和"/"6"/"年"/"度" と 5 run に分かれていても 1 件の一致になる。
const matches = await editor.searchText("令和6年度");
console.log(matches.length, matches[0].text, matches[0].runCount);

// 置換可否の事前判定。run 数や TJ 構造を利用側が見る必要はない。
const check = await editor.checkTextMatchReplacement(matches[0].id, "令和7年度");
console.log(check); // { allowed: true, mode: "same-length" }

// 置換。run 単位へ分解して replaceText() を複数回呼ぶ必要はない。
await editor.replaceTextMatch(matches[0].id, "令和7年度");

const output = await editor.save();
const url = URL.createObjectURL(new Blob([output], { type: "application/pdf" }));
downloadLink.href = url;
```

`/ToUnicode` CMap に対象文字の逆引きが存在する日本語 PDF では、通常の Unicode 文字列を直接渡せます。CMap がない、または逆引きできない特殊な font では、低レベル API の `replaceText()` に、既存 font の文字コードへエンコードした `Uint8Array` を直接指定することもできます。

暗号化 PDF では、`listTextRuns()` はまず空パスワードで自動認証を試み、失敗すると `passwordRequired: true` を持つ `Error` を投げます。`await editor.listTextRuns(password)` のように password を指定して再試行できます。

### `new PdfTextEditor(input)`

`ArrayBuffer` または `Uint8Array` の PDF を読み込みます。classic xref table・cross-reference stream・両者が `/Prev` で混在する構成のいずれにも対応します。実際の解析（および暗号化 PDF の認証・復号）はコンストラクタでは行わず、最初の `listTextRuns()`（内部的には `replaceText()`・`save()` も経由）呼び出し時に遅延して行われます。

### `await editor.searchText(query, password?)`

**利用者が見える文字列としての本文検索**です。PDF が語をどう分割して描画していても、engine が「連続した本文」と判断できる範囲を 1 つの文字列として検索します。一致ごとに以下を返します。

```js
[
  {
    id: "…",          // engine が解釈する opaque ID。replaceTextMatch() へそのまま渡す
    text: "令和6年度", // 一致した文字列
    before: "申請は",  // 直前の最大 12 code point
    after: "です",     // 直後の最大 12 code point
    runCount: 5,      // その一致が PDF 上いくつの描画命令に分かれているか（参考情報）
    fontName: "FJP"
  }
]
```

**連結する範囲**: 同じ content stream の中で、同じ `BT ... ET` に属し、間に位置や font を変える operator がない text-showing operand どうしだけです。`TJ` 配列内の数値は字間調整であって本文の区切りではないため、`[(令) 120 (和)] TJ` は `令和` に一致します。連続した `(令) Tj (和) Tj` も同様です。保存時に字間調整を削除・再計算することはありません。

**連結しない境界**（またいで検索しません）:

- 別の content stream object
- 別の `BT ... ET`ブロック、および `ET` → `BT`
- 明確な位置変更: `Td` / `TD` / `Tm` / `T*`
- 改行動作を含む text-showing operator `'` / `"`（直前の文字列とは連結しません）
- `Tf` による font 変更（複数 font にまたがる置換は安全なエンコード先を決められないため、検索の時点で切ります）
- 上記以外でも、位置・font を変えないと確認できていない operator はすべて境界として扱います。位置も font も変えない operator（`Tc`・`Tw`・`Tz`・`Tr`・`TL`・色指定・marked content の `BDC`/`EMC` 等）だけが連続とみなされます

**match ID は opaque** です。内部形式に依存しないでください。ID は**同じ editor インスタンスの、直近の `searchText()` 呼び出しの分だけが有効**で、次の `searchText()` を呼ぶと無効になります（無効な ID は `error.code = "UNKNOWN_MATCH"`）。

**空文字列の検索は拒否します。** 全 run に一致させることはせず、`error.code = "EMPTY_QUERY"` の `Error` を投げます。

同じ文字列が複数ある場合は、それぞれ別の一致（別の ID）として返します。

### `await editor.setFallbackFont(fontBytes)`

**元 PDF の font で書けない文字を書くための font を渡します（任意）。**

PDF の埋め込み font は通常 subset 化されており、`/ToUnicode` にはその文書が実際に使った文字しか載りません。つまり**元 PDF に一度も出てこない文字へは置換できない**のが既定の状態です（`令和 → 平成` は成功しても `令和 → しょうわ` は `FONT_ENCODING_UNSUPPORTED`）。fallback font を設定すると、engine がその font を PDF へ埋め込み、**書けない文字に限って**そちらで描画します。

```js
const editor = new PdfTextEditor(bytes);
// font の bytes は呼び出し側が用意します（engine は一切ダウンロードしません）
await editor.setFallbackFont(fontBytes);

const matches = await editor.searchText("令和");
await editor.replaceTextMatch(matches[0].id, "しょうわ");  // 既存 font には無い文字
```

- **設定するだけで自動的に使い分けます。** `checkTextMatchReplacement()` / `replaceTextMatch()` は常に元 PDF の font を先に試し、書けない文字があるときだけ fallback font を使います。利用側が二重のロジックを持つ必要はありません
- **未設定なら従来どおり**の挙動です（書けない文字は `FONT_ENCODING_UNSUPPORTED`）
- font は **TrueType**（`glyf` outline）である必要があります。それ以外は `FALLBACK_FONT_INVALID` で拒否します
- **一度 fallback font で置換した後は、別の font へ変更できません**（`FALLBACK_FONT_ALREADY_IN_USE`）。置換済みテキストはその font の glyph ID を保持しているためです。まだ使用していなければ変更できます
- **engine は実行時に外部通信しません。** font は呼び出し側がローカル asset 等から読み込んで渡してください
- 使用すると **font 全体が PDF へ埋め込まれ、ファイルサイズが増えます**（日本語 font で数 MB）。subset 化は行っていません
- **font が埋め込まれるのは 1 文書につき 1 回だけ**です。同じ editor 内で何回置換しても、また `save()` して開き直してから置換を続けても、engine は以前埋め込んだ同じ font を見つけて再利用します（2 回目以降の保存で増えるのは数 KB です）。同一判定は **font program の SHA-256** で行うため、名前やサイズが同じでも中身の異なる font を取り違えることはありません（その場合は別 font として追加で埋め込まれます）

動作確認には [BIZ UDGothic](https://github.com/googlefonts/morisawa-biz-ud-gothic)（SIL Open Font License 1.1）を使用しています。engine には同梱していません。

#### fallback font で置換できる構造

`mode` は「何を置換したか」を表します。`Tj` で描画されていても `TJ` で描画されていても同じ `mode` を返します（どちらで描画されているかを利用側が知る必要はありません）。

| `mode` | 内容 |
| --- | --- |
| `fallback-font` | run 全体の置換。**文字数が変わっても可** |
| `fallback-font-partial` | run の一部だけを置換し、前後は元 font のまま維持（`申請は令和です → 申請はしょうわです`） |
| `fallback-font-multi-run` | 複数 run にまたがる match を 1 つとして描画 |

対応可能かどうかは、描画している operator によって条件が異なります。

**`Tj` で描画されている場合**（v0.4.0 から変更なし）

**match の終端位置から他のテキストが描画されない**（直後が `ET` / `BT`、または `Td` / `TD` / `Tm` / `T*` で位置が設定し直される）場合に限ります。fallback font の文字幅は元 font と同じではないため、そこから続けて描画されるテキストがあると動いてしまうためです。複数 run にまたがる場合の隣接判定は `variable-length-safe` と同じ規則です。

**`TJ` で描画されている場合**（v0.4.1 で追加）

v0.4.0 では `TJ` は一律 `FALLBACK_OPERATOR_UNSUPPORTED` で拒否していました。v0.4.1 では、**後続文字の開始位置が置換前と完全に一致することを証明できる範囲に限り**対応します。

`TJ` は「文字列と字送り数値の並び」を順に処理する operator で、隣接する `TJ` operator の境界そのものは何もしません。そのため match が含まれる `[` から最後の `TJ` までを 1 つの列として扱い、次の形へ組み替えます。

```text
置換前: [(令和) -50 (8年度)] TJ
置換後: /ILPFallback 36 Tf [<しょ>] TJ /FJP 36 Tf [50 -50 (8年度)] TJ
```

match の外にある要素（`-50` や前後の string operand）は**元の byte をそのまま複製**します。数値の再フォーマット・並べ替え・統合・欠落・重複は起きず、`0` / `+0` / `-0` / `0.0` も書かれたとおりに残ります。engine が新しく書くのは先頭の 1 つの adjustment（上の `50`）だけです。

その値は推測ではなく計算で求めます。PDF の字送りは

```text
tx = ((w0 - Tj/1000) * Tfs + Tc + Tw) * Th
```

であり、glyph 幅 `w0` と adjustment `Tj` はどちらも `Tfs * Th` 倍されるため、両者を等しく置く式から **font size と horizontal scaling は消えます**。残るのは glyph space（1/1000 em）同士の比較で、書くべき adjustment は

```text
n = (置換文字列の合計幅) - (元の match の合計幅) + (match 内部にあった adjustment の合計)
```

になります。元の幅は**その PDF 自身の `/Widths`（simple font）または `/W`・`/DW`（CID font）**から、置換後の幅は**埋め込む fallback font の `/W` に実際に書き込む値**から取ります。どちらも PDF reader が実際に位置決めに使う数値です。「日本語だからどれも全角」のような仮定は使いません。

上の式が成立するには `Tc` と `Tw` の項が相殺する必要があり、これは仮定せず条件として課します。

- `Tc`（character spacing）が 0 でない場合、**置換後の glyph 数が元と同じときだけ**許可します（`Tc` の項が相殺するため）。異なる場合は `FALLBACK_CHAR_SPACING_UNSUPPORTED` で拒否します
- `Tw`（word spacing）は 1 バイトの文字コード 32 にしか効かず、fallback font は 2 バイト符号化なので置換側には効きません。match が 1 バイトのスペースを含み、かつ `Tw` が有効な場合は `FALLBACK_WORD_SPACING_UNSUPPORTED` で拒否します
- `Tc` / `Tw` の値が追跡できない場合（対応する `q` のない `Q`、`"` operator など）は 0 とみなさず拒否します

match の終端から**何も描画されない**場合（match が列の末尾で、直後が `ET` / `BT` / `Td` / `TD` / `Tm` / `T*`）は adjustment 自体が不要なので書きません。この場合は font metrics も必要ありません（`Tj` と同じ扱いです）。

`TJ` でも次の場合は**引き続き拒否**します。

- 元 font の glyph 幅を正確に読み取れない（下記「font metrics をどこから読むか」を参照）→ `FALLBACK_FONT_METRICS_UNAVAILABLE`
- 上記の `Tc` / `Tw` の条件を満たさない → `FALLBACK_CHAR_SPACING_UNSUPPORTED` / `FALLBACK_WORD_SPACING_UNSUPPORTED`
- match の operand 間に `Tc` / `Tw` / `Tz` / `Tr` / 色指定 / marked content などがある（異なる text state で描画されているものを 1 つとして描き直すことになるため）→ `FALLBACK_MULTI_RUN_UNSUPPORTED`
- 配列の外に数値が書かれている等、対象範囲を `[`・`]`・string・数値・`TJ` だけの列として読み切れない（配列外の数値は reader が字送りとして扱わないため、字送りとみなすと位置がずれる）→ `FALLBACK_LAYOUT_UNSUPPORTED`
- 縦書き font / writing mode 不明 → `FALLBACK_WRITING_MODE_UNSUPPORTED`（v0.4.0 と同じ）
- match が `Tj` と `TJ` にまたがる → `FALLBACK_OPERATOR_UNSUPPORTED`

**font metrics をどこから読むか**（v0.4.2 で対応範囲を拡大）

上の計算に使う「元の幅」は、**その PDF 自身の font dictionary の値**です。PDF reader が位置決めに使う数値がそれであり、埋め込み font program の `hmtx` は見ません（reader はそれを無視してよいため、一致するとは限りません）。

v0.4.1 では、この値が font dictionary の中に**直接**書かれている場合しか読めませんでした。実際の PDF では `/Widths` や `/W` を独立した indirect object として書く writer が多く、その場合は幅を取得できず `FALLBACK_FONT_METRICS_UNAVAILABLE` になっていました。v0.4.2 では、engine が既に持っている object resolver を通して次を解決します。

- simple font（`/Type1`・`/TrueType`・`/MMType1`）の `/Widths`・`/FirstChar`・`/MissingWidth`
- CID font（`/Type0` + `/Encoding /Identity-H`）の `/DescendantFonts`・`/W`・`/DW`

解決するのは**どこに数値があるか**だけで、値そのものは従来どおり PDF が書いた数値をそのまま読みます（間接 number は `999.5` のような実数も対象。指数表記は PDF number ではないため拒否します）。推測は一切しません。次はこれまでどおり拒否します。

- `/Encoding` が `/Identity-H` 以外（predefined CMap も embedded CMap stream も）。code から CID を一意に決められないため。`/ToUnicode` から CID を逆算することはしません（ToUnicode は Unicode 抽出用で、code → CID とは限らないため）
- Type 3 font（幅が font 自身の glyph space にあるため）、`/Widths` を持たない標準 14 font
- 参照先の object が存在しない、数値の配列として読めない、`/DW` や `/FirstChar` が数値でない
- font program の `hmtx` しか手掛かりがない場合

拒否の内訳は開発者向けに `unsafeReason`（`w-unresolved`・`widths-unresolved`・`invalid-width-array`・`non-identity-encoding`・`embedded-cmap-encoding`・`unsupported-type3` など）として返します。公開 `code` は `FALLBACK_FONT_METRICS_UNAVAILABLE` のままです。実 PDF の構造を確認するには `node scripts/diagnose-font-metrics.js <file.pdf> [--text 令和] [--font F3]` を使ってください（読み取り専用・ネットワークアクセスなし）。`/Type0` font については `/DescendantFonts` の解決過程を 1 hop ずつ表示します（dictionary が書いている生の値、direct array か indirect reference か、各参照先が実際に何だったか、xref 上で通常 object か Object Stream 内か）。この trace は幅計測が呼ぶ `resolveDescendantFont()` 自身が記録するため、`descendant-font-unresolved` を「どの hop で失敗したか」まで読み取れます。→ [descendant font の診断](docs/descendant-font-diagnosis.md)

**`'` / `"` は対象外です**（`FALLBACK_OPERATOR_UNSUPPORTED`）。これらは描画前に改行を伴うため、いずれの組み替えでも扱えません。v0.4.1 で `TJ` に対応したこととは切り離しています。

段落の再流し込み・行の折り返し・ページ全体の再レイアウトは行いません。目的は「元 PDF が指定している後続文字位置を維持したまま、限定的に fallback font で文字を差し替える」ことです。**「`TJ` に対応したので任意の PDF を編集できる」わけではありません。**

**縦書き font** で描画されたテキストは置換できません（`FALLBACK_WRITING_MODE_UNSUPPORTED`）。fallback font は横書き（`/Identity-H`）で埋め込むためです。判定に使うのは font 自身の writing mode で、text matrix による回転は対象外です（回転した横書き font は置換できます）。

**同じ editor で fallback 置換した箇所を再度編集することはできません**（`FALLBACK_EDIT_REQUIRES_SAVE`）。fallback 置換は 1 つの描画命令を複数へ組み替えるため、engine が保持している byte 位置がその箇所については古くなります。`save()` して開き直せば通常どおり編集できます。同じ editor でも、**まだ置換していない箇所**は続けて置換できます。なお `searchText()` は置換後の内容を返すため、古い文字列が検索結果に残ることはありません。

word spacing（`Tw`）が有効な箇所では、置換文字列に**半角スペースを含められません**。`Tw` は 1 バイトの文字コード 32 にのみ効き、fallback font は 2 バイト符号化で描画されるため、文書内の他のスペースと同じ字間になりません。

部分置換では、置換後の文字列の幅に応じて**後続文字が自然に前後します**（`申請は令和です → 申請はしょうわです` なら `です` が後ろへ移動します）。これは通常のテキスト編集として期待される挙動です。

### `await editor.checkTextMatchReplacement(matchId, replacement)`

その置換が可能かどうかを、**何も変更せずに**判定します。可否の判断に PDF 内部構造の知識が要るため、利用側が `runCount` や `TJ` 構造を見て判断する必要はありません（`runCount` は表示用の参考情報です）。

```js
await editor.checkTextMatchReplacement(id, "令和7年度");
// → { allowed: true, mode: "same-length" }

await editor.checkTextMatchReplacement(id, "今年度");
// → { allowed: false, mode: null,
//      code: "MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED",
//      reason: "...", unsafeReason: "non-zero-tj-adjustment" }
```

`mode` は置換が **どう書かれるか** を表します。

| `mode` | 意味 |
| --- | --- |
| `single-run` | 一致が 1 つの run に収まる。run 全体を書き直すため文字数は自由 |
| `same-length` | 複数 run・同じ文字数。元の run 境界へ配分する |
| `delete` | 複数 run の削除。各 run が自分の担当部分だけを空にする |
| `variable-length-safe` | 複数 run・異なる文字数。後述の安全な構造に限る |

拒否の場合は `code`（後述の表）と `reason` を返し、**例外は投げません**。「可能か？」という問い合わせ自体は誤りではないためです。

この判定は `replaceTextMatch()` と**同一の内部 replacement plan** を使います。したがって「事前判定では `allowed: true` だったのに実行時に構造上非対応で失敗する」ことはありません。既存 font にその文字の glyph がない場合（`FONT_ENCODING_UNSUPPORTED`）も、実際に encode を試すためここで検出できます。

### `await editor.replaceTextMatch(matchId, replacement)`

`searchText()` の一致を、またがっている run すべてにわたって置換予約します。利用側が run 構造を理解する必要はありません。判定内容は `checkTextMatchReplacement()` と同一です。

- **一致が 1 つの run に収まる場合**は、`replaceText()` と同じ「run 全体の書き換え」になります。文字数が変わっても構いません
- **複数 run にまたがり、文字数が同じ場合**は、各 run が元の一致へ提供していた文字数と同じ配分で置換文字列を割り当てます。`申請は令` + `和6年` + `度です` を `令和6年度` → `令和7年度` で置換すると `申請は令` + `和7年` + `度です` になります。string operand の数、`TJ` の numeric adjustment、operator 構造はそのまま維持します
- **`replacement` に空文字列を渡すと削除**になります。一致に完全に含まれる operand は空文字列の operand として残り、content stream を組み直すことはしません（incremental save 方針を維持するため）
- 一致の前後にある文字（prefix / suffix）は、いずれの場合も失われません

#### 複数 run にまたがる、文字数が変わる置換（`variable-length-safe`）

対象 run どうしが**次の 2 つを同時に満たす場合に限り**対応します。

- **対象 run 間に他の operator が一切ない**こと（`Tc`・`Tw`・`Tz`・`Tr`・色指定・marked content などが挟まっていない）
- **対象 run 間の `TJ` numeric adjustment の合計が 0** であること

adjustment の合計は、その数値が**どこに書かれているかによらず**取ります。`TJ` の数値は次の文字列を字送りするため、配列の途中にあっても、配列の末尾にあっても、次の配列の先頭にあっても同じ意味を持つからです。

```text
[(実) 0 (績)] TJ              → 合計 0   : 隣接とみなす
[(実)] TJ [(績)] TJ           → 合計 0   : 隣接とみなす
(実) Tj (績) Tj               → 合計 0   : 隣接とみなす
[(実) 120] TJ [-120 (績)] TJ  → 合計 0   : 相殺されるため隣接とみなす
[(実) 120 (績)] TJ            → 合計 120 : 拒否
[(実) 120] TJ [(績)] TJ       → 合計 120 : 拒否（配列末尾でも同じ字送り）
(実) Tj [120 (績)] TJ         → 合計 120 : 拒否（次の配列先頭でも同じ字送り）
```

`0.0`・`+0`・`-0`・`-0.0` のような表記も、文字列としてではなく PDF の数値として 0 と判定します。なお `/F1 12 Tf` の `12` や `72 700 Td` の `72 700` は operator 自身の operand であり、字送りとしては数えません。

この条件下では、合計 0 の adjustment は文字送りを動かさず、空の string operand は何も描画せず何も進めません。つまり描画結果は **operand の連結だけで決まり、文字がどの operand に入っているかには依存しません**。そこで置換文字列全体を先頭の対象 operand へ入れ、残りの対象 operand を空にします。operand 数・operator 構造・adjustment はすべて元のまま保たれ、結果は既存の単一 run 置換と同じものになります。glyph 幅の推測も、text matrix の再計算も行いません。

```text
置換前: [(申請は) 120 (実) 0 (績) 0 (報告書) -35 (です)] TJ
置換後: [(申請は) 120 (報告書) 0 <> 0 <> -35 (です)] TJ      ← 実績報告書 → 報告書
```

対象 run 間の adjustment の**合計が 0 でない**場合、または `Tc` / `Tw` / `Tz` / `Tr` / 色指定 / marked content（`BDC`・`EMC` 等）がある場合は**拒否**します。前者は特定の 2 文字の間隔として指定されたものであり、文字を動かした後に何であるべきかを決め直すことになるため。後者は 2 つの operand が異なる text state で描画されているため、文字をまたいで動かすと PDF が指定した見た目と変わってしまうためです。いずれも推測で埋めることはしません。

なお `Td` / `TD` / `Tm` / `T*`、別 `BT ... ET`、font 変更は `searchText()` の時点で連結しないため、そもそもそれらをまたぐ一致は存在しません。

#### エラー

`checkTextMatchReplacement()` は下表を `code` として返し、`replaceTextMatch()` は同じ `code` を持つ `Error` を投げます。

| `error.code` | 意味 |
| --- | --- |
| `MULTI_RUN_LENGTH_CHANGE_UNSUPPORTED` | 複数 run にまたがる一致で、上記の条件を満たさないため文字数を変えられない。`unsafeReason` に `non-zero-tj-adjustment` / `text-state-boundary` / `unsupported-topology` のいずれかが入ります |
| `MULTI_RUN_FONT_CHANGE_UNSUPPORTED` | 一致が複数 font にまたがる（検索側で font 変更を境界にしているため通常は発生しません） |
| `FONT_ENCODING_UNSUPPORTED` | 既存 font にその文字の glyph がなく、fallback font も設定されていない。`characters` に該当文字が入ります |
| `FALLBACK_FONT_MISSING_GLYPH` | fallback font にもその文字の glyph がない。`characters` に該当文字が入ります |
| `FALLBACK_FOLLOWING_TEXT_POSITION_UNSAFE` | `Tj` で描画された match の終端位置から他のテキストが描画されるため、font を変えると位置が動く |
| `FALLBACK_FONT_METRICS_UNAVAILABLE` | `TJ` で描画された match の後ろにテキストがあるが、元 font の glyph 幅を正確に読み取れないため後続位置を維持できない |
| `FALLBACK_CHAR_SPACING_UNSUPPORTED` | `Tc` が有効な `TJ` で、置換後の glyph 数が元と異なるため後続位置を維持できない |
| `FALLBACK_OPERATOR_UNSUPPORTED` | 対象が `'` / `"` で描画されている、または match が `Tj` と `TJ` にまたがっている |
| `FALLBACK_MULTI_RUN_UNSUPPORTED` | 複数 run の match が単純に隣接していない |
| `FALLBACK_LAYOUT_UNSUPPORTED` | ページ構造上、fallback font を安全に配置できない |
| `FALLBACK_WORD_SPACING_UNSUPPORTED` | word spacing（`Tw`）が有効な箇所で、置換文字列に半角スペースが含まれる。または `TJ` で、match が 1 バイトのスペースを含む |
| `FALLBACK_FONT_INVALID` | `setFallbackFont()` に TrueType font 以外が渡された |
| `FALLBACK_WRITING_MODE_UNSUPPORTED` | 縦書き font（`/Identity-V`、`/WMode 1` 等）、または writing mode が判定できない font で描画されている |
| `FALLBACK_EDIT_REQUIRES_SAVE` | 同じ editor で fallback 置換済みの箇所を再度編集しようとした。`save()` して開き直してください |
| `FALLBACK_FONT_ALREADY_IN_USE` | fallback font を使用した後に別の font を設定しようとした |
| `MATCH_STALE` | 検索時点の文字列が現在の文書内容と食い違う。古い match ID で別の場所を書き換えないための保護です |
| `UNKNOWN_MATCH` | この editor が発行していない、または次の `searchText()` で無効になった match ID |
| `MODIFICATION_NOT_PERMITTED` | 暗号化 PDF の `/P` が文書変更を許可していない |
| `EMPTY_QUERY` | `searchText()` に空文字列が渡された |

置換は **atomic** です。対象 run すべての encode に成功してから一括で反映するため、途中で encode に失敗して「一部の run だけ書き換わった」状態にはなりません。

文字数は UTF-16 code unit ではなく **Unicode code point**（`[...text]` 相当）で数えます。サロゲートペアは 1 文字です。grapheme cluster 単位の結合は行いません。

置換文字の書き込みには、その run が使っている**既存 font の CMap** を使います。

### `await editor.listTextRuns(password?)`

**低レベル API。** `{ id, objectNumber, textObjectId, fontName, text, bytes }` の配列を返します。1 件は「1 つの text-showing operand」であり、利用者が見る 1 語とは限りません（前述）。PDF 構造の調査・デバッグ用途として維持しています。`textObjectId` は、その run が属する `BT ... ET` ブロックを content stream 内での出現順に 0 から採番したものです。利用中の font に `/ToUnicode` CMap があれば `text` を Unicode へ復号します。CMap がなければ単一バイト表示にフォールバックするため、確実な調査には `bytes` も確認してください。

### `await editor.replaceText(id, replacement)`

**低レベル API。** 対象 run 1 件を文字列またはバイト列で丸ごと置換予約します。複数 run にまたがる語を置換したい場合は `replaceTextMatch()` を使ってください。CMap がある font では Unicode 文字列を既存文字コードへ逆変換します。暗号化 PDF で `/P` の文書変更 permission が許可されていない場合、認証に成功していてもここで明確なエラーを投げて拒否します。

### `await editor.save()`

変更済み PDF を新しい `Uint8Array` で返します。入力データは変更しません。保留中の変更が 1 件もなければ、暗号化 PDF でもそのまま元の bytes を返します。暗号化 PDF に対して実際に変更を保存しようとした場合はエラーになります（再暗号化保存は未対応）。

## Browserでの利用（bundle）

`dist/idontlovepdf-engine.js` は、`src/index.js` を [esbuild](https://esbuild.github.io/) で bundle した、**1 ファイル・ES Module・runtime 外部依存なしの browser 向け成果物**です。static hosting から直接 `import` できます。`setFallbackFont()` が使う TrueType parser（[opentype.js](https://github.com/opentypejs/opentype.js)、MIT）は bundle へ取り込み済みで、実行時に別途読み込むものはありません。font 本体は bundle に含まれません（呼び出し側が渡します）。

```html
<script type="module">
  import { PdfTextEditor, ENGINE_VERSION } from "./idontlovepdf-engine.js";
  // ...
</script>
```

- entry point: `src/index.js`
- format: ESM（`bundle: true`, `platform: "browser"`）
- target: `es2022`
- 実行時に必要なのは browser 標準 API（`Uint8Array`、`TextEncoder`/`TextDecoder`、`CompressionStream`/`DecompressionStream`）のみで、これらの独自 polyfill は含みません。対応していない古いブラウザでは、呼び出し側で必要な polyfill を用意してください
- **`crypto.subtle`（Web Crypto API）は必須ではありません。** HTTP配信（secure contextではない）でも全機能が動作します。詳細は[HTTP配信での動作](#http配信での動作)を参照してください
- CDN 参照・外部 API・license server などへの runtime 通信は一切行いません。選択した PDF は従来どおり browser 内だけで処理します

### `npm run build`

```sh
npm ci
npm run build
```

`scripts/build.js` が esbuild を実行し、`dist/idontlovepdf-engine.js` を生成します。`esbuild` は devDependency としてのみ使用し、生成物には含まれません（production/runtime 依存ではありません）。`opentype.js` と `@noble/hashes` は dependency で、bundle へ取り込まれます（この分、bundle は約 116KB から約 514KB になりました。v0.4.2 時点）。`npm test` は `pretest` npm script 経由でビルドを自動実行するため、`npm test` を一度実行すれば `dist/` は常に最新の状態になります。

### version 確認方法

bundle が取り込んだ engine のバージョンは `ENGINE_VERSION`（文字列）から確認できます。

```js
import { ENGINE_VERSION } from "./idontlovepdf-engine.js";
console.log(ENGINE_VERSION); // 例: "0.4.0"
```

`ENGINE_VERSION` は `package.json` の `"version"` を source of truth とし、`scripts/sync-version.js` が `src/version.js` へビルド時に同期して生成します（`package.json`・`src/index.js`・build script のいずれにも version 文字列を手作業で重複記載していません）。この engine はまだ一般向け stable API を保証する段階ではないため、`0.x` のまま運用しています。

### distの管理方針

`dist/idontlovepdf-engine.js` は Git 管理せず（`.gitignore` 対象）、GitHub Release のassetとして配布します。bundleは`src/`から機械的に再生成できるため、生成物の差分をリポジトリ履歴へ積み上げません。`idontlovepdf-engine.js.sha256`も同じReleaseに添付します。CI（`.github/workflows/ci.yml`）はpush・PRごとに`npm run build`が成功することと`dist/idontlovepdf-engine.js`が生成されることを確認します。

ReleaseはGitHubの **Actions → Release → Run workflow** から実行し、`tag`（例: `v0.4.0`）を入力します。workflowは正式な`main`をcheckoutし、`package.json`とのversion整合性確認、release note抽出、test/buildの完了後にtagとGitHub Releaseを作成します。そのため、tagを事前に作成またはpushする必要はありません。

GitHub Releaseのtitleと本文のsource of truthは[`docs/release-notes.md`](docs/release-notes.md)です。Release前に対象versionのH2 sectionを同ファイルの先頭側へ追加してください。workflowは対象H2の内容をtitle、その配下から次のH2直前までをbodyとして使用します。

## 対応browser API

`src/` 配下（および bundle）が前提とする browser 標準 API は以下です。いずれも Node.js 専用 API（`node:crypto`、`node:zlib`、`node:test`、`Buffer` 等）で置き換えていません。

- `Uint8Array`
- `TextEncoder` / `TextDecoder`
- `CompressionStream` / `DecompressionStream`（`/FlateDecode` の展開・生成）

`node:crypto`・`node:zlib`・`Buffer` 等は `test/` 配下（fixture 構築用）と `scripts/assess-corpus.js`（Node CLI）でのみ使用し、`src/` および `dist/idontlovepdf-engine.js` には含まれません。

Web Crypto API（`crypto.subtle`）は**あれば使う**位置づけで、必須ではありません（次節）。

### HTTP配信での動作

このengineは、庁内IISが**HTTPで**配信するページから利用されることを前提としています（HTTPS化は行いません）。

`crypto.subtle` は [secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts) 限定のAPIで、HTTP配信のページには**存在しません**（`window.crypto` はあるが `window.crypto.subtle` が `undefined`）。そのため、hash計算とAES-CBC復号は次のように動作します。

| 用途 | `crypto.subtle` あり | `crypto.subtle` なし（HTTP配信） |
| --- | --- | --- |
| fallback fontの同一判定（SHA-256） | Web Crypto | [@noble/hashes](https://github.com/paulmillr/noble-hashes)（`src/sha2.js`） |
| 暗号化PDF R6 の Algorithm 2.B（SHA-256/384/512） | Web Crypto | 同上 |
| 暗号化PDF AESV2/AESV3 の AES-CBC 復号 | Web Crypto | `src/security/aes-primitives.js`（FIPS 197 既知解ベクタで検証済）＋ PKCS#7 除去 |

どちらの経路も同じ結果を返します。SHA-256のdigestが一致するため、HTTPS環境で埋め込んだfallback fontはHTTP環境からも同一と判定され、逆も同様です。

`localhost` / `127.0.0.1` は secure context の例外扱いのため、Nodeのtestも Playwright（`127.0.0.1` 配信）のtestも、通常はWeb Cryptoが**使える**状態で動いてしまいます。これではHTTP配信を検証できないため、次を用意しています。

- `npm run test:no-subtle` — process から Web Crypto を取り除いた状態で全testを実行します（CIでも通常実行と2回走ります）
- `test/fallback-font-no-subtle.test.js` — `crypto.subtle` なしで `setFallbackFont()` → `令和 → しょうわ` → `save()` → 開き直しまでを検証します
- `test/browser/fallback-font.test.js` — 同じ流れを、**配布bundleを読み込んだChromiumのページから `crypto.subtle` を取り除いた状態**で検証します。`TJ` 置換後の PDF を Chromium 内蔵の PDF viewer で開く検証も含みます
- `test/fallback-font-tj.test.js` — `TJ` で描画された match の fallback 置換。PDF の字送り式を **engine とは独立に実装した simulator** で、置換前後の各 glyph の描画 x 座標を突き合わせ、後続文字が動いていないことを機械的に検証します
- `test/sha2.test.js` / `test/aes.test.js` — 両経路の出力を `node:crypto`（OpenSSL）と、および相互に照合します

## モジュール構成（公開API / 内部実装）

| ファイル | 役割 | 契約 |
| --- | --- | --- |
| `src/index.js` | 正式公開 API のエントリポイント（`PdfTextEditor`・`ENGINE_VERSION`） | **公開** |
| `src/version.js` | `package.json` から同期される `ENGINE_VERSION`（`scripts/sync-version.js`が生成） | 公開経由 |
| `src/pdf-document.js` | `PdfTextEditor` 本体 | 内部（`index.js`経由でのみ公開） |
| `src/pdf-structure.js` | xref（classic / stream）解析、object 解決 | 内部 |
| `src/object-stream.js` | `/Type /ObjStm` の header 解析・compressed object 切り出し | 内部 |
| `src/predictor.js` | `/DecodeParms /Predictor`（TIFF・PNG）の解除 | 内部 |
| `src/flate.js` | `/FlateDecode` の展開・`/Filter` 解釈 | 内部 |
| `src/cmap.js` | `/ToUnicode` CMap の解析・エンコード/デコード | 内部 |
| `src/sha2.js` | SHA-256/384/512（Web Cryptoがあればそれ、無ければ @noble/hashes） | 内部 |
| `src/fallback-font.js` | fallback font の解析・PDF font object 生成（Type0/CIDFontType2/FontFile2/ToUnicode） | 内部 |
| `src/font-metrics.js` | 元 PDF の font dictionary から glyph 幅（`/Widths`・`/W`・`/DW`）を読み取る（間接 object も解決）。`TJ` 置換で後続位置を維持するための計測に使用 | 内部 |
| `src/content-stream.js` | content stream 内のテキスト表示オペランド・dictionary operand の走査 | 内部 |
| `src/encryption.js` | `/Encrypt` 辞書の診断（復号は行わない） | 内部 |
| `src/pdf-dictionary-text.js` | 辞書 text 内の名前・文字列・真偽値・入れ子辞書の抽出 | 内部 |
| `src/security/*` | 暗号化 PDF の認証・鍵導出・AES/MD5/RC4 primitives | 内部 |
| `src/assessment.js` | 評価パイプライン本体。Node 版 CLI とブラウザ PoC で共有 | 内部（PoC専用） |
| `scripts/build.js` / `scripts/sync-version.js` | bundle 生成・version 同期スクリプト | ビルド専用 |
| `scripts/assess-corpus.js` | 実 PDF corpus 一括評価用 Node CLI | 開発者向けツール |
| `scripts/diagnose-font-metrics.js` | 実 PDF の font が glyph 幅をどう記述しているか、読めない場合はどの構造が原因かを表示する Node CLI（読み取り専用） | 開発者向けツール |
| `web/*` | GitHub Pages ブラウザ PoC の実装 | PoC専用 |

## GitHub PagesブラウザPoC

`index.html`は、この engine が**実PDFでどこまで通用するかをブラウザ内で確認するための検証コンソール**です。GitHub Pagesで公開すれば、URLを開くだけで手元の実PDFを検証できます。製品版でも一般職員向けの完成UIでもなく、`idontlovepdf`本体への組込みも行っていません。今回の bundle 化によってこの PoC の役割・実装を大きく書き換えてはいません（`web/app.js` は引き続き `src/index.js` から直接 import します）。

**PDFはブラウザ内だけで処理します。** GitHub Pagesは画面（HTML / CSS / JavaScript）の配信にのみ使い、選択したPDFはGitHub・外部API・その他サーバーへ送信しません。ブラウザPoCのコードには`fetch()`、`XMLHttpRequest`、`WebSocket`、外部CDN、外部フォント、外部APIを含みません。PDFは`<input type="file">`またはドラッグ＆ドロップから`File` → `ArrayBuffer` → `Uint8Array`として読み込み、編集結果の保存もブラウザのダウンロード機能によるローカル保存です。

### 単一PDF検証: PDFプレビュー＋文字列検索・置換

主操作は「runを直接選択して編集」ではなく「文字列を検索し、一致した箇所を置換」です。

1. 「単一PDF検証」タブでPDFを1件選ぶ（ドラッグ＆ドロップ可）
2. 選択した元PDFを、ブラウザ標準のPDF表示で`<iframe>`にプレビューする（Blob URL、送信なし）
3. `PdfTextEditor`初期化と`listTextRuns()`を実行し、検索欄を有効化する
4. 検索文字列を入力すると、engine の `searchText()` を呼び、一致箇所を一覧表示する（一致件数・前後の文脈・構成run数）
5. 一致を1件選ぶと置換後テキスト欄にその一致テキストが入り、置換後の文字列を編集できる。入力するたびに `checkTextMatchReplacement()` を呼び、その置換が可能かどうかをその場に表示する
6. 「置換してPDFを保存」を押すと、`replaceTextMatch()` → `save()` → 保存結果の再読込確認（reopen）の順に検証し、成功した場合だけ`元ファイル名.edited.pdf`としてローカル保存する

検索・置換可否判定・置換はすべて engine の高レベル API 経由です。PoC 側は run をどう連結してよいか、どの置換が安全かを一切判断しません。

暗号化PDF（対応範囲: `Standard`/`V4`/`R4`/`AESV2`、および`Standard`/`V5`/`R6`/`AESV3`〈AES-256〉。いずれも`Identity`との併用可）は、空passwordでの自動認証 → 失敗時はパスワード入力欄を表示、という流れです。入力したパスワードは送信・保存されません。対応範囲外（`/R 2`・`/R 3`・`/R 5`・`/Adobe.PubSec`など）は診断専用の画面になります。

### 複数PDF corpus評価

1. 「複数PDF評価」タブでPDFを複数選ぶ
2. 各PDFについて`load` / `extract` / `writeback` / `save` / `reopen`を評価し、表に追記
3. 「assessment.json を保存」でJSONをローカル保存

評価段階はNode版`npm run assess:corpus`と揃えてあります。`writebackMode`は`same-bytes`で、**最初のrunに元と同じbytesを書き戻す方式です。`writeback: true`は別文字への置換に成功したことを意味しません。**

```sh
npm run assess:corpus -- --json --output tmp/assessed fixtures/real-pdf > assessment.json
```

`readerDisplay`は常に`null`です。保存した編集済みPDFはAcrobat Reader等の独立したreaderで確認し、結果を人間がJSONへ追記してください。

### GitHub Pagesでの公開

リポジトリの **Settings** → **Pages** → **Source** で **Deploy from a branch** を選び、Branchに **`main`** と **`/ (root)`** を指定して保存します。手元で確認する場合は、ES Modulesの制約により`file://`で直接開けないため、静的HTTPサーバーを起動してください。

```sh
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

## 開発

```sh
npm ci
npm run test:font     # fallback font testが使う日本語font（BIZ UDGothic 1.05、約4.5MB）をtmp/へ取得。未取得だと該当testはskip
npm test              # node --test（test/*.test.js のみ）。pretestでdist/を自動ビルドし、dist経由のfixture testも実行
npm run test:no-subtle # 同じtestを、processからWeb Cryptoを取り除いた状態で実行（HTTP配信の再現）
npm run check         # src/・scripts/・web/・test/ の構文検査
npm run build         # dist/idontlovepdf-engine.js を生成
```

**`npm ci && npm test`だけで、追加インストールなしに上記が再現できます。** `npm test`が対象にする`test/*.test.js`（サブディレクトリを含みません）は Node 標準APIのみで完結し、`test/dist-bundle.test.js`（後述）を含め Playwright は必要ありません。

```sh
npx playwright install chromium   # 初回のみ（ローカルにChromiumがない場合）
npm run test:browser              # node --test（test/browser/*.test.js）。pretest:browserでdist/を自動ビルド
```

`test/browser/smoke.test.js`は実際のheadless Chromium（Playwright）で`dist/idontlovepdf-engine.js`をbrowserへ`import`し、`PdfTextEditor`・`ENGINE_VERSION`のexportと、最小PDFの`listTextRuns()`成功、複数runへ分割された日本語（`令和6年度`）の`searchText()` → `replaceTextMatch()` → `save()` → reopen、および複数runにまたがる異文字数置換（`実績報告書` → `報告書`）を確認します。後者では保存したPDFをBlob URLとしてChromium自身のPDF viewerへ読み込ませ、engineとは無関係な実装が受け付けることも確認しています。Playwrightのbrowser本体は`npm ci`だけでは用意されないため、`npm test`（Node専用）とは別の`npm run test:browser`に分離しています。CIでは`npm test` → `npm run test:no-subtle` → `npx playwright install --with-deps chromium` → `npm run test:browser`の順ですべて実行します（`.github/workflows/ci.yml`）。

`test/dist-bundle.test.js`は通常PDF・xref stream・Object Stream・ToUnicode日本語・複数runにまたがる`searchText()`/`checkTextMatchReplacement()`/`replaceTextMatch()`という代表的な組み合わせを、`src/index.js`ではなく`dist/idontlovepdf-engine.js`からimportした`PdfTextEditor`で処理し、bundle化によって主要機能が壊れていないことを確認します（Node専用APIのみで完結するため`npm test`に含まれます）。

`web/poc-core.js`はDOMに依存しないため、ブラウザPoCの純粋関数は`test/browser-poc.test.js`でNodeから直接検証しています。DOMテスト環境は追加していません。検索・置換のモデルはengine側（`src/pdf-document.js`）にあるため、`test/search-text.test.js`が`searchText()`/`replaceTextMatch()`の仕様（continuity境界・誤一致防止・複数run置換・stale match等）を、`test/variable-length-replacement.test.js`が異文字数multi-run置換の安全判定（安全構造の往復・非安全構造の拒否・事前判定と実置換の一致）を担当します。
