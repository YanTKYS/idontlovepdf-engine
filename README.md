# idontlovepdf Local Text Editor

既存 PDF の content stream にあるテキスト表示オペランドを、ブラウザ内だけで置換する試作モジュールです。Apryse WebViewer や Foxit PDF SDK for Web が提供する「既存本文編集」のうち、最小限の置換処理を、サーバー送信・外部 API・実行時依存パッケージなしで検証できます。

> **試作の範囲:** PDF の文字列は、見た目の文章ではなく、フォント固有の文字コードと描画命令です。本モジュールはレイアウトを再構成せず、既存の `Tj`、`TJ`、`'`、`"` の文字列オペランドを置換します。行の折返し、字間調整、フォント埋込みは行いません。本PoCの成功をもって「一般的なPDFをOSSだけで編集可能」とは判定しません。

## 特長

- ブラウザ標準 API のみを使い、処理は端末内で完結
- literal string と hexadecimal string、および `TJ` 配列に対応
- 無圧縮および `/FlateDecode` content stream に対応
- classic xrefとstreamの `/Length`からオブジェクト境界を解析（本文中の`endobj`等を境界と誤認しない）
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

`ArrayBuffer` または `Uint8Array` の PDF を読み込みます。暗号化 PDF と xref stream のみで構成された PDF は、この試作では対象外です。

### `await editor.listTextRuns()`

`{ id, objectNumber, fontName, text, bytes }` の配列を返します。利用中のfontに`/ToUnicode` CMapがあれば`text`をUnicodeへ復号します。CMapがなければ単一バイト表示にフォールバックするため、確実な調査には`bytes`も確認してください。

### `await editor.replaceText(id, replacement)`

対象runを文字列またはバイト列で置換予約します。CMapがあるfontではUnicode文字列を既存文字コードへ逆変換します。CMapがない場合、文字列は単一バイト文字に限定されます。どちらの場合も、実際に表示できる字形は既存fontに含まれるものだけです。

### `await editor.save()`

変更済み PDF を新しい `Uint8Array` で返します。入力データは変更しません。

## idontlovepdf への組込み

このパッケージを idontlovepdf の依存に追加し、ファイル読込み後の `ArrayBuffer` を `PdfTextEditor` に渡します。ネットワーク要求は発生しないため、パッケージをアプリと一緒に配布すれば閉域環境で動作します。`CompressionStream` / `DecompressionStream` を持たない古いブラウザを対象にする場合は、ビルド時に互換実装をバンドルしてください。

## 制約と次の段階

- ページ上の座標、フォント名、文字サイズはまだ公開していません。
- `/ASCII85Decode`、画像化された文字、暗号化PDF、xref stream、object streamは未対応です。`/FlateDecode`に`/DecodeParms`の`/Predictor`が付く場合も、誤った本文を出さないよう未対応として報告します。
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

これらは構造上の回帰fixtureであり、Wordや各種業務製品から出力されたPDFの互換性を証明するものではありません。実PDFの判定では、出力元ごとに複数fixtureを用意し、Acrobat Reader等の独立したreaderによる表示確認も必要です。xref stream/object streamで失敗するファイルが多い場合は自作方式を一般用途へ昇格させず、Apryse/Foxit PoCへ戻す判断材料としてください。

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
| `index.html` | 検証画面（説明・タブ・表・置換UI） |
| `web/app.js` | DOM操作とファイル入出力のみ |
| `web/poc-core.js` | DOM非依存の表示整形とエラー分類。Nodeのテストからも読み込む |
| `src/assessment.js` | 評価パイプライン本体。Node版CLIとブラウザPoCで共有する |

### 単一PDF編集テスト

1. 「単一PDF検証」タブでPDFを1件選ぶ（ドラッグ＆ドロップ可）
2. `PdfTextEditor`初期化と`listTextRuns()`を実行し、`id` / `objectNumber` / `fontName` / `text` / 文字数 / bytes数 / bytes（hex）を一覧表示
3. run一覧から1件選び、置換後テキストを入力
4. `replaceText()` → `save()` を実行し、`元ファイル名.edited.pdf`としてローカル保存

`text`はfontの`/ToUnicode` CMapによる復号結果です。復号できないrunがあってもPoC全体は止めず、そのrunに「復号不可を含む」と表示します。bytesは既定で先頭12バイトのみ表示し、「詳細」で全体を表示します。置換は常に元バイト列の複製に対して行うため、**元のPDFファイルは変更されません**。CMapに置換文字がない場合などは、失敗した段階・推定される原因・エラー原文・元PDFが無変更であることを表示します（エラーは握り潰しません）。

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

失敗時は既存のエラーメッセージをそのまま表示したうえで、xref stream未対応、object stream未対応の可能性、暗号化PDF、unsupported filter、本文runなし、ToUnicodeなし、CMap逆引き失敗（glyph不足の可能性）、保存失敗、再読込失敗などの分類を併記します。

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

`npm run check`は`src/`、`scripts/`に加えてブラウザPoCの`web/`とテストも構文検査します。`web/poc-core.js`はDOMに依存しないため、ブラウザPoCの純粋関数（段階表示、エラー分類、run整形、assessment.json生成、一括評価）は`test/browser-poc.test.js`でNodeから直接検証しています。DOMテスト環境は追加していません。
