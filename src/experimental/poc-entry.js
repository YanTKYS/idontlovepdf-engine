// Browser entry point for the font-embedding experiment's own bundle (see
// scripts/build-poc.js). Re-exports the engine's public API alongside the experiment so
// a page can run the whole flow from one module. Not part of the released library.
export { PdfTextEditor, ENGINE_VERSION } from "../index.js";
export {
  loadFallbackFont,
  checkTextMatchReplacementWithFallback,
  replaceTextMatchWithFallbackFont
} from "./font-embedding.js";
