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
 */
import { reference } from "./pdf-structure.js";
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
 * The FontDescriptor dictionary text describing a font resource's glyphs, or null when
 * none can be reached -- following the same two paths font-metrics.js already reads
 * exactly: direct on a simple font (Type1/TrueType/MMType1), or on a Type0's descendant
 * CIDFont, walked through resolveDescendantFont() so an inline or indirect
 * /DescendantFonts array is handled the one way the rest of the engine already handles it.
 */
async function fontDescriptorOf(fontDictionary, resolve) {
  let holder = fontDictionary;
  if (/\/Subtype\s*\/Type0\b/.test(fontDictionary)) {
    const descendant = await resolveDescendantFont(fontDictionary, resolve);
    holder = descendant.dictionary ?? null;
  }
  if (!holder) return null;
  const indirect = reference(holder, "FontDescriptor");
  if (!indirect) return null;
  const object = await tryResolve(resolve, indirect);
  return object?.dictionary ?? null;
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
  const descriptor = await fontDescriptorOf(fontDictionary, resolve);
  if (!descriptor) return "unknown";
  const flags = await resolvedNumber(descriptor, "Flags", resolve, { unresolved: "flags-unresolved", invalid: "flags-invalid" });
  if (flags.reason || flags.value === null || flags.value === 0 || !Number.isInteger(flags.value)) return "unknown";
  return (flags.value & FLAG_SERIF) !== 0 ? "serif" : "sans";
}
