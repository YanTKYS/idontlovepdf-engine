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
- `/ASCII85Decode`、画像化された文字、暗号化PDF、xref stream、object streamは未対応です。
- 置換後の文字幅に応じた再レイアウトはしません。元と近い幅のテキスト置換が主用途です。
- CMapは`bfchar`と`bfrange`の基本形に対応しますが、複雑なCMap継承やfont内glyphの存在確認は未対応です。
- 製品相当には、operator の graphics/text state を追跡し、座標ベースの選択、フォント subset の再生成、行組みを追加する必要があります。

## 検証済み範囲

自動テストでは、最小PDFに加えて次を回帰検証しています。

- content stream内に`endobj stream endstream`が文字として現れてもxrefと`/Length`で正しく解析できること
- `BT ... ET`を含む非ページstreamを本文として列挙しないこと
- Type 0 fontの`/ToUnicode` CMapで日本語を復号し、別の日本語へ置換して再読込みできること

これらは構造上の回帰fixtureであり、Wordや各種業務製品から出力されたPDFの互換性を証明するものではありません。実PDFの判定では、出力元ごとに複数fixtureを用意し、Acrobat Reader等の独立したreaderによる表示確認も必要です。xref stream/object streamで失敗するファイルが多い場合は自作方式を一般用途へ昇格させず、Apryse/Foxit PoCへ戻す判断材料としてください。

### 実PDF corpusの評価

個人情報を含まないPDFを出力元別のディレクトリに20〜30件集め、次のコマンドで一括評価できます。

```sh
npm run assess:corpus -- --json --output tmp/assessed fixtures/real-pdf > assessment.json
```

ファイルまたはディレクトリを複数指定でき、ディレクトリ内の`.pdf`は再帰的に探索します。結果にはファイルごとの`load`（読込）、`extract`（本文run抽出）、`replace`（既存の符号化済み文字による安全な置換）、`save`、`reopen`（保存結果の再読込）とrun数、失敗段階が記録されます。置換はfont subsetにない文字を仮定せず、最初のrunを同じbytesで書き戻して保存経路を検査します。したがって「別の日本語へ置換できること」は対象文書ごとに別途確認してください。

`--output`を指定すると、保存・再読込に成功したファイルを`*.assessed.pdf`として確認用ディレクトリへ書き出し、結果の`outputFile`に記録します。同名PDFは上書きされるため、corpus内では一意のファイル名を使用してください。`readerDisplay`は常に`null`です。出力をAcrobat Reader等の独立したreaderで確認し、評価JSONへ結果を手動で追記してください。元PDFや生成物はライセンス・個人情報を確認したうえで管理し、実文書をこの公開パッケージへ同梱しない方針です。

## 開発

```sh
npm test
npm run check
```
