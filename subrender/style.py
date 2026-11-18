"""Everything that decides what a subtitle looks like, in one place.

A folder's subreview.json holds a ``style`` object with any of these fields;
whatever it leaves out takes the default below. The defaults are an opaque
full-width backdrop with two speakers on two rows; a show with a different
look sets the same fields differently in its own subreview.json.

Lengths are fractions of the frame height unless the comment says otherwise, so
a 720p and a 1080p rip come out looking the same. Colours are RGB hex.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields


@dataclass
class Style:
    zh_font: str = "Hiragino Sans GB"
    py_font: str = "Helvetica Neue"
    en_font: str = "Helvetica Neue"

    zh_size: float = 0.0500
    py_size: float = 0.0290
    en_size: float = 0.0350

    zh_colour: str = "FFFFFF"
    py_colour: str = "D7E4F2"        # a shade cool of white, so the two rows read apart
    en_colour: str = "FFFFFF"
    en_bold: bool = True

    # Outline and drop shadow, as fractions of that layer's own font size.
    # Text on a backdrop needs neither; text straight on the picture needs both.
    zh_outline: float = 0.0
    zh_shadow: float = 0.0
    py_outline: float = 0.0
    py_shadow: float = 0.0
    en_outline: float = 0.0
    en_shadow: float = 0.0

    # Line heights, as multiples of each layer's font size.
    py_line: float = 1.0
    zh_line: float = 1.0
    en_line: float = 1.18

    ruby_gap: float = 0.002          # pinyin row to its hanzi row
    row_gap: float = 0.008           # between two rows of hanzi
    block_gap: float = 0.011         # between the Chinese block and the English
    bottom_margin: float = 0.020     # frame bottom to the bottom of the text block
    word_gap: float = 0.008          # between adjacent words
    max_width: float = 0.92          # of frame width, before wrapping

    # Start a new row at every speaker dash, in the Chinese and the English,
    # even when both turns would fit on one: run together they read as one
    # person talking.
    break_on_dash: bool = True

    # The backdrop. "all" is one box from above the text to the frame bottom;
    # "chinese" is a band behind the hanzi and pinyin only; "none" draws none.
    box_covers: str = "all"
    box_colour: str = "000000"
    box_opacity: float = 0.85        # 1 = solid
    box_pad: float = 0.010           # above the text (and below it, for "chinese")
    box_full_width: bool = True      # else fitted to the widest cue, see box_hpad
    box_hpad: float = 0.014          # each side of the widest line, of frame width
    # Hold one height for the ordinary cues, so the box does not jump as the
    # dialogue changes; sized to this quantile of the episode's cue heights.
    box_steady: bool = True
    box_steady_pct: float = 0.85
    # Stretch up far enough to hide a subtitle burned into the picture, using
    # meta.band from the transcript.
    cover_burned_in: bool = False
    cover_pad: float = 0.005

    def as_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Style":
        known = {f.name for f in fields(cls)}
        unknown = sorted(set(d) - known)
        if unknown:
            # A typo here would otherwise be silently ignored, and the file
            # would render in a style nobody asked for.
            raise ValueError(f"unknown style field(s): {', '.join(unknown)}")
        if d.get("box_covers", "all") not in ("all", "chinese", "none"):
            raise ValueError('box_covers must be "all", "chinese" or "none"')
        return cls(**d)
