// The formal public API of `idontlovepdf-engine`. Consumers -- including the
// `dist/idontlovepdf-engine.js` browser bundle built from this file -- should only
// rely on what is exported here. Every other module under src/ (xref/object-stream
// parsing, Predictor, CMap, encryption/AES internals, ...) is an implementation
// detail and may change shape between versions without notice.
export { PdfTextEditor } from "./pdf-document.js";
export { ENGINE_VERSION } from "./version.js";
