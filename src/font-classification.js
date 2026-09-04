/**
 * Serif or sans-serif, best-effort, from a font resource's own FontDescriptor -- never from
 * its name.
 *
 * This exists for exactly one thing: choosing which of two visually similar fallback fonts
 * (see src/fallback-font.js) looks closer to the document's own, so a replacement drawn in
 * a caller-supplied font is less visually jarring than always drawing it in the same one.
 * It is not, and must never become, a safety judgement -- whether a replacement is safe to
 * write is decided entirely in pdf-document.js from measured glyph widths, exactly as
 * before this existed, whichever fallback font ends up chosen here.
 *
 * PDF states this itself: FontDescriptor's /Flags (PDF 32000-1:2008, 9.8.2, Table 123) has
 * a Serif bit. When a font's own descriptor sets it, that is used directly -- nothing here
 * re-derives serifness from the glyph outlines or the font's name. Reused rather than
 * reimplemented: reaching the right FontDescriptor for a Type0/CIDFont composite font is
 * exactly what resolveDescendantFont() in font-metrics.js already does for glyph-width
 * measurement (an inline or indirect /DescendantFonts, an indirect /FontDescriptor, all
 * through the engine's one object resolver), and reading a /Flags integer that may be
 * direct or indirect is exactly what resolvedNumber() already does for /DW and /FirstChar.
 * Neither is duplicated here.
 *
 * v0.5.1 additionally reads a /FontDescriptor written inline (`/FontDescriptor << ... >>`,
 * right where a simple font or a Type0's descendant CIDFont dictionary states it) rather
 * than only an indirect reference (`/FontDescriptor 12 0 R`) -- the shape a real, published
 * PDF (22550.pdf's /F3; see docs/serif-classification-diagnosis.md) actually writes it in,
 * alongside its already-inline /DescendantFonts CIDFont dictionary (v0.4.3). Before this, an
 * inline FontDescriptor was indistinguishable from no FontDescriptor at all: reference()
 * only ever matches `N G R`, so classifyFontResource() fell through to "unknown" -- and thus
 * to the sans fallback -- however plainly the document's own /Flags stated Serif. Reused
 * again rather than reimplemented: nestedDictionaryText() (pdf-dictionary-text.js) is the
 * same whole-dictionary-text reader src/encryption.js already uses for an Encrypt
 * dictionary's inline /CF sub-dictionary.
 */
import { reference } from "./pdf-structure.js";
import { nestedDictionaryText } from "./pdf-dictionary-text.js";
import { resolveDescendantFont, resolvedNumber } from "./font-metrics.js";

/** FontDescriptor /Flags bit 2 (value 2): the font's glyphs have serifs. */
const FLAG_SERIF = 0x00000002;

async function tryResolve(resolve, target) {
  try {
    return await resolve(target);
  } catch {
    return null;
  }
}

/**
 * The FontDescriptor dictionary text describing a font resource's glyphs, plus how it was
 * reached, or a `reason` (one of CLASSIFICATION_REASONS below) when none can be reached --
 * following the same two paths font-metrics.js already reads exactly: direct on a simple
 * font (Type1/TrueType/MMType1), or on a Type0's descendant CIDFont, walked through
 * resolveDescendantFont() so an inline or indirect /DescendantFonts array is handled the one
 * way the rest of the engine already handles it. `/FontDescriptor` itself may then be an
 * indirect reference or a dictionary written right there -- both are read.
 */
async function fontDescriptorOf(fontDictionary, resolve) {
  let holder = fontDictionary;
  if (/\/Subtype\s*\/Type0\b/.test(fontDictionary)) {
    const descendant = await resolveDescendantFont(fontDictionary, resolve);
    holder = descendant.dictionary ?? null;
  }
  if (!holder) return { text: null, form: null, object: null, reason: "font-descriptor-missing" };
  const indirect = reference(holder, "FontDescriptor");
  if (indirect) {
    const object = await tryResolve(resolve, indirect);
    if (!object?.dictionary) return { text: null, form: null, object: null, reason: "font-descriptor-unresolved" };
    return { text: object.dictionary, form: "indirect", object: `${indirect.number} ${indirect.generation} R`, reason: null };
  }
  const inline = nestedDictionaryText(holder, "FontDescriptor");
  if (inline) return { text: inline, form: "inline", object: null, reason: null };
  return { text: null, form: null, object: null, reason: "font-descriptor-missing" };
}

/**
 * Developer-facing reasons classifyFontResourceDetailed() can report alongside "unknown",
 * naming exactly which step of reading the source font's own FontDescriptor/Flags produced
 * that answer. Never part of the public API (see index.js) and never a safety judgement --
 * see the file-level comment above -- this exists purely so a real document's fallback font
 * choice can be explained (see diagnoseFallbackFontSelection() in pdf-document.js and
 * scripts/diagnose-font-classification.js) instead of guessed about.
 */
export const CLASSIFICATION_REASONS = Object.freeze([
  /** Nowhere to look: no FontDescriptor reachable at all (absent key, or no descendant font). */
  "font-descriptor-missing",
  /** An indirect /FontDescriptor whose object could not be resolved. */
  "font-descriptor-unresolved",
  /** A FontDescriptor was reached, but it states no /Flags at all. */
  "flags-missing",
  /** A FontDescriptor was reached, but its indirect /Flags object could not be resolved. */
  "flags-unresolved",
  /** A FontDescriptor was reached, but /Flags is present and not a valid integer. */
  "flags-invalid",
  /** /Flags is present and a valid integer, but literally 0 -- nothing set, so nothing to read. */
  "flags-zero",
  /** /Flags resolved to a nonzero integer with the Serif bit (PDF Table 123, bit 2) set. */
  "serif-flag-set",
  /** /Flags resolved to a nonzero integer with the Serif bit not set. */
  "serif-flag-not-set"
]);

/**
 * "serif", "sans", or "unknown" (the last for every reason in CLASSIFICATION_REASONS other
 * than the two "serif-flag-*" ones), plus which of those reasons produced it and the
 * FontDescriptor this reached, if any -- developer diagnostics only, never a safety
 * judgement (see the file-level comment above). classifyFontResource() below is the public-
 * facing wrapper every caller inside the engine actually uses; this is what
 * diagnoseFallbackFontSelection() and scripts/diagnose-font-classification.js report from.
 */
export async function classifyFontResourceDetailed(fontDictionary, resolve) {
  const descriptor = await fontDescriptorOf(fontDictionary, resolve);
  const fontDescriptor = { form: descriptor.form, object: descriptor.object, text: descriptor.text };
  if (!descriptor.text) {
    return { classification: "unknown", reason: descriptor.reason, fontDescriptor, flags: { value: null, serifBit: null } };
  }
  const flags = await resolvedNumber(descriptor.text, "Flags", resolve, { unresolved: "flags-unresolved", invalid: "flags-invalid" });
  if (flags.reason) return { classification: "unknown", reason: flags.reason, fontDescriptor, flags: { value: null, serifBit: null } };
  if (flags.value === null) return { classification: "unknown", reason: "flags-missing", fontDescriptor, flags: { value: null, serifBit: null } };
  if (!Number.isInteger(flags.value)) {
    return { classification: "unknown", reason: "flags-invalid", fontDescriptor, flags: { value: flags.value, serifBit: null } };
  }
  if (flags.value === 0) return { classification: "unknown", reason: "flags-zero", fontDescriptor, flags: { value: 0, serifBit: false } };
  const serifBit = (flags.value & FLAG_SERIF) !== 0;
  return {
    classification: serifBit ? "serif" : "sans",
    reason: serifBit ? "serif-flag-set" : "serif-flag-not-set",
    fontDescriptor,
    flags: { value: flags.value, serifBit }
  };
}

/**
 * "serif", "sans", or "unknown" -- the last whenever nothing in the file states it plainly:
 * no FontDescriptor reached at all, no /Flags, an unresolvable indirect /Flags, or /Flags
 * stating literally 0 (nothing set, so nothing to read from it). Unknown is a normal,
 * expected answer, not a failure: a caller with no better information falls back to
 * whichever fallback font the current, pre-classification engine already used for
 * everything -- see selectFallbackFont() in pdf-document.js.
 */
export async function classifyFontResource(fontDictionary, resolve) {
  return (await classifyFontResourceDetailed(fontDictionary, resolve)).classification;
}
