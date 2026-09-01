# idontlovepdf-engine

既存 PDF の content stream にあるテキスト表示オペランドを、ブラウザ内だけで置換する PDF 処理エンジンです。Apryse WebViewer や Foxit PDF SDK for Web が提供する「既存本文編集」のうち、最小限の置換処理を、サーバー送信・外部 API・実行時依存パッケージなしで実現します。

> **スコープ:** PDF の文字列は、見た目の文章ではなく、フォント固有の文字コードと描画命令です。本エンジンはレイアウトを再構成せず、既存の `Tj`、`TJ`、`'`、`"` の文字列オペランドを置換します。行の折返し、字間調整、フォント埋込みは行いません。**任意の PDF を完全に編集できることを保証するものではありません。** 暗号化 PDF は認証・復号・検索まで対応しますが、**暗号化 PDF への変更の再保存（再暗号化）は未対応**です。

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
- 本文検索、非暗号化 PDF での既存文字置換
- 元ファイルを壊さず、PDF incremental update として変更を追記。保存後の再読込みに対応

対応範囲外・既知の制約（詳細は各モジュールのコメントを参照）:

- `/ASCII85Decode`、画像化された文字（OCR 相当）は未対応
- 暗号化 PDF は `Standard` ハンドラの上記 2 組（R4/AESV2, R6/AESV3）のみ対応。`/R 2`・`/R 3`・`/R 5`・`/Adobe.PubSec` 等は診断のみで停止
- **暗号化 PDF への変更の保存（再暗号化）は未対応**。変更がなければ元 bytes をそのまま返せます
- ページ座標・フォントサイズは公開していません。置換後の文字幅に応じた再レイアウトはしません

## 正式公開API と 内部実装

外部リポジトリ（`idontlovepdf` を含む）から利用してよいのは `src/index.js`（および bundle 後の `dist/idontlovepdf-engine.js`）が export する、以下の**正式公開 API のみ**です。

```ts
import { PdfTextEditor, ENGINE_VERSION } from "@idontlovepdf/engine"; // またはbundle経由
```

- `new PdfTextEditor(bytes)`
- `await editor.listTextRuns(password?)`
- `await editor.replaceText(id, replacement)`
- `await editor.save()`
- `ENGINE_VERSION`（文字列。エンジンのバージョン、後述）

`PdfStructure`、xref parser、`Predictor`、CMap internals、Object Stream parser、暗号化 internals、AES primitives など、`src/` 配下の他のモジュールは**内部実装**であり、いつでも変更され得ます。外部リポジトリはこれらを直接 import しないでください。（`test/` 配下がテスト目的でこれらを直接 import しているのは、内部実装の回帰テストのためであり、公開契約ではありません。）

## API利用例

```js
import { PdfTextEditor, ENGINE_VERSION } from "./idontlovepdf-engine.js";

const bytes = new Uint8Array(await file.arrayBuffer());
const editor = new PdfTextEditor(bytes);
const runs = await editor.listTextRuns();

console.log(ENGINE_VERSION);
console.log(runs.length);

await editor.replaceText(runs[0].id, "Replacement");
const output = await editor.save();
const url = URL.createObjectURL(new Blob([output], { type: "application/pdf" }));
downloadLink.href = url;
```

`/ToUnicode` CMap に対象文字の逆引きが存在する日本語 PDF では、通常の Unicode 文字列を直接渡せます（`await editor.replaceText(run.id, "日本語")`）。CMap がない、または逆引きできない特殊な font では、既存 font の文字コードにエンコードした `Uint8Array` も指定できます。

暗号化 PDF では、`listTextRuns()` はまず空パスワードで自動認証を試み、失敗すると `passwordRequired: true` を持つ `Error` を投げます。`await editor.listTextRuns(password)` のように password を指定して再試行できます。

### `new PdfTextEditor(input)`

`ArrayBuffer` または `Uint8Array` の PDF を読み込みます。classic xref table・cross-reference stream・両者が `/Prev` で混在する構成のいずれにも対応します。実際の解析（および暗号化 PDF の認証・復号）はコンストラクタでは行わず、最初の `listTextRuns()`（内部的には `replaceText()`・`save()` も経由）呼び出し時に遅延して行われます。

### `await editor.listTextRuns(password?)`

`{ id, objectNumber, textObjectId, fontName, text, bytes }` の配列を返します。`textObjectId` は、その run が属する `BT ... ET` ブロックを content stream 内での出現順に 0 から採番したものです。利用中の font に `/ToUnicode` CMap があれば `text` を Unicode へ復号します。CMap がなければ単一バイト表示にフォールバックするため、確実な調査には `bytes` も確認してください。

### `await editor.replaceText(id, replacement)`

対象 run を文字列またはバイト列で置換予約します。CMap がある font では Unicode 文字列を既存文字コードへ逆変換します。暗号化 PDF で `/P` の文書変更 permission が許可されていない場合、認証に成功していてもここで明確なエラーを投げて拒否します。

### `await editor.save()`

変更済み PDF を新しい `Uint8Array` で返します。入力データは変更しません。保留中の変更が 1 件もなければ、暗号化 PDF でもそのまま元の bytes を返します。暗号化 PDF に対して実際に変更を保存しようとした場合はエラーになります（再暗号化保存は未対応）。

## Browserでの利用（bundle）

`dist/idontlovepdf-engine.js` は、`src/index.js` を [esbuild](https://esbuild.github.io/) で bundle した、**1 ファイル・ES Module・runtime 外部依存なしの browser 向け成果物**です。static hosting から直接 `import` できます。

```html
<script type="module">
  import { PdfTextEditor, ENGINE_VERSION } from "./idontlovepdf-engine.js";
  // ...
</script>
```

- entry point: `src/index.js`
- format: ESM（`bundle: true`, `platform: "browser"`）
- target: `es2022`
- 実行時に必要なのは browser 標準 API（`Uint8Array`、`TextEncoder`/`TextDecoder`、`CompressionStream`/`DecompressionStream`、`crypto.subtle` = Web Crypto API）のみで、これらの独自 polyfill は含みません。対応していない古いブラウザでは、呼び出し側で必要な polyfill を用意してください
- CDN 参照・外部 API・license server などへの runtime 通信は一切行いません。選択した PDF は従来どおり browser 内だけで処理します

### `npm run build`

```sh
npm ci
npm run build
```

`scripts/build.js` が esbuild を実行し、`dist/idontlovepdf-engine.js` を生成します。`esbuild` は devDependency としてのみ使用し、生成物には含まれません（production/runtime 依存ではありません）。`npm test` は `pretest` npm script 経由でビルドを自動実行するため、`npm test` を一度実行すれば `dist/` は常に最新の状態になります。

### version 確認方法

bundle が取り込んだ engine のバージョンは `ENGINE_VERSION`（文字列）から確認できます。

```js
import { ENGINE_VERSION } from "./idontlovepdf-engine.js";
console.log(ENGINE_VERSION); // 例: "0.2.0"
```

`ENGINE_VERSION` は `package.json` の `"version"` を source of truth とし、`scripts/sync-version.js` が `src/version.js` へビルド時に同期して生成します（`package.json`・`src/index.js`・build script のいずれにも version 文字列を手作業で重複記載していません）。この engine はまだ一般向け stable API を保証する段階ではないため、`0.x` のまま運用しています。

### distの管理方針

`dist/idontlovepdf-engine.js` は Git 管理せず（`.gitignore` 対象）、GitHub Release のassetとして配布します。bundleは`src/`から機械的に再生成できるため、生成物の差分をリポジトリ履歴へ積み上げません。`idontlovepdf-engine.js.sha256`も同じReleaseに添付します。CI（`.github/workflows/ci.yml`）はpush・PRごとに`npm run build`が成功することと`dist/idontlovepdf-engine.js`が生成されることを確認します。

ReleaseはGitHubの **Actions → Release → Run workflow** から実行し、`tag`（例: `v0.2.0`）を入力します。workflowは正式な`main`をcheckoutし、`package.json`とのversion整合性確認、release note抽出、test/buildの完了後にtagとGitHub Releaseを作成します。そのため、tagを事前に作成またはpushする必要はありません。

GitHub Releaseのtitleと本文のsource of truthは[`docs/release-notes.md`](docs/release-notes.md)です。Release前に対象versionのH2 sectionを同ファイルの先頭側へ追加してください。workflowは対象H2の内容をtitle、その配下から次のH2直前までをbodyとして使用します。

## 対応browser API

`src/` 配下（および bundle）が前提とする browser 標準 API は以下です。いずれも Node.js 専用 API（`node:crypto`、`node:zlib`、`node:test`、`Buffer` 等）で置き換えていません。

- `Uint8Array`
- `TextEncoder` / `TextDecoder`
- `CompressionStream` / `DecompressionStream`（`/FlateDecode` の展開・生成）
- Web Crypto API（`crypto.subtle`。AES-CBC 復号、R6 の hash 計算等）

`node:crypto`・`node:zlib`・`Buffer` 等は `test/` 配下（fixture 構築用）と `scripts/assess-corpus.js`（Node CLI）でのみ使用し、`src/` および `dist/idontlovepdf-engine.js` には含まれません。

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
| `src/content-stream.js` | content stream 内のテキスト表示オペランド・dictionary operand の走査 | 内部 |
| `src/encryption.js` | `/Encrypt` 辞書の診断（復号は行わない） | 内部 |
| `src/pdf-dictionary-text.js` | 辞書 text 内の名前・文字列・真偽値・入れ子辞書の抽出 | 内部 |
| `src/security/*` | 暗号化 PDF の認証・鍵導出・AES/MD5/RC4 primitives | 内部 |
| `src/assessment.js` | 評価パイプライン本体。Node 版 CLI とブラウザ PoC で共有 | 内部（PoC専用） |
| `scripts/build.js` / `scripts/sync-version.js` | bundle 生成・version 同期スクリプト | ビルド専用 |
| `scripts/assess-corpus.js` | 実 PDF corpus 一括評価用 Node CLI | 開発者向けツール |
| `web/*` | GitHub Pages ブラウザ PoC の実装 | PoC専用 |

## GitHub PagesブラウザPoC

`index.html`は、この engine が**実PDFでどこまで通用するかをブラウザ内で確認するための検証コンソール**です。GitHub Pagesで公開すれば、URLを開くだけで手元の実PDFを検証できます。製品版でも一般職員向けの完成UIでもなく、`idontlovepdf`本体への組込みも行っていません。今回の bundle 化によってこの PoC の役割・実装を大きく書き換えてはいません（`web/app.js` は引き続き `src/index.js` から直接 import します）。

**PDFはブラウザ内だけで処理します。** GitHub Pagesは画面（HTML / CSS / JavaScript）の配信にのみ使い、選択したPDFはGitHub・外部API・その他サーバーへ送信しません。ブラウザPoCのコードには`fetch()`、`XMLHttpRequest`、`WebSocket`、外部CDN、外部フォント、外部APIを含みません。PDFは`<input type="file">`またはドラッグ＆ドロップから`File` → `ArrayBuffer` → `Uint8Array`として読み込み、編集結果の保存もブラウザのダウンロード機能によるローカル保存です。

### 単一PDF検証: PDFプレビュー＋文字列検索・置換

主操作は「runを直接選択して編集」ではなく「文字列を検索し、一致した箇所を置換」です。

1. 「単一PDF検証」タブでPDFを1件選ぶ（ドラッグ＆ドロップ可）
2. 選択した元PDFを、ブラウザ標準のPDF表示で`<iframe>`にプレビューする（Blob URL、送信なし）
3. `PdfTextEditor`初期化と`listTextRuns()`を実行し、検索欄を有効化する
4. 検索文字列を入力すると、一致箇所を一覧表示する（一致件数・前後の文脈・置換可否バッジ・構成run）
5. 一致を1件選ぶと置換後テキスト欄にその一致テキストが入り、置換後の文字列を編集できる
6. 「置換してPDFを保存」を押すと、`replaceText()` → `save()` → 保存結果の再読込確認（reopen）の順に検証し、成功した場合だけ`元ファイル名.edited.pdf`としてローカル保存する

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
npm test              # node --test（test/*.test.js のみ）。pretestでdist/を自動ビルドし、dist経由のfixture testも実行
npm run check         # src/・scripts/・web/・test/ の構文検査
npm run build         # dist/idontlovepdf-engine.js を生成
```

**`npm ci && npm test`だけで、追加インストールなしに上記が再現できます。** `npm test`が対象にする`test/*.test.js`（サブディレクトリを含みません）は Node 標準APIのみで完結し、`test/dist-bundle.test.js`（後述）を含め Playwright は必要ありません。

```sh
npx playwright install chromium   # 初回のみ（ローカルにChromiumがない場合）
npm run test:browser              # node --test（test/browser/*.test.js）。pretest:browserでdist/を自動ビルド
```

`test/browser/smoke.test.js`は実際のheadless Chromium（Playwright）で`dist/idontlovepdf-engine.js`をbrowserへ`import`し、`PdfTextEditor`・`ENGINE_VERSION`のexportと、最小PDFの`listTextRuns()`成功までを確認します。Playwrightのbrowser本体は`npm ci`だけでは用意されないため、`npm test`（Node専用）とは別の`npm run test:browser`に分離しています。CIでは`npm test` → `npx playwright install --with-deps chromium` → `npm run test:browser`の順で両方とも実行します（`.github/workflows/ci.yml`）。

`test/dist-bundle.test.js`は通常PDF・xref stream・Object Stream・ToUnicode日本語という代表的な組み合わせを、`src/index.js`ではなく`dist/idontlovepdf-engine.js`からimportした`PdfTextEditor`で処理し、bundle化によって主要機能が壊れていないことを確認します（Node専用APIのみで完結するため`npm test`に含まれます）。

`web/poc-core.js`と`web/text-search.js`はどちらもDOMに依存しないため、ブラウザPoCの純粋関数は`test/browser-poc.test.js`と`test/text-search.test.js`でNodeから直接検証しています。DOMテスト環境は追加していません。
