# idontlovepdf Local Text Editor

既存 PDF の content stream にあるテキスト表示オペランドを、ブラウザ内だけで置換する試作モジュールです。Apryse WebViewer や Foxit PDF SDK for Web が提供する「既存本文編集」のうち、最小限の置換処理を、サーバー送信・外部 API・実行時依存パッケージなしで検証できます。

> **試作の範囲:** PDF の文字列は、見た目の文章ではなく、フォント固有の文字コードと描画命令です。本モジュールはレイアウトを再構成せず、既存の `Tj`、`TJ`、`'`、`"` の文字列オペランドを置換します。行の折返し、字間調整、フォント埋込みは行いません。

## 特長

- ブラウザ標準 API のみを使い、処理は端末内で完結
- literal string と hexadecimal string、および `TJ` 配列に対応
- 無圧縮および `/FlateDecode` content stream に対応
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

日本語など composite font の PDF では、既存フォントの CMap に従ってエンコードしたバイト列を渡します。

```js
await editor.replaceText(run.id, new Uint8Array([0x00, 0x2a, 0x00, 0x31]));
```

## API

### `new PdfTextEditor(input)`

`ArrayBuffer` または `Uint8Array` の PDF を読み込みます。暗号化 PDF と xref stream のみで構成された PDF は、この試作では対象外です。

### `await editor.listTextRuns()`

`{ id, objectNumber, text, bytes }` の配列を返します。`text` は探索用の単一バイト表示であり、Unicode への完全な復号結果ではありません。確実な処理には `bytes` を使用してください。

### `await editor.replaceText(id, replacement)`

対象 run を文字列またはバイト列で置換予約します。文字列は単一バイト文字に限定されます。実際に表示できる字形は既存フォントに含まれるものだけです。

### `await editor.save()`

変更済み PDF を新しい `Uint8Array` で返します。入力データは変更しません。

## idontlovepdf への組込み

このパッケージを idontlovepdf の依存に追加し、ファイル読込み後の `ArrayBuffer` を `PdfTextEditor` に渡します。ネットワーク要求は発生しないため、パッケージをアプリと一緒に配布すれば閉域環境で動作します。`CompressionStream` / `DecompressionStream` を持たない古いブラウザを対象にする場合は、ビルド時に互換実装をバンドルしてください。

## 制約と次の段階

- ページ上の座標、フォント名、文字サイズはまだ公開していません。
- `/ASCII85Decode`、画像化された文字、暗号化 PDF、xref stream、object stream、indirect `/Length` は未対応です。
- 置換後の文字幅に応じた再レイアウトはしません。元と近い幅のテキスト置換が主用途です。
- Unicode 編集 UI には ToUnicode CMap の読取り、逆引き、利用可能 glyph の検証が必要です。
- 製品相当には、operator の graphics/text state を追跡し、座標ベースの選択、フォント subset の再生成、行組みを追加する必要があります。

## 開発

```sh
npm test
npm run check
```
