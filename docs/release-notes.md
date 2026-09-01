# Release notes

各versionのリリース内容を新しい順に記載します。H2見出しには、`v`付きversionとGitHub Releaseのtitleを記載します。

## v0.2.0 - Browser library formalization

- browser向けES Module bundleとして`dist/idontlovepdf-engine.js`を正式化
- 正式公開APIを`PdfTextEditor`と`ENGINE_VERSION`に整理
- bundle経由のPDF処理testとbrowser smoke testを追加
- bundleとSHA-256 checksumをGitHub Release assetとして配布
- xref、Object Stream、Predictor、ToUnicode、R4/AESV2、R6/AESV3を含む既存PDF互換機能を維持
