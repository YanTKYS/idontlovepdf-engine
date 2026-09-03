#!/usr/bin/env python3
"""Independent confirmation that a TJ fallback replacement did not move the text after it.

    python3 scripts/verify-real-pdf-position.py \
        --before original.pdf --after edited.pdf --marker-before 令和 --marker-after しょ

This is deliberately NOT the engine checking its own arithmetic: pdfminer.six is a
separate implementation of PDF content-stream interpretation (its own font-width
handling, its own text-advance formula), with nothing in common with src/. It opens both
the original and the edited PDF, reconstructs each page's text with per-character x
positions, and compares the x position of the character immediately following the first
occurrence of `--marker-before` in the original against the character immediately
following the first occurrence of `--marker-after` in the edited copy. If the engine's
TJ adjustment were wrong, this position would differ -- an independent reader would draw
the following text somewhere else.

Exits non-zero (and prints why) if either marker cannot be found, or if the two positions
differ by more than --tolerance points.
"""
import argparse
import sys

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar


def page_chars(path):
    """(page_index, text, x0, y0) for every glyph, in the order pdfminer draws them.

    Recurses into anything iterable (LTPage, LTFigure, LTTextBox*, LTTextLine*, ...)
    rather than naming every pdfminer container type, so text pdfminer nests inside a
    Form XObject (LTFigure) is not silently skipped.
    """
    for page_index, page_layout in enumerate(extract_pages(path)):
        chars = []

        def walk(element):
            if isinstance(element, LTChar):
                chars.append((element.get_text(), element.x0, element.y0))
                return
            if hasattr(element, "__iter__"):
                for child in element:
                    walk(child)

        walk(page_layout)
        if chars:
            yield page_index, chars


def find_marker(path, marker):
    """The (page_index, x0, y0) of the character right after the first `marker` match."""
    for page_index, chars in page_chars(path):
        text = "".join(character for character, _x, _y in chars)
        found = text.find(marker)
        if found == -1:
            continue
        after_index = found + len(marker)
        if after_index >= len(chars):
            return page_index, None, None, text[max(0, found - 10):found + 10]
        _character, x0, y0 = chars[after_index]
        return page_index, x0, y0, text[max(0, found - 10):found + 10]
    return None, None, None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True, help="the original PDF")
    parser.add_argument("--after", required=True, help="the edited PDF")
    parser.add_argument("--marker-before", required=True, help="text to find in the original (e.g. 令和)")
    parser.add_argument("--marker-after", required=True, help="text to find in the edited copy (e.g. しょ)")
    parser.add_argument("--tolerance", type=float, default=1.0, help="allowed x-position difference, in points")
    args = parser.parse_args()

    before_page, before_x, before_y, before_context = find_marker(args.before, args.marker_before)
    after_page, after_x, after_y, after_context = find_marker(args.after, args.marker_after)

    print(f"before: page={before_page} context={before_context!r} following-char x0={before_x} y0={before_y}")
    print(f"after:  page={after_page}  context={after_context!r} following-char x0={after_x} y0={after_y}")

    if before_page is None:
        print(f"FAIL: {args.marker_before!r} was not found in {args.before} by pdfminer.six")
        return 1
    if after_page is None:
        print(f"FAIL: {args.marker_after!r} was not found in {args.after} by pdfminer.six")
        return 1
    if before_x is None or after_x is None:
        print("FAIL: the marker was the last character pdfminer.six found on its page -- nothing follows it to compare")
        return 1
    if before_page != after_page:
        print(f"FAIL: the marker moved pages ({before_page} -> {after_page})")
        return 1

    dx = abs(before_x - after_x)
    dy = abs(before_y - after_y)
    print(f"dx={dx:.4f} dy={dy:.4f} (tolerance {args.tolerance})")
    if dx > args.tolerance or dy > args.tolerance:
        print("FAIL: the text after the match moved, according to pdfminer.six's own reading of both files")
        return 1

    print("OK: pdfminer.six independently confirms the text after the match did not move")
    return 0


if __name__ == "__main__":
    sys.exit(main())
