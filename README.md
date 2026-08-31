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
- Standard Security Handler R4 / AESV2で暗号化されたPDFのuser/owner password認証・復号に対応（`/P`の文書変更permissionは尊重し、編集はまだ保存できない）
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

`ArrayBuffer` または `Uint8Array` の PDF を読み込みます。classic xref table・cross-reference stream・両者が`/Prev`で混在する構成のいずれにも対応します。トレーラーが`/Encrypt`を持つ暗号化PDFでも、xref解析自体（object位置・`/Root`・`/Size`の取得）はここでは失敗しません。暗号化の有無はcontent（文字列やstream本体）を読まなくても分かる情報のためです。xref解析自体はFlateDecodeの展開を含み非同期になり得るため、コンストラクタは同期のまま、実際の解析（および暗号化PDFの認証・復号）は最初の`listTextRuns()`（内部的には`replaceText()`・`save()`も経由）呼び出し時に遅延して行われます。

### `await editor.listTextRuns(password?)`

`{ id, objectNumber, textObjectId, fontName, text, bytes }` の配列を返します。`textObjectId`は、そのrunが属する`BT ... ET`ブロックを、content stream内での出現順に0から採番したものです。同じ`objectNumber`でも別の`BT ... ET`（PDF上の別位置へ独立して移動して描画されることが多い）なら異なる`textObjectId`になります。利用中のfontに`/ToUnicode` CMapがあれば`text`をUnicodeへ復号します。CMapがなければ単一バイト表示にフォールバックするため、確実な調査には`bytes`も確認してください。

暗号化PDF（`/Encrypt`）の場合、初回呼び出しは`password`省略時に空文字列のuser passwordで認証を試みます。認証に成功すればそのまま本文を復号して返し、失敗すれば`passwordRequired: true`と`encryptionDiagnosis`を持つ`Error`を投げます（対応するSecurity Handler自体が対象外の場合は`passwordRequired`なしでこの`Error`を投げ、パスワードでは解決しません）。`password`を指定して再度呼び出すと、そのパスワードで再認証します。認証に使ったユーザー/オーナー種別・`/P`権限などは`editor.security`（内部利用: `{ authenticated, authType, modifyAllowed, permissions, diagnosis, ... }`）に保持されます。対応範囲・認証・復号の詳細は後述「暗号化PDFの認証・復号（Standard Security Handler R4 / AESV2）」を参照してください。

### `await editor.replaceText(id, replacement)`

対象runを文字列またはバイト列で置換予約します。CMapがあるfontではUnicode文字列を既存文字コードへ逆変換します。CMapがない場合、文字列は単一バイト文字に限定されます。どちらの場合も、実際に表示できる字形は既存fontに含まれるものだけです。暗号化PDFで`/P`の文書変更permissionが許可されていない場合、認証に成功していてもここで明確なエラーを投げて拒否します（読み取り・検索ができることと、変更が許可されていることは別の判定です）。

### `await editor.save()`

変更済み PDF を新しい `Uint8Array` で返します。入力データは変更しません。保留中の変更が1件もなければ、暗号化PDFでもそのまま元のbytesを返します。暗号化PDFに対して実際に変更を保存しようとした場合はエラーになります（再暗号化保存は未対応。後述）。

## idontlovepdf への組込み

このパッケージを idontlovepdf の依存に追加し、ファイル読込み後の `ArrayBuffer` を `PdfTextEditor` に渡します。ネットワーク要求は発生しないため、パッケージをアプリと一緒に配布すれば閉域環境で動作します。`CompressionStream` / `DecompressionStream` を持たない古いブラウザを対象にする場合は、ビルド時に互換実装をバンドルしてください。

## 制約と次の段階

- ページ上の座標、フォント名、文字サイズはまだ公開していません。
- `/ASCII85Decode`、画像化された文字は未対応です。
- 暗号化PDFは、`/Filter /Standard /V 4 /R 4`かつCrypt Filterが`/AESV2`（または`/Identity`）の組み合わせに限り、認証・復号・本文抽出・検索まで対応しています。それ以外（`/R 2`・`/R 3`・`/R 5`・`/R 6`・`/AESV3`・AES-256・`/Adobe.PubSec`などの非Standard方式）は診断のみで、明確な理由付きのエラーで停止します。文書変更を許可しない`/P`のPDFでは、認証に成功しても置換・保存を拒否します。暗号化PDFへの変更の保存（再暗号化）はまだ未対応です。詳細は後述「暗号化PDFの認証・復号（Standard Security Handler R4 / AESV2）」を参照してください。
- `/DecodeParms /Predictor`は、`src/predictor.js`が次の範囲に対応します。
  - **Predictor 1**（補正なし）: そのまま
  - **Predictor 10〜15**（PNG Predictor: None/Sub/Up/Average/Paeth）: PDF仕様どおり、値の大小に関わらずrowごとの先頭1バイトで実際のfilter typeを読み取って復元します（`/Predictor`の数値はどのfilterが多いかの目安に過ぎず、行ごとの判定は仕様上常に必要です）
  - **Predictor 2**（TIFF Predictor）: `/BitsPerComponent 8`のみ対応。それ以外のbit depth（1/2/4/16）は`Unsupported TIFF Predictor BitsPerComponent: N`という明確なエラーになります
  - `/Columns`・`/Colors`・`/BitsPerComponent`省略時はそれぞれ既定値1・1・8を使用。`/DecodeParms << ... >>`と単要素配列`/DecodeParms [ << ... >> ]`の両形式に対応（複数filter chain全般は対象外）
  - `/Predictor`・`/Columns`・`/BitsPerComponent`等の値は、キーに続くトークン全体をPDF整数として厳密に検証します。`/Predictor 12.5`のような小数や`/Columns foo`のような非数値は、先頭の数字部分だけを読んで推測することなく、そのまま不正値として拒否します。`/BitsPerComponent`はPDF仕様が定める`1`・`2`・`4`・`8`・`16`以外（例: `3`や`5`）も明示的に拒否します
  - Predictor解除はxref stream・page content stream・ToUnicode CMap streamのいずれからも共通利用し（`src/predictor.js`と`src/flate.js`に集約）、失敗時のエラーには`content stream object 45: ...`のようにどのstreamで失敗したかを付記します
  - 保存時（`save()`）は、編集済みcontent streamを常にPredictorなしの素の`/FlateDecode`として書き戻します（`/DecodeParms`も削除）。元PDFがPredictor付きでも、incremental updateとして追記される新しいstreamにはPredictorを再付与しません
- **暗号化PDFの診断は`src/encryption.js`が担い、認証・復号は`src/security/`配下が担います。**両者は責任を分離しています: `src/encryption.js`はEncrypt辞書を読み取って`{ filter, version, revision, lengthBits, cryptFilters, permissions, estimatedMethod, ... }`を返すだけで、鍵やパスワードには一切触れません。`src/security/decrypt.js`がこの診断を使って対応範囲かどうかを判定し、対応範囲内だけ実際の認証・復号を行います。
  - トレーラー（またはxref streamの辞書）が持つ`/Encrypt N 0 R`を検出しても、xref解析自体は失敗させず先まで進めます（object位置・`/Root`・`/Size`は暗号化の影響を受けないため）。`Standard`以外のSecurity Handler（`/Adobe.PubSec`など）の場合、`/Filter`・`/SubFilter`のみ報告し、それ以上（`/P`・`/CF`など）はStandard固有の解釈を当てはめず`null`のまま診断のみで止めます。
  - **認証・復号の対応範囲は`/Filter /Standard /V 4 /R 4`、かつ`/StmF`・`/StrF`が`/AESV2`または`/Identity`のみです。** それ以外（`/R 2`・`/R 3`・`/R 5`・`/R 6`・`/V`が4以外・`/AESV3`・非AESV2のCrypt Filterなど）は、`Unsupported encrypted PDF revision: R6`・`Unsupported crypt filter method: AESV3`のように理由を明示して停止します（パスワードでは解決しません）。
  - **user password認証**（PDF仕様 7.6.3, Algorithm 2/5/6相当）: `listTextRuns()`は初回、`password`省略時に**空文字列**のuser passwordでまず認証を試みます。実PDFがReaderでパスワード入力なしに開けても、それを「空パスワード」と推測することはせず、Standard Security Handlerの認証計算（`/O`・`/U`・`/P`・トレーラーの`/ID`先頭要素・`/EncryptMetadata`からfile encryption keyを導出し、`/U`と突き合わせる）で判定します。失敗すると`passwordRequired: true`を持つ`Error`を投げ、`listTextRuns(password)`で別のパスワードを渡して再試行できます。
  - **owner password認証**も同じ呼び出しで（user password認証が失敗した場合に）試みます。認証結果は`user`・`owner`・`失敗`を区別して`editor.security.authType`に残しますが、**owner passwordが分かったからといって`/P`の権限制限を無視することはしません**（owner認証はuser passwordと同じfile encryption keyを復元するだけで、権限突破の手段としては使っていません）。
  - **ファイル暗号鍵の導出**は仕様どおり実装しています: パスワードのpadding（固定32byteパディング列）、MD5、RC4、revision 3以上での50回の追加MD5、`/O`・`/P`・file ID・`/EncryptMetadata`の扱いを含みます。**AESV2だからといって鍵導出自体をAESで行うわけではありません** — R4 Standard Security Handlerの認証・鍵導出は仕様上MD5/RC4のみで行い、AESはobject単位のstream/string復号にのみ使います。この2つを混同しないよう、`src/security/standard-r4.js`（認証・鍵導出、PDF知識のみ）と`src/security/aes.js`（AES-CBC復号のみ）を分けています。
  - **パスワードは`src/security/pdfdoc-encoding.js`でPDFDocEncoding（PDF仕様 Annex D.2）へ変換してからpaddingします。** revision 4以前のpasswordはUTF-8ではなくPDFDocEncoding、というのが仕様です（revision 5以降はUTF-8ですが本実装のスコープ外）。ASCII印字可能文字（例: `abc`）はどちらの符号化でも同じ1byteのため差が出ませんが、`é`のような非ASCII文字はUTF-8だと2byte（`C3 A9`）、PDFDocEncodingだと1byte（`E9`、Latin-1と同じ値）になり、UTF-8のまま扱うと正しいpasswordでも認証に失敗します。PDFDocEncodingで表現できない文字（`U+0080`未満の一部制御文字、`U+00A0`・`U+00AD`など）は無理に別の文字へ変換・切り捨てず、明確なエラーにします（`src/security/decrypt.js`はこれを「そのpasswordは不正解」と同じ扱いにして再入力を促し、原因不明のエラーにはしません）。
  - **objectごとの鍵導出**（Algorithm 1 + AES用の`"sAlT"`）: file encryption key + objectNumber下位3byte + generationNumber下位2byte（+ AESV2の場合は固定4byte `"sAlT"`）をMD5にかけ、先頭バイトを切り出します（`src/security/standard-r4.js`の`deriveObjectKey()`）。object番号やgenerationが異なれば異なる鍵になります。
  - **`/O`・`/U`・`/ID`はbyte-exactに解析します。** `TextDecoder("latin1")`はWHATWG Encoding Standard上windows-1252の別名であり、byte `0x80`〜`0x9F`を素通しせず別のUnicode文字へ変換してしまうため、辞書textを一度この方法で文字列化してから`charCodeAt() & 0xff`でbyteへ戻すと、この範囲のbyteが破損します。`src/pdf-structure.js`は`decodeBinaryString()`（`String.fromCharCode`によるbyte単位の変換で、0〜255を1:1で保持）でdictionary/trailer textを作り、`src/pdf-dictionary-text.js`の`stringValue()`・`firstIdBytes()`がそこから`/O`・`/U`・`/ID`のliteral string（`\`によるnamed escape・最大3桁のoctal escape・行継続を含む）・hex stringを、`src/content-stream.js`の`readLiteral()`・`readHex()`（content stream内のTj文字列と同じ実装）を再利用して取り出します。
  - **MD5・RC4は外部npm依存を追加せず、`src/security/md5.js`・`src/security/rc4.js`として最小限を自前実装しています**（Web CryptoにはMD5・RC4がありません）。汎用暗号ライブラリ化はせず、この認証アルゴリズムに必要な範囲に限定しています。AES-CBC復号は`crypto.subtle`（Web Crypto API）を使い、ブラウザ・Node両方で同じコードが動きます。PDFのAES暗号化stream/stringは先頭16byteがIVで、残りがAES-CBC暗号文です。IV分離・PKCS#7 padding除去（`crypto.subtle`が自動的に検証・除去し、不正な場合は明確なエラーになります）は`src/security/aes.js`が担います。
  - **復号の順序**は、暗号化された生bytes → Crypt Filterで復号 → `/FlateDecode`展開 → Predictor解除 → content/CMap解析、です（`src/pdf-document.js`の`decodeStream()`に集約）。xref stream自体はPDF仕様上暗号化の対象外のため、この経路を通しません（既存のxref stream解析はそのまま）。`/StmF`・`/StrF`にそれぞれ対応するCrypt Filterを適用し、`/Identity`が指定されたstream/stringは復号しません。
  - **`/P`の権限判定は認証と独立に行います。** `/P`は符号付き32bit整数として解釈し、印刷・文書変更・内容コピー・注釈の4項目に加え、`/R >= 3`の場合のみフォーム入力・アクセシビリティ抽出・文書構成変更・高品質印刷の4項目を判定します（`/R 2`ではこの4項目を`null`のまま返し、bitを読んで推測しません）。認証に成功していても、文書変更（modify）permissionがない場合`replaceText()`は明確なエラーで拒否します。検索（`listTextRuns()`）は権限に関わらず利用できます。
  - **保存（`save()`）は、暗号化PDFに対する実際の変更がある場合は拒否します。** 再暗号化・`/O`/`/U`の再計算・トレーラーの更新を伴う実装は、認証・復号を成立させる今回のスコープには含めていません。保留中の変更が0件なら（元のPDFをそのまま返すだけなので）暗号化PDFでも成功します。
  - パスワードは`analyzeEncryption()`が返す診断・`assessment.json`・エラーメッセージのいずれにも一切含めません。ローカルストレージ（`localStorage`・`sessionStorage`）への保存、URLへの混入、外部送信も行いません（ブラウザPoCのパスワード入力欄も参照）。
  - 実装しないもの（意図的なスコープ外）: `/R 2`・`/R 3`・`/R 5`・`/R 6`、`/AESV3`（AES-256）、`/Adobe.PubSec`などの非Standardハンドラ、パスワード総当たり・辞書攻撃、owner passwordによる権限制限の回避、暗号化PDFへの変更の保存（再暗号化・平文化保存を含む）
- **Object Stream（`/Type /ObjStm`、PDF 1.5以降）に対応しています。** cross-reference streamのtype 2 entry（`compressed: true` / `streamNumber` / `indexInStream`）を、対象のObject Streamをdecodeして中の該当objectを取り出すところまで解決します。Catalog・Pages・Page・Resources・Font dictionaryなど、本文抽出経路がたどる通常dictionaryがObject Stream内に格納されていても処理を継続できます（`/ToUnicode`の参照先streamや`/Contents`のcontent streamは仕様上Object Streamへ格納されないため、常にtype 1のまま扱います）。
  - **解析**（`src/object-stream.js`の`parseObjectStream()`）: Object Streamの`/N`（object数）・`/First`（object本体開始byte offset）と、decoded streamの先頭にある`objectNumber offset`のペア列（header）を検証したうえで、各objectの本体をbyte単位で切り出します。`/N`が正の安全な整数でない、`/First`が範囲外、headerが`/N`個そろっていない、offsetが昇順でない・範囲外、といった不正値は明示的なエラーにし、推測補正はしません。ObjStm内部にstream object（PDF仕様上格納できません）を想定するfixtureに遭遇した場合も明示エラーです。
  - **xref情報との整合性検証**: xref type 2 entryが指す対象object番号と、Object Stream header内の`indexInStream`位置に実際に入っているobject番号が一致することを確認し、一致しなければ「object番号の不一致」を明示するエラーにします。
  - **decode順序**: Object Stream自身が暗号化されている場合、`raw stream bytes → AES復号（Object Stream自身のobject番号・generationから導出したobject keyを使用。内部の各compressed objectは個別に復号しません） → FlateDecode → Predictor解除 → header解析 → 内部object抽出`の順で処理します（暗号化されていなければAES復号を省略するだけで、他の順序は共通です）。FlateDecode・Predictor解除はcontent stream等と共通の`decodeStreamBytes()`をそのまま再利用します。xref stream自体は仕様上暗号化・Object Stream格納のいずれの対象にもならないため、この経路には一切含めていません。
  - **async解決**: 通常object用の同期`PdfStructure#object()`はtype 1専用のまま維持し、type 1・type 2いずれも解決できる非同期の`PdfStructure#resolveObject(ref, security?, decrypt?)`を別に用意しています。`object()`をtype 2 entryへ呼ぶと「`resolveObject()`を使うように」という明確なエラーになります。実際にtype 2になり得る参照（Catalog・Pages/Page・Resources・`/Font`辞書）だけを`resolveObject()`に置き換え、`/Contents`や`/ToUnicode`など仕様上streamで格納される参照は従来どおり同期のままです。
  - **cache**: 同じ`PdfTextEditor`/`PdfStructure`インスタンス内で、同じObject Streamは一度だけdecodeし（`objectStreamCache`）、複数のcompressed objectを解決しても再decodeしません。password・file keyそのものはこのcacheに保持しません。
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
- type 2 entry（object stream内のobject）が存在してもxref解析全体は失敗させないこと。同期`object()`をtype 2 entryへ呼ぶと明確なエラーになり、非同期`resolveObject()`は正しくObject Streamを解決できること
- Object Streamの`/N`・`/First`が不正（負・0・非数値・stream長超過・header途中）な場合、headerのペア数が`/N`に足りない場合、offsetが昇順でない・重複・範囲外の場合、`indexInStream`が`/N`以上の場合、xref type 2 entryが指すobject番号とObject Stream header内のobject番号が食い違う場合に、それぞれ明確なエラーになること（`test/object-stream.test.js`・`test/object-stream-resolve.test.js`）
- 1つのObject Streamに複数objectを格納しても、それぞれ`streamNumber`/`indexInStream`から正しく個別に取得できること。同じObject Streamを複数object分解決しても、decodeが1回しか行われないこと（cache）
- Object StreamがFlateDecode単独、およびFlateDecode + PNG Predictorの場合の双方で正しくdecodeできること
- Standard Security Handler R4 / AESV2で暗号化されたPDFで、Object Stream自身がAES暗号化されている場合に、Object Stream自身のobject番号から導出したobject keyで復号してから内部objectを取得できること（内部object個々を復号しないこと）。AESV2 + Predictorの組合せでも同様に取得できること
- Font dictionaryやPage dictionaryがObject Stream内に格納されていても、`/ToUnicode`による日本語復号やCatalog→Pages→Page→Contentsのページツリー解決が通常どおり動作すること
- Object Stream対応後も、非暗号化PDFの`listTextRuns()` → `replaceText()` → `save()` → 再読込み、および暗号化PDFの認証 → 復号 → 検索 → `/P`文書変更禁止時の置換拒否が、いずれも従来どおり動作すること
- 不正な`/W`・奇数個の`/Index`・`/W`と`/Index`が示す長さに合わないstreamで、ハングや過大なメモリ確保をせず例外になること
- `/Index`の各subsectionが`/Size`を超える、順序が昇順でない、subsection同士が重複する、といった`/Index`と`/Size`の矛盾を例外にすること
- cross-reference stream由来のPDFで`listTextRuns()` → `replaceText()` → `save()` → 再読込みが通ること
- PNG Predictor（None・Sub・Up・Average・Paeth）が、独立に実装した参照エンコーダで作った既知fixtureと完全一致で復元できること。`Predictor`の数値（10〜15）に関わらず、rowごとの実際のfilter typeバイトを読み取ること
- TIFF Predictor 2が、`Colors`が2以上（同一color componentの前サンプルを正しく参照）でも復元できること。8bit以外の`BitsPerComponent`は明確なエラーになること
- `/Columns`・`/Colors`・`/BitsPerComponent`省略時の既定値（1・1・8）、および`/DecodeParms`の`<< >>`形式・単要素配列`[ << >> ]`形式の両方を正しく解釈できること
- rowサイズがstream長と合わない場合・未知のPNG filter typeの場合・`/Columns`等が0以下または安全な整数範囲外の場合に、ハングや過大なメモリ確保をせず例外になること
- `/Predictor 12.5`・`/Columns foo`のような小数・非数値のDecodeParms値を、先頭の数字だけを読んで推測せず拒否すること。`/BitsPerComponent`が仕様の許容値（1・2・4・8・16）以外の場合（例: 3、5）に例外になること
- Predictor付きのxref stream・content stream・ToUnicode CMap streamそれぞれから正しく本文runやCMapを取得できること
- Predictor付きcontent streamに対して`listTextRuns()` → `replaceText()` → `save()` → 再読込みが通ること。保存後のstreamはPredictorなしの`/FlateDecode`として書き戻され、`/DecodeParms`も除去されること
- `/Encrypt`を持つトレーラーでもxref解析自体は失敗せず、`listTextRuns()`の時点で初めて拒否されること。診断（`encryptionDiagnosis`）が`/V`（1・2・4・5）・`/R`・`/Length`（`/V 1`・`/V 2`のみ省略時40、`/V 4`・`/V 5`では省略時`unspecified`のまま推測しない）・`/EncryptMetadata`（true/false/省略時true）・`/CF`の`/CFM`（`/None`・`/V2`・`/AESV2`・`/AESV3`のラベル付け、bytes単位の`/Length`をbit単位に変換した値と併記）を正しく読み取ること
- 既知の`/P`値（`R4`で`-44`）から、印刷・内容コピーは許可、文書変更・注釈は制限、かつ`/R >= 3`の4項目（フォーム入力・アクセシビリティ抽出・文書構成変更・高品質印刷）はすべて許可、という仕様どおりのbit解釈になること。`/R 2`ではこの4項目を`null`のまま返し、bitを読んで推測しないこと
- `/Filter /Adobe.PubSec`のようなStandard以外のSecurity Handlerを誤ってStandardとして扱わず、`/P`・`/CF`など固有フィールドを解釈しないこと
- 暗号化されたトレーラーがcross-reference stream由来（classic xrefの`trailer`ではなく`/Type /XRef`辞書の`/Encrypt`）でも参照解決できること。また、xref stream + `/FlateDecode` + PNG Predictorという実PDFで見られる組み合わせと`/Encrypt`が同時に成立していても、診断まで到達できること
- MD5・RC4の自前実装が、それぞれ既知のtest vector（MD5はRFC 1321、RC4はよく知られた公開ベクタ）および複数長にわたる`node:crypto`との比較で一致すること
- password padding、file encryption keyの導出（Algorithm 2）、`/U`によるuser password認証（Algorithm 6）、`/O`によるowner password認証（Algorithm 7）が、この実装とは別に書いた参照実装（Pythonの`hashlib.md5`と仕様どおりのRC4のみを使用し、pypdfや`cryptography`パッケージには依存しない）が算出した`/O`・`/U`・file keyの既知の値と一致すること。誤ったpasswordでは明確に認証失敗になること
- `/O`・`/U`・`/ID`のliteral string（`\n`・`\r`・`\t`・`\b`・`\f`・`\(`・`\)`・`\\`のnamed escape、最大3桁のoctal escape、行継続）とhex string（内部の空白無視、奇数桁のpadding）を、byte `0x80`〜`0x9F`を含むfixtureで正しくbyte-exactに解析できること。`/CF`のような入れ子辞書をstring値と誤認しないこと
- 非ASCII password（例: `café`）をPDFDocEncodingで正しく符号化し、認証に成功すること（同じpasswordをUTF-8で符号化すると異なるbyte列になり認証に失敗する、という区別がつくこと）。PDFDocEncodingが表現できない文字（`U+00A0`・`U+00AD`・`U+007F`・`U+0018`〜`U+001F`・対応表にない文字）を含むpasswordは、明確なエラー、かつ`listTextRuns()`からは「他のエラー」ではなく通常の認証失敗（`passwordRequired: true`）として扱われること
- objectごとの鍵導出が、object number・generation numberのいずれを変えても異なる鍵になること（AESV2の`"sAlT"`付きとRC4想定の`"sAlT"`なしでも異なること）
- 空のuser passwordでの自動認証、明示的なuser password再試行、owner passwordでの認証（`authType`が`user`/`owner`を正しく区別すること）、誤ったpasswordでの認証失敗（`passwordRequired: true`、パスワード自体はエラーメッセージに含まれないこと）
- AESV2で暗号化されたcontent streamおよびToUnicode CMap streamを復号し、正しい本文・日本語テキストを取得できること。`/StmF /Identity`が指定されたstreamは復号せずそのまま扱われること
- AES暗号化データが破損している場合（PKCS#7 paddingが不正になるようcontent stream末尾を1byte改変）、`zlib`のエラーなど別の失敗にすり替わらず、AES-CBC復号自体の明確なエラーになること
- `listTextRuns()` → `replaceText()` → `save()`が、AES decrypt → `/FlateDecode`展開 → Predictor解除、という順序で実PDFと同じ組み合わせを通ること
- `/P`の文書変更permissionがないPDFでは、認証に成功していても`replaceText()`が明確な理由付きで拒否し、`listTextRuns()`（検索）は引き続き利用できること。permissionがあるPDFでは`replaceText()`は成功するが、暗号化PDFへの`save()`は（再暗号化が未対応のため）明確な理由で拒否されること。何も変更していなければ`save()`は暗号化PDFでも元のbytesを返すこと
- corpus評価（`assessPdfBytes`）が、暗号化PDFに`encryption: { filter, V, R, method, authenticated, authType, modifyAllowed }`の要約を付け、認証・復号に成功しても`load: ○`かつ`extract: ○`止まりで、permission拒否や再暗号化保存未対応を理由に編集成功とはみなさないこと。要約にpassword自体を含まないこと

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
| `src/object-stream.js` | `/Type /ObjStm`のheader（`/N`・`/First`）解析とcompressed objectの切り出し。暗号処理・xref処理は含まない |
| `src/encryption.js` | `/Encrypt`辞書の診断（復号は行わない）。DOM非依存で、Nodeのテストからも読み込む |
| `src/pdf-dictionary-text.js` | 辞書text内の名前・文字列・真偽値・入れ子辞書の抽出。`src/encryption.js`と`src/security/decrypt.js`が共有する |
| `src/security/decrypt.js` | 暗号化PDFの認証（対応範囲の判定含む）とstream/string復号のオーケストレーション |
| `src/security/standard-r4.js` | Standard Security Handler R4の認証・鍵導出アルゴリズム（PDF知識のみ、AESには触れない） |
| `src/security/md5.js` / `src/security/rc4.js` | 認証アルゴリズムに必要な最小限のMD5・RC4自前実装（外部npm依存なし） |
| `src/security/aes.js` | AESV2のAES-CBC復号。`crypto.subtle`（Web Crypto API）を使い、ブラウザ・Node両方で動く |
| `src/security/pdfdoc-encoding.js` | R4以前のpassword用PDFDocEncoding符号化。表現できない文字は明確なエラーにする |

### 単一PDF検証: PDFプレビュー＋文字列検索・置換

主操作は「runを直接選択して編集」ではなく「文字列を検索し、一致した箇所を置換」です。PDF内部構造（run・objectNumber・bytesなど）は通常操作からは隠し、「詳細・デバッグ情報」を開いたときだけ確認できます。

1. 「単一PDF検証」タブでPDFを1件選ぶ（ドラッグ＆ドロップ可）
2. 選択した元PDFを、ブラウザ標準のPDF表示で`<iframe>`にプレビューする（Blob URL、送信なし）
3. `PdfTextEditor`初期化と`listTextRuns()`を実行し、検索欄を有効化する
4. 検索文字列を入力すると、一致箇所を一覧表示する（一致件数・前後の文脈・置換可否バッジ・構成run）
5. 一致を1件選ぶと置換後テキスト欄にその一致テキストが入り、置換後の文字列を編集できる
6. 「置換してPDFを保存」を押すと、`replaceText()` → `save()` → 保存結果の再読込確認（reopen）の順に検証し、成功した場合だけ`元ファイル名.edited.pdf`としてローカル保存する

**PDFプレビュー。** 選択したPDFは`Blob`から`URL.createObjectURL()`で作った`blob:` URLを`<iframe>`に読み込むだけで、外部PDF.jsなどは追加していません。新しいPDFを選ぶたびに古いBlob URLは`URL.revokeObjectURL()`で破棄します。プレビューは自作エンジンの解析結果とは独立して、ファイルの読み取りに成功していれば表示を試みます。プレビューが表示できないブラウザ・PDFでも検索・置換機能自体は利用でき、逆に自作エンジンが本文runを抽出できないPDF（対応範囲外の暗号化PDF、未対応のObject Stream構造など）でもプレビューは表示を試みます。**プレビュー表示の成否とPDF解析の成否は独立した別の事実です。**

**文字列検索。** PDF内部では、"令和8年度" が `令` / `和` / `8` / `年度` のように複数の`Tj`オペランドへ分かれて格納されていることがあります。検索は`listTextRuns()`の結果を**同じcontent stream（`objectNumber`）由来・同じ`BT ... ET`ブロック（`textObjectId`）由来・かつ出現順が連続しているrun**だけを連結した区間ごとに行うため、①複数runにまたがる文字列を1つの検索語として一致させつつ、②別のcontent streamの末尾と次のstreamの先頭を連結して誤一致することを防ぎ、③**同じcontent stream内でも別の`BT ... ET`（ページ上の別位置へ独立して移動して描画されることが多い）を跨いだ連結**も防ぎます。③は`objectNumber`だけでは区別できないため、`src/content-stream.js`が`BT`ごとに採番する`textObjectId`をrunへ持たせ、検索側もこれを区切りに使っています。一致ごとに、構成するrun ID・run数・前後の文脈を保持し、画面にも表示します。

**置換可否バッジ。** 一致が単一run内に収まる場合は常に「○ 単一run（構造上置換可能）」です（部分一致でもrun全体を「一致前 + 置換後 + 一致後」で書き換える1回の`replaceText()`呼び出しで済みます）。「構造上」と限定しているのは、ToUnicodeなし・CMap逆引き不可・置換文字のglyphなしといった理由で実際の`replaceText()`が失敗することがあり、このバッジは複数run分割ルールの対象外であることしか保証しないためです。複数runにまたがる一致は「△ Nrunに分割されています」と表示し、**置換後の文字列が元の一致と同じ文字数の場合に限り**、元の各runが一致へ提供していた文字数と同じ割合で置換文字列を分割し、runごとに`replaceText()`を呼びます。文字数が異なる場合は、content streamの再構成やレイアウト調整が必要になり本PoCの範囲を超えるため、「この一致箇所は現在のPoCでは置換不可です」（分類ラベル: 複数runにまたがるため現在の方式では置換不可）と表示し、置換を実行しません。CMap逆引きの可否など実際に`replaceText()`を試さないと分からないものは事前判定せず、実行時エラーとして表示します。

**保存前のreopen確認。** 置換後は`save()`の結果を新しい`PdfTextEditor`で読み込み直し、本文runが取得できることを確認してから初めてダウンロードします。再読込に失敗した場合はダウンロードせず「保存後PDFの再読込に失敗しました」と表示します。**自作エンジンで再読込できたことは、Acrobat Reader等で正常表示できることを意味しません。**保存した編集済PDFは独立したreaderで必ず確認してください。

`text`はfontの`/ToUnicode` CMapによる復号結果です。復号できないrunがあってもPoC全体は止めず、「詳細・デバッグ情報」のrun一覧でそのrunに「復号不可を含む」と表示します。置換は常に元バイト列の複製に対して行うため、**元のPDFファイルは変更されません**。失敗時は、失敗した段階・推定される原因・エラー原文・元PDFが無変更であることを表示します（エラーは握り潰しません）。

**詳細・デバッグ情報。** `<details>`内に、従来どおりの本文run一覧（`id` / `objectNumber` / `fontName` / `text` / 文字数 / bytes数 / bytes hex、既定で折りたたみ）と、run一覧から1件を直接選んで置換する検証用UIを残しています。通常操作には使いませんが、検索・置換モデルが内部でどのrunを操作しているかを確認する用途で利用できます。

**暗号化PDF。** 選択したPDFが`/Encrypt`を持つ場合の挙動は、対応範囲かどうかで分かれます。

- **対応範囲（`Standard` / `V4` / `R4` / `AESV2`または`Identity`）:** まず空のuser passwordで自動的に認証を試みます。成功すれば、方式（例: `Standard / AES-128 / R4`）・認証方法（`○ 空のuser passwordで認証成功`）・権限（閲覧・検索は常に利用可能、文書変更は`/P`次第）を表示したうえで、通常どおり本文run一覧・検索が使えます。空passwordで認証できなければ`× パスワードが必要です`とパスワード入力欄を表示し、入力・認証すると同じ画面がそのまま更新されます。**入力したパスワードは送信・保存されません**（`fetch`等は使わず、`localStorage`/`sessionStorage`にも書き込まず、コンソール出力やエラーメッセージ・`assessment.json`にも含めません）。`/P`の文書変更permissionがない場合、置換入力欄とボタンはあらかじめ無効化され、その旨を表示します（実行しようとした場合も`replaceText()`自身が明確な理由で拒否します）。
- **対応範囲外（`/R 2`・`/R 3`・`/R 5`・`/R 6`・`/AESV3`・`/Adobe.PubSec`など）:** パスワードでは解決しないため、パスワード入力欄は出さず、Security Handler・`/V`・`/R`・`/Length`・`/EncryptMetadata`・Crypt Filter・推定方式・`/P`権限を、「確定できる情報」（辞書の記載）と「推定」を見出しを分けて表示する診断専用の画面になります（パスワード状態は常に「未判定 / PoC対象外」）。

どちらの場合も、PDFプレビューは（読み取れたbytesがある限り）本文解析の成否とは独立に表示を試みます。`/Encrypt`辞書のobject番号・生の`/Length`・`/StmF`・`/StrF`・診断JSON全体など内部的な値は、認証の成否に関わらず「詳細・デバッグ情報」の中に別枠で表示し、通常の要約とは分けています。「複数PDF評価」の結果表には、この診断・認証結果から作った短い要約（`暗号化PDF（Standard / AES-128 / R4）`や`暗号化PDF（文書変更が許可されていません／P permission）`のような形式）がエラー分類として表示されますが、認証・復号に成功しても`load: ○ / extract: ○`止まりで、`/P`のpermission拒否や再暗号化保存の未対応により、編集成功（`writeback` / `save`まで成功）とはみなしません。

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

失敗時は既存のエラーメッセージをそのまま表示したうえで、xref stream解析失敗（破損した`/W`・`/Index`・stream長など）、object stream解析失敗（`/ObjStm`の`/N`・`/First`・header不整合など）、Predictor未対応または不正（未対応の値・row長不正・TIFF Predictorの未対応bit depthなど）、暗号化PDF、unsupported filter、本文runなし、ToUnicodeなし、CMap逆引き失敗（glyph不足の可能性）、保存失敗、再読込失敗などの分類を併記します。

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
