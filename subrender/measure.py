"""Text widths, measured with CoreText.

libass positions text but exposes no metrics, so the layout has to know how
wide each word will be before it can centre a row or decide where to wrap.
CoreText is exact: it is the same font the player will draw with.

In the browser build (Pyodide) there is no CoreText to import, so the width
comes from the page's canvas instead — `subreviewMeasure`, defined in
static/web/engine.js. On a Mac the browser draws with the same system fonts,
which is what keeps the two builds in agreement; elsewhere the fonts differ
and the page says so.

Either way the width is rounded to a millionth of a pixel. The two agree to
far better than that but not to the last bit — CoreText sums glyph advances
in its own order — and a position that lands exactly on .x5 is rounded by
that last bit when the ASS is written.
"""

from __future__ import annotations

from functools import lru_cache

try:
    import CoreText
except ImportError:
    CoreText = None


@lru_cache(maxsize=16384)
def measure(text: str, font: str, size: float) -> float:
    """Advance width of ``text`` in pixels at ``size``."""
    if not text:
        return 0.0
    if CoreText is None:
        from js import subreviewMeasure
        return round(float(subreviewMeasure(text, font, size)), 6)
    ct_font = CoreText.CTFontCreateWithName(font, size, None)
    attributed = CoreText.CFAttributedStringCreate(
        None, text, {CoreText.kCTFontAttributeName: ct_font})
    line = CoreText.CTLineCreateWithAttributedString(attributed)
    return round(float(CoreText.CTLineGetTypographicBounds(line, None, None, None)[0]), 6)
