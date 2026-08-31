/**
 * Encodes a JS string into PDFDocEncoding bytes, per PDF 32000-1:2008 Annex D.2 --
 * required for Standard Security Handler passwords under revision <= 4 (revision 5
 * onward uses UTF-8 for the file's own U/UE strings instead, but this codebase only
 * implements R4 -- see src/security/standard-r4.js). PDFDocEncoding is NOT the same
 * as UTF-8 or as `TextDecoder("latin1")`'s windows-1252: a non-ASCII password
 * (e.g. containing "é") encoded as UTF-8 would authenticate against the wrong file
 * key, since a real PDF writer encoded that same password as PDFDocEncoding before
 * hashing it.
 *
 * A character this encoding cannot represent throws immediately rather than being
 * silently substituted or guessed at -- the caller (standard-r4.js) treats that the
 * same as an authentication failure, since the real password (whatever it is) must
 * itself have been representable when the document was encrypted.
 *
 * The mapping and algorithm are transcribed from QPDF's
 * QUtil::utf8_to_pdf_doc()/transcode_utf8() (libqpdf/QUtil.cc) -- a long-maintained,
 * independent reference implementation of this exact PDF spec table -- not derived
 * from guesswork or from this codebase's own (previously incorrect) UTF-8 handling.
 */

// Unicode code point -> PDFDocEncoding byte, for the code points PDFDocEncoding
// assigns to specific typographic/accent characters at byte positions that would
// otherwise (in Latin-1/windows-1252) mean something else -- breve/caron/etc. at
// 0x18-0x1F, and punctuation/ligatures/accents at 0x80-0x9F plus the Euro sign at
// 0xA0 (displacing NBSP, which PDFDocEncoding does not represent at all).
const SPECIAL = new Map([
  [0x02d8, 0x18], [0x02c7, 0x19], [0x02c6, 0x1a], [0x02d9, 0x1b],
  [0x02dd, 0x1c], [0x02db, 0x1d], [0x02da, 0x1e], [0x02dc, 0x1f],
  [0x2022, 0x80], [0x2020, 0x81], [0x2021, 0x82], [0x2026, 0x83],
  [0x2014, 0x84], [0x2013, 0x85], [0x0192, 0x86], [0x2044, 0x87],
  [0x2039, 0x88], [0x203a, 0x89], [0x2212, 0x8a], [0x2030, 0x8b],
  [0x201e, 0x8c], [0x201c, 0x8d], [0x201d, 0x8e], [0x2018, 0x8f],
  [0x2019, 0x90], [0x201a, 0x91], [0x2122, 0x92], [0xfb01, 0x93],
  [0xfb02, 0x94], [0x0141, 0x95], [0x0152, 0x96], [0x0160, 0x97],
  [0x0178, 0x98], [0x017d, 0x99], [0x0131, 0x9a], [0x0142, 0x9b],
  [0x0153, 0x9c], [0x0161, 0x9d], [0x017e, 0x9e], [0x20ac, 0xa0]
]);

function unrepresentable(codepoint) {
  const hex = codepoint.toString(16).toUpperCase().padStart(4, "0");
  const error = new Error(`Password contains a character that cannot be represented in PDFDocEncoding (U+${hex})`);
  // Marks this specific failure as safe to treat the same as "wrong password"
  // (recoverable: prompt again) -- see tryAuthenticate() in security/decrypt.js,
  // which catches *only* errors carrying this marker and lets anything else
  // (a genuine bug, a missing Web Crypto API, ...) propagate as a real error
  // instead of being silently swallowed into a misleading "wrong password".
  error.recoverableWrongPassword = true;
  return error;
}

export function encodePdfDocPassword(text) {
  const bytes = [];
  for (const char of text ?? "") {
    const codepoint = char.codePointAt(0);
    if (codepoint < 128) {
      // 0x18-0x1F and DEL (0x7F) are reserved for the SPECIAL accent characters
      // above (or simply undefined for DEL); every other ASCII codepoint,
      // including the other C0 control codes, passes through unchanged.
      if ((codepoint >= 0x18 && codepoint <= 0x1f) || codepoint === 0x7f) throw unrepresentable(codepoint);
      bytes.push(codepoint);
      continue;
    }
    if (codepoint === 0xad) throw unrepresentable(codepoint); // soft hyphen: undefined in PDFDocEncoding
    if (codepoint > 0xa0 && codepoint < 0x100) {
      bytes.push(codepoint); // 0xA1-0xFF match Latin-1/windows-1252 exactly
      continue;
    }
    const mapped = SPECIAL.get(codepoint);
    if (mapped === undefined) throw unrepresentable(codepoint);
    bytes.push(mapped);
  }
  return Uint8Array.from(bytes);
}
