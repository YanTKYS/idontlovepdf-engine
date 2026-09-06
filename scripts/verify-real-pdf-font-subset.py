#!/usr/bin/env python3
"""Independently verifies every /FontFile2 stream embedded in a PDF, using tools that
share no code with this engine (pikepdf, which wraps qpdf's own object model, plus
fontTools and FreeType). This is what item 19/7 of the fallback-font-subsetting PoC calls
for: proving the sfnt this engine wrote passes strict checksum validation, and that an
independent rasterizer can actually load its glyphs -- not only that Chromium happens to
display it or that this engine's own opentype.js re-parse accepts it.

    python3 scripts/verify-real-pdf-font-subset.py <file.pdf>

Exits non-zero if any embedded font fails fontTools' strict checksum check or FreeType
cannot load it. Never writes back to the PDF; extracted font bytes are written only to
temporary files, which are removed at exit.
"""
import sys
import tempfile
from pathlib import Path

import pikepdf
from fontTools.ttLib import TTFont

try:
    import freetype
except ImportError:
    freetype = None

try:
    import pymupdf
except ImportError:
    pymupdf = None


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: python3 scripts/verify-real-pdf-font-subset.py <file.pdf> [--expect-text TEXT]", file=sys.stderr)
        return 2
    path = Path(args[0])
    expect_text = None
    if "--expect-text" in args:
        expect_text = args[args.index("--expect-text") + 1]

    failed = check_font_programs(path)

    if pymupdf is not None:
        print("\n--- MuPDF (PyMuPDF): opening and rendering the page ---")
        try:
            doc = pymupdf.open(path)
            page = doc[0]
            text = page.get_text()
            pixmap = page.get_pixmap()
            print(f"MuPDF: page text = {text!r}")
            print(f"MuPDF: rendered a {pixmap.width}x{pixmap.height} pixmap ({len(pixmap.samples)} bytes) with no error")
            if expect_text is not None and expect_text not in text:
                print(f"FAIL: expected {expect_text!r} to appear in MuPDF's extracted text, got {text!r}")
                failed = True
            doc.close()
        except Exception as error:
            print(f"FAIL: MuPDF could not open/render this PDF: {error}")
            failed = True
    else:
        print("note: pymupdf not installed, skipping the MuPDF render check")

    return 1 if failed else 0


def check_font_programs(path):
    pdf = pikepdf.open(path)
    found = 0
    failed = False

    for obj in pdf.objects:
        try:
            if not isinstance(obj, pikepdf.Stream):
                continue
            obj_dict = obj
        except Exception:
            continue
        if obj_dict.get("/Length1") is None:
            continue
        # A /FontFile2 stream: FontDescriptors point to these, but pikepdf's flat object
        # iteration does not tell us which dictionary held the reference, so /Length1's
        # presence (a key /FontFile2 always carries, and nothing else does) identifies it.
        try:
            data = bytes(obj_dict.read_bytes())
        except Exception as error:
            print(f"FAIL: could not read a /FontFile2 stream's bytes: {error}")
            failed = True
            continue

        found += 1
        length1 = int(obj_dict.get("/Length1"))
        print(f"\n--- font program #{found}: {len(data)} decoded bytes (/Length1 = {length1}) ---")
        if len(data) != length1:
            print(f"FAIL: decoded length {len(data)} does not match /Length1 {length1}")
            failed = True

        with tempfile.NamedTemporaryFile(suffix=".ttf", delete=True) as tmp:
            tmp.write(data)
            tmp.flush()

            try:
                font = TTFont(tmp.name, checkChecksums=2)
                num_glyphs = font["maxp"].numGlyphs
                print(f"fontTools: loaded OK, checksums verified (strict), numGlyphs={num_glyphs}")
                font.close()
            except Exception as error:
                print(f"FAIL: fontTools rejected this font program: {error}")
                failed = True
                continue

            if freetype is None:
                print("note: freetype-py not installed, skipping the FreeType load check")
                continue
            try:
                face = freetype.Face(tmp.name)
                face.set_char_size(48 * 64)
                non_empty = 0
                sample = min(face.num_glyphs, 200)
                for gid in range(sample):
                    face.load_glyph(gid, freetype.FT_LOAD_DEFAULT)
                    if face.glyph.outline.n_contours > 0:
                        non_empty += 1
                print(f"FreeType: loaded OK, num_glyphs={face.num_glyphs}, {non_empty}/{sample} sampled glyphs have outlines (a real subset keeps only a few)")
            except Exception as error:
                print(f"FAIL: FreeType rejected this font program: {error}")
                failed = True

    if found == 0:
        print("no /FontFile2 streams found in this PDF (no fallback font was embedded)")
        return False

    print(f"\n{found} font program(s) checked, {'FAILURES ABOVE' if failed else 'all OK'}")
    return failed


if __name__ == "__main__":
    raise SystemExit(main())
