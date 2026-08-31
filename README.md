# idontlovepdf Local Text Editor

既存 PDF の content stream にあるテキスト表示オペランドを、ブラウザ内だけで置換する試作モジュールです。Apryse WebViewer や Foxit PDF SDK for Web が提供する「既存本文編集」のうち、最小限の置換処理を、サーバー送信・外部 API・実行時依存パッケージなしで検証できます。

> **試作の範囲:** PDF の文字列は、見た目の文章ではなく、フォント固有の文字コードと描画命令です。本モジュールはレイアウトを再構成せず、既存の `Tj`、`TJ`、`'`、`"` の文字列オペランドを置換します。行の折返し、字間調整、フォント埋込みは行いません。本PoCの成功をもって「一般的なPDFをOSSだけで編集可能」とは判定しません。

## 特長

- ブラウザ標準 API のみを使い、処理は端末内で完結
- literal string と hexadecimal string、および `TJ` 配列に対応
- 無圧縮および `/FlateDecode` content stream に対応。`/DecodeParms /Predictor`（TIFF Predictor 2の8bit、PNG Predictor 10〜15）にも対応
- classic xrefとstreamの `/Length`からオブジェクト境界を解析（本文中の`endobj`等を境界と誤認しない）
- PDF 1.5以降の**cross-reference stream**（`/Type /XRef`）に対応。classic xrefとの`/Prev`混在も可。xref stream自体がPredictor付きでも解析可能
- Catalog → Pages → Page → Contentsをたどり、ページ本文以外のstreamを除外
- 既存フォントの`/ToUnicode` CMap（`bfchar`・`bfrange`）によるUnicode復号と再エンコード
- 元ファイルを壊さず、PDF incremental update として変更を追記
- `Uint8Array` による composite font 用のエンコード済み文字コード指定
- TypeScript 型定義を同梱

## 利用例

```js
import { PdfTextEditor } from "@idontlovepdf/local-text-editor";

const input = new Uint8Array(await file.arrayBuffer());
const editor = new PdfTextEditor(input);
const runs = await editor.listTextRuns();

console.table(runs.map(({ id, text }) => ({ id, text })));
await editor.replaceText(runs[0].id, "Replacement");

const output = await editor.save();
const url = URL.createObjectURL(new Blob([output], { type: "application/pdf" }));
downloadLink.href = url;
```

`/ToUnicode` CMapに対象文字の逆引きが存在する日本語PDFでは、通常のUnicode文字列を直接渡せます。

```js
await editor.replaceText(run.id, "日本語");
```

CMapがない、または逆引きできない特殊なfontでは、既存fontの文字コードにエンコードした`Uint8Array`も指定できます。

## API

### `new PdfTextEditor(input)`

`ArrayBuffer` または `Uint8Array` の PDF を読み込みます。classic xref table・cross-reference stream・両者が`/Prev`で混在する構成のいずれにも対応します。暗号化PDFは対象外です。xref解析自体はFlateDecodeの展開を含み非同期になり得るため、コンストラクタは同期のまま、実際の解析は最初の`listTextRuns()`（内部的には`replaceText()`・`save()`も経由）呼び出し時に遅延して行われます。

### `await editor.listTextRuns()`

`{ id, objectNumber, textObjectId, fontName, text, bytes }` の配列を返します。`textObjectId`は、そのrunが属する`BT ... ET`ブロックを、content stream内での出現順に0から採番したものです。同じ`objectNumber`でも別の`BT ... ET`（PDF上の別位置へ独立して移動して描画されることが多い）なら異なる`textObjectId`になります。利用中のfontに`/ToUnicode` CMapがあれば`text`をUnicodeへ復号します。CMapがなければ単一バイト表示にフォールバックするため、確実な調査には`bytes`も確認してください。

### `await editor.replaceText(id, replacement)`

対象runを文字列またはバイト列で置換予約します。CMapがあるfontではUnicode文字列を既存文字コードへ逆変換します。CMapがない場合、文字列は単一バイト文字に限定されます。どちらの場合も、実際に表示できる字形は既存fontに含まれるものだけです。

### `await editor.save()`

変更済み PDF を新しい `Uint8Array` で返します。入力データは変更しません。

## idontlovepdf への組込み

このパッケージを idontlovepdf の依存に追加し、ファイル読込み後の `ArrayBuffer` を `PdfTextEditor` に渡します。ネットワーク要求は発生しないため、パッケージをアプリと一緒に配布すれば閉域環境で動作します。`CompressionStream` / `DecompressionStream` を持たない古いブラウザを対象にする場合は、ビルド時に互換実装をバンドルしてください。

## 制約と次の段階

- ページ上の座標、フォント名、文字サイズはまだ公開していません。
- `/ASCII85Decode`、画像化された文字、暗号化PDFは未対応です。
- `/DecodeParms /Predictor`は、`src/predictor.js`が次の範囲に対応します。
  - **Predictor 1**（補正なし）: そのまま
  - **Predictor 10〜15**（PNG Predictor: None/Sub/Up/Average/Paeth）: PDF仕様どおり、値の大小に関わらずrowごとの先頭1バイトで実際のfilter typeを読み取って復元します（`/Predictor`の数値はどのfilterが多いかの目安に過ぎず、行ごとの判定は仕様上常に必要です）
  - **Predictor 2**（TIFF Predictor）: `/BitsPerComponent 8`のみ対応。それ以外のbit depth（1/2/4/16）は`Unsupported TIFF Predictor BitsPerComponent: N`という明確なエラーになります
  - `/Columns`・`/Colors`・`/BitsPerComponent`省略時はそれぞれ既定値1・1・8を使用。`/DecodeParms << ... >>`と単要素配列`/DecodeParms [ << ... >> ]`の両形式に対応（複数filter chain全般は対象外）
  - Predictor解除はxref stream・page content stream・ToUnicode CMap streamのいずれからも共通利用し（`src/predictor.js`と`src/flate.js`に集約）、失敗時のエラーには`content stream object 45: ...`のようにどのstreamで失敗したかを付記します
  - 保存時（`save()`）は、編集済みcontent streamを常にPredictorなしの素の`/FlateDecode`として書き戻します（`/DecodeParms`も削除）。元PDFがPredictor付きでも、incremental updateとして追記される新しいstreamにはPredictorを再付与しません
- cross-reference streamのtype 2 entry（object stream内のobject）は、xref解析自体は失敗させず内部的に保持しますが、そのobjectへ実際にアクセスした時点で「Object streams are not supported」という明確なエラーになります。object stream（`/ObjStm`）そのものの実装はまだ行っていません。Catalog / Pages / Contentsなど今回必要なobjectがtype 1（通常のindirect object）であれば処理を継続できます。
- inline image（`BI ... ID ... EI`）の画像データは本文走査から除外します。画像そのものは編集対象外です。
- 1ページの`/Contents`が複数streamに分かれている場合、各streamを独立に走査します。`BT`〜`ET`がstream境界をまたぐと、そのrunは列挙されません。
- 置換後の文字幅に応じた再レイアウトはしません。元と近い幅のテキスト置換が主用途です。
- CMapは`bfchar`と`bfrange`の基本形に対応しますが、複雑なCMap継承やfont内glyphの存在確認は未対応です。
- 製品相当には、operator の graphics/text state を追跡し、座標ベースの選択、フォント subset の再生成、行組みを追加する必要があります。

## 検証済み範囲

自動テストでは、最小PDFに加えて次を回帰検証しています。

- content stream内に`endobj stream endstream`が文字として現れてもxrefと`/Length`で正しく解析できること
- `BT ... ET`を含む非ページstreamを本文として列挙しないこと
- Type 0 fontの`/ToUnicode` CMapで日本語を復号し、別の日本語へ置換して再読込みできること
- inline imageの画像データを本文として読まず、その前後のrunを正しく列挙できること
- 複数ページが同じcontent streamを共有していても、runを重複させずincremental updateへ1回だけ追記すること
- `/Kids`が循環したPDFをstack overflowではなく明示的なエラーとして報告すること
- 新しいxrefセクションの`f`エントリが、古いセクションの`n`エントリを打ち消すこと
- `bfrange`の変換先配列が範囲より短い場合と、範囲が2バイトcodespaceを超える場合に、例外やハングを起こさないこと
- 同じcontent stream内に複数の`BT ... ET`ブロックがあっても、各runへ出現順の`textObjectId`（`BT`ごとに0から採番）が正しく振られ、ブロックをまたいでも同じ`textObjectId`のrunは同一ブロック内で連番になること
- cross-reference streamからtype 1 objectを取得し、Catalog → Pages → Page → Contentsをたどって本文runを取得できること（無圧縮・`/FlateDecode`圧縮の両方）
- `/Index`省略時に`[0 /Size]`として解析されること、および部分的・非連続なobject番号範囲を指定する`/Index`を正しく解析できること
- 新しいxref streamのtype 0（free）entryが、古いclassic xref sectionのobjectを無効化すること
- classic xrefとcross-reference streamが`/Prev`で混在していても、最新版のobjectを正しくたどれること（`save()`が生成するincremental updateは常にclassic xrefのため、xref stream由来のPDFを保存・再読込みするたびにこの経路を通ります）
- type 2 entry（object stream内のobject）が存在してもxref解析全体は失敗させず、そのobjectへ実際にアクセスした場合にのみ明確なエラーになること
- 不正な`/W`・奇数個の`/Index`・`/W`と`/Index`が示す長さに合わないstreamで、ハングや過大なメモリ確保をせず例外になること
- `/Index`の各subsectionが`/Size`を超える、順序が昇順でない、subsection同士が重複する、といった`/Index`と`/Size`の矛盾を例外にすること
- cross-reference stream由来のPDFで`listTextRuns()` → `replaceText()` → `save()` → 再読込みが通ること
- PNG Predictor（None・Sub・Up・Average・Paeth）が、独立に実装した参照エンコーダで作った既知fixtureと完全一致で復元できること。`Predictor`の数値（10〜15）に関わらず、rowごとの実際のfilter typeバイトを読み取ること
- TIFF Predictor 2が、`Colors`が2以上（同一color componentの前サンプルを正しく参照）でも復元できること。8bit以外の`BitsPerComponent`は明確なエラーになること
- `/Columns`・`/Colors`・`/BitsPerComponent`省略時の既定値（1・1・8）、および`/DecodeParms`の`<< >>`形式・単要素配列`[ << >> ]`形式の両方を正しく解釈できること
- rowサイズがstream長と合わない場合・未知のPNG filter typeの場合・`/Columns`等が0以下または安全な整数範囲外の場合に、ハングや過大なメモリ確保をせず例外になること
- Predictor付きのxref stream・content stream・ToUnicode CMap streamそれぞれから正しく本文runやCMapを取得できること
- Predictor付きcontent streamに対して`listTextRuns()` → `replaceText()` → `save()` → 再読込みが通ること。保存後のstreamはPredictorなしの`/FlateDecode`として書き戻され、`/DecodeParms`も除去されること

これらは構造上の回帰fixtureであり、Wordや各種業務製品から出力されたPDFの互換性を証明するものではありません。実PDFの判定では、出力元ごとに複数fixtureを用意し、Acrobat Reader等の独立したreaderによる表示確認も必要です。object streamで失敗するファイルが多い場合は自作方式を一般用途へ昇格させず、Apryse/Foxit PoCへ戻す判断材料としてください。

### 実PDF corpusの評価

個人情報を含まないPDFを出力元別のディレクトリに20〜30件集め、次のコマンドで一括評価できます。

```sh
npm run assess:corpus -- --json --output tmp/assessed fixtures/real-pdf > assessment.json
```

ファイルまたはディレクトリを複数指定でき、ディレクトリ内の`.pdf`は再帰的に探索します。結果にはファイルごとの`load`（読込）、`extract`（本文run抽出）、`writeback`（既存の符号化済み文字による同一bytesの再書込み）、`save`、`reopen`（保存結果の再読込）とrun数、失敗段階が記録されます。`writebackMode`は現在常に`same-bytes`です。font subsetにない文字を仮定せず、最初のrunを同じbytesで書き戻して保存経路だけを検査するため、`writeback: true`は異なるテキストへの置換成功を意味しません。「日本」から「沖縄」のような別文字への置換は対象文書ごとに別途確認してください。

`--output`を指定すると、保存・再読込に成功したファイルを`元ファイル名.入力パスの短いSHA-256.assessed.pdf`として確認用ディレクトリへ書き出し、結果の`outputFile`に記録します。異なる出力元に同名PDFがあっても衝突せず、入力パスが同じなら安定した名前になります。`readerDisplay`は常に`null`です。出力をAcrobat Reader等の独立したreaderで確認し、評価JSONへ結果を手動で追記してください。元PDFや生成物はライセンス・個人情報を確認したうえで管理し、実文書をこの公開パッケージへ同梱しない方針です。

## GitHub PagesブラウザPoC

`index.html`は、この自作モジュールが**実PDFでどこまで通用するかをブラウザ内で確認するための検証コンソール**です。GitHub Pagesで公開すれば、URLを開くだけで手元の実PDFを検証できます。製品版でも一般職員向けの完成UIでもなく、`idontlovepdf`本体への組込みも行っていません。

**PDFはブラウザ内だけで処理します。** GitHub Pagesは画面（HTML / CSS / JavaScript）の配信にのみ使い、選択したPDFはGitHub・外部API・その他サーバーへ送信しません。ブラウザPoCのコードには`fetch()`、`XMLHttpRequest`、`WebSocket`、外部CDN、外部フォント、外部APIを含みません。PDFは`<input type="file">`またはドラッグ＆ドロップから`File` → `ArrayBuffer` → `Uint8Array`として読み込み、編集結果の保存もブラウザのダウンロード機能によるローカル保存です。

bundle工程は追加していません。`index.html`はES Modulesとして`web/app.js`を読み込み、そこから`src/index.js`の`PdfTextEditor`を直接利用します。Node専用CLI（`scripts/assess-corpus.js`）とブラウザ用コード（`web/`）は分けています。

| ファイル | 役割 |
| --- | --- |
| `index.html` | 検証画面（説明・タブ・プレビュー・検索・置換UI・デバッグ情報） |
| `web/app.js` | DOM操作とファイル入出力のみ |
| `web/poc-core.js` | DOM非依存の表示整形とエラー分類。Nodeのテストからも読み込む |
| `web/text-search.js` | DOM非依存の文字列検索・置換モデル。Nodeのテストからも読み込む |
| `src/assessment.js` | 評価パイプライン本体。Node版CLIとブラウザPoCで共有する |
| `src/flate.js` | `/FlateDecode`の展開・`/Filter`解釈。content stream・CMap stream・cross-reference streamで共有する |
| `src/predictor.js` | `/DecodeParms /Predictor`（TIFF・PNG）の解除。stream種別に依存せず`src/flate.js`から共通利用する |

### 単一PDF検証: PDFプレビュー＋文字列検索・置換

主操作は「runを直接選択して編集」ではなく「文字列を検索し、一致した箇所を置換」です。PDF内部構造（run・objectNumber・bytesなど）は通常操作からは隠し、「詳細・デバッグ情報」を開いたときだけ確認できます。

1. 「単一PDF検証」タブでPDFを1件選ぶ（ドラッグ＆ドロップ可）
2. 選択した元PDFを、ブラウザ標準のPDF表示で`<iframe>`にプレビューする（Blob URL、送信なし）
3. `PdfTextEditor`初期化と`listTextRuns()`を実行し、検索欄を有効化する
4. 検索文字列を入力すると、一致箇所を一覧表示する（一致件数・前後の文脈・置換可否バッジ・構成run）
5. 一致を1件選ぶと置換後テキスト欄にその一致テキストが入り、置換後の文字列を編集できる
6. 「置換してPDFを保存」を押すと、`replaceText()` → `save()` → 保存結果の再読込確認（reopen）の順に検証し、成功した場合だけ`元ファイル名.edited.pdf`としてローカル保存する

**PDFプレビュー。** 選択したPDFは`Blob`から`URL.createObjectURL()`で作った`blob:` URLを`<iframe>`に読み込むだけで、外部PDF.jsなどは追加していません。新しいPDFを選ぶたびに古いBlob URLは`URL.revokeObjectURL()`で破棄します。プレビューは自作エンジンの解析結果とは独立して、ファイルの読み取りに成功していれば表示を試みます。プレビューが表示できないブラウザ・PDFでも検索・置換機能自体は利用でき、逆に自作エンジンが本文runを抽出できないPDF（暗号化PDF、object streamにしか実体がないPDFなど）でもプレビューは表示を試みます。**プレビュー表示の成否とPDF解析の成否は独立した別の事実です。**

**文字列検索。** PDF内部では、"令和8年度" が `令` / `和` / `8` / `年度` のように複数の`Tj`オペランドへ分かれて格納されていることがあります。検索は`listTextRuns()`の結果を**同じcontent stream（`objectNumber`）由来・同じ`BT ... ET`ブロック（`textObjectId`）由来・かつ出現順が連続しているrun**だけを連結した区間ごとに行うため、①複数runにまたがる文字列を1つの検索語として一致させつつ、②別のcontent streamの末尾と次のstreamの先頭を連結して誤一致することを防ぎ、③**同じcontent stream内でも別の`BT ... ET`（ページ上の別位置へ独立して移動して描画されることが多い）を跨いだ連結**も防ぎます。③は`objectNumber`だけでは区別できないため、`src/content-stream.js`が`BT`ごとに採番する`textObjectId`をrunへ持たせ、検索側もこれを区切りに使っています。一致ごとに、構成するrun ID・run数・前後の文脈を保持し、画面にも表示します。

**置換可否バッジ。** 一致が単一run内に収まる場合は常に「○ 単一run（構造上置換可能）」です（部分一致でもrun全体を「一致前 + 置換後 + 一致後」で書き換える1回の`replaceText()`呼び出しで済みます）。「構造上」と限定しているのは、ToUnicodeなし・CMap逆引き不可・置換文字のglyphなしといった理由で実際の`replaceText()`が失敗することがあり、このバッジは複数run分割ルールの対象外であることしか保証しないためです。複数runにまたがる一致は「△ Nrunに分割されています」と表示し、**置換後の文字列が元の一致と同じ文字数の場合に限り**、元の各runが一致へ提供していた文字数と同じ割合で置換文字列を分割し、runごとに`replaceText()`を呼びます。文字数が異なる場合は、content streamの再構成やレイアウト調整が必要になり本PoCの範囲を超えるため、「この一致箇所は現在のPoCでは置換不可です」（分類ラベル: 複数runにまたがるため現在の方式では置換不可）と表示し、置換を実行しません。CMap逆引きの可否など実際に`replaceText()`を試さないと分からないものは事前判定せず、実行時エラーとして表示します。

**保存前のreopen確認。** 置換後は`save()`の結果を新しい`PdfTextEditor`で読み込み直し、本文runが取得できることを確認してから初めてダウンロードします。再読込に失敗した場合はダウンロードせず「保存後PDFの再読込に失敗しました」と表示します。**自作エンジンで再読込できたことは、Acrobat Reader等で正常表示できることを意味しません。**保存した編集済PDFは独立したreaderで必ず確認してください。

`text`はfontの`/ToUnicode` CMapによる復号結果です。復号できないrunがあってもPoC全体は止めず、「詳細・デバッグ情報」のrun一覧でそのrunに「復号不可を含む」と表示します。置換は常に元バイト列の複製に対して行うため、**元のPDFファイルは変更されません**。失敗時は、失敗した段階・推定される原因・エラー原文・元PDFが無変更であることを表示します（エラーは握り潰しません）。

**詳細・デバッグ情報。** `<details>`内に、従来どおりの本文run一覧（`id` / `objectNumber` / `fontName` / `text` / 文字数 / bytes数 / bytes hex、既定で折りたたみ）と、run一覧から1件を直接選んで置換する検証用UIを残しています。通常操作には使いませんが、検索・置換モデルが内部でどのrunを操作しているかを確認する用途で利用できます。

`web/text-search.js`の自動テスト（`test/text-search.test.js`）では、単一run内の一致、複数runにまたがる一致、一致なし、別content stream境界を跨がないこと、**同じcontent stream内の別`BT ... ET`（`textObjectId`）を跨がないこと**、同じ文字列の複数一致、置換後の文字数一致・不一致による自動対応可否、実際のPDFに対する検索→置換→save→reopenの一連を回帰検証しています。

### 複数PDF corpus評価

1. 「複数PDF評価」タブでPDFを複数選ぶ
2. 各PDFについて`load` / `extract` / `writeback` / `save` / `reopen`を評価し、表に追記
3. 成功・失敗は色だけでなく「○ 成功」「× 失敗」「- 未実施」の文字でも示します
4. 「assessment.json を保存」でJSONをローカル保存
5. `save`・`reopen`に成功した行は「編集済PDFを保存」から個別に保存（自動ダウンロードはしません）

評価段階はNode版`npm run assess:corpus`と揃えてあります。`writebackMode`は`same-bytes`で、**最初のrunに元と同じbytesを書き戻す方式です。`writeback: true`は別文字への置換に成功したことを意味しません。**別文字への置換可否は単一PDF検証タブで文書ごとに確認してください。

`assessment.json`は各PDFについて次を含みます。

```json
{
  "file": "sample.pdf",
  "load": true,
  "extract": true,
  "writeback": true,
  "writebackMode": "same-bytes",
  "save": true,
  "reopen": true,
  "runCount": 12,
  "readerDisplay": null,
  "error": null
}
```

`readerDisplay`はブラウザPoCでも自動判定せず、常に`null`です。**保存できたことと、意図どおり表示されることは別です。**保存した編集済PDFをAcrobat Reader等の独立したPDF readerで開いて確認し、結果は人間がJSONへ追記してください。

失敗時は既存のエラーメッセージをそのまま表示したうえで、xref stream解析失敗（破損した`/W`・`/Index`・stream長など）、object stream未対応（xref streamのtype 2 entry）、Predictor未対応または不正（未対応の値・row長不正・TIFF Predictorの未対応bit depthなど）、暗号化PDF、unsupported filter、本文runなし、ToUnicodeなし、CMap逆引き失敗（glyph不足の可能性）、保存失敗、再読込失敗などの分類を併記します。

このPoCの成功は、**一般的なPDFすべてへの対応を保証しません。**失敗するPDFがあることを前提に、出力元ごとの傾向を確かめるための画面です。

### GitHub Pagesでの公開

リポジトリの **Settings** → **Pages** → **Source** で **Deploy from a branch** を選び、Branchに **`main`** と **`/ (root)`** を指定して保存します。数十秒後に`https://<ユーザー名>.github.io/idontlovepdf-test/`で開けます。Pagesの有効化はGitHub側の設定操作だけで、リポジトリ側に追加の設定ファイルは不要です（`.nojekyll`のみ、配信を素通しにするために置いています）。

手元で確認する場合は、ES Modulesの制約により`file://`で直接開けません。リポジトリ直下で静的HTTPサーバーを起動してください。

```sh
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

## 開発

```sh
npm test
npm run check
```

`npm run check`は`src/`、`scripts/`に加えてブラウザPoCの`web/`とテストも構文検査します。`web/poc-core.js`と`web/text-search.js`はどちらもDOMに依存しないため、ブラウザPoCの純粋関数（段階表示、エラー分類、run整形、assessment.json生成、一括評価、文字列検索・複数run置換計画）は`test/browser-poc.test.js`と`test/text-search.test.js`でNodeから直接検証しています。DOMテスト環境は追加していません。
