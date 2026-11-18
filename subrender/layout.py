"""Where every piece of a subtitle goes: pinyin over hanzi, English under.

Each word becomes a slot as wide as the *wider* of its hanzi and its pinyin, so
a long romanisation over one character (装 -> zhuāng) cannot overrun its
neighbours. Rows are centred, the block is bottom-aligned — the English sits
the same distance off the bottom edge in every cue, and a taller cue grows
upward — and every element gets an absolute position, so nothing can collide
however long the line.

The preview and the ASS writer both come through here, which is what makes the
preview trustworthy: there is no second implementation to drift from.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .chinese import tokenize, word_pinyin
from .measure import measure
from .style import Style

# Punctuation closes up against the word before it; a speaker dash against the
# word after it. Given a full word gap on both sides a comma floats in the
# middle of nowhere — 等等 ， 等等 — and reads as its own word.
PUNCTUATION = set(",.!?，。！？、;:；：…()（）\"'“”‘’")
DASHES = {"-", "—", "–"}

# Which layers each output file shows.
VARIANTS = {
    "combined": (True, True),     # pinyin + hanzi + English
    "chinese": (True, False),     # pinyin + hanzi
    "english": (False, True),     # English only
}
# "combined" takes the bare <video>.ass, which players treat as the default
# track; the others carry language tags that media servers read as labels.
SUFFIX = {"combined": "", "chinese": ".zh-CN", "english": ".en"}


@dataclass
class Token:
    hanzi: str
    pinyin: str
    width: float
    cx: float = 0.0       # centre, filled in when the row is placed

    @property
    def tight(self) -> bool:
        return bool(self.hanzi) and all(ch in PUNCTUATION for ch in self.hanzi)

    @property
    def leading(self) -> bool:
        return self.hanzi in DASHES


@dataclass
class Metrics:
    """The lengths a style works out to on one particular frame size."""
    W: int
    H: int
    zh: int
    py: int
    en: int
    limit: float
    gap: float
    ruby_gap: float
    row_gap: float
    block_gap: float
    pad: float
    ruby_h: float
    en_h: float

    @classmethod
    def of(cls, st: Style, meta: dict) -> "Metrics":
        W = int(meta.get("video_w") or 1280)
        H = int(meta.get("video_h") or 720)
        zh, py, en = round(st.zh_size * H), round(st.py_size * H), round(st.en_size * H)
        ruby_gap = st.ruby_gap * H
        return cls(W=W, H=H, zh=zh, py=py, en=en,
                   limit=st.max_width * W, gap=st.word_gap * H,
                   ruby_gap=ruby_gap, row_gap=st.row_gap * H,
                   block_gap=st.block_gap * H, pad=st.box_pad * H,
                   ruby_h=py * st.py_line + ruby_gap + zh * st.zh_line,
                   en_h=en * st.en_line)


@dataclass
class CueLayout:
    zh_rows: list[list[Token]]
    en_rows: list[str]
    block_h: float
    widest: float
    py_h: float           # height of the pinyin row and its gap; 0 when there is none
    ruby_h: float         # one row of pinyin over hanzi

    @property
    def empty(self) -> bool:
        return not self.zh_rows and not self.en_rows


@dataclass
class Placement:
    """Absolute pixel positions for one cue.

    `text` holds (layer, x, y, text) in the order the ASS events are written,
    layer being "PY", "ZH" or "EN".
    """
    boxes: list[tuple[float, float, float, float]] = field(default_factory=list)
    text: list[tuple[str, float, float, str]] = field(default_factory=list)

    def layer(self, name: str) -> list[tuple[float, float, str]]:
        return [(x, y, t) for (k, x, y, t) in self.text if k == name]


@dataclass
class Frame:
    """What one cue's placement needs to know about the whole episode."""
    steady: float
    box_x0: float
    box_x1: float


# ---------------------------------------------------------------- one cue

def tokens_for(text: str, st: Style, m: Metrics) -> list[Token]:
    out = []
    for word in tokenize(text):
        py = word_pinyin(word)
        out.append(Token(word, py, max(measure(word, st.zh_font, m.zh),
                                       measure(py, st.py_font, m.py))))
    return out


def gaps_for(row: list[Token], gap: float) -> list[float]:
    """The space to the left of each token in a row."""
    return [0.0 if i == 0 or tok.tight or row[i - 1].leading else gap
            for i, tok in enumerate(row)]


def wrap_tokens(tokens: list[Token], limit: float, gap: float,
                break_on_dash: bool) -> list[list[Token]]:
    rows: list[list[Token]] = [[]]
    used = 0.0
    for tok in tokens:
        starts_speaker = break_on_dash and tok.hanzi.startswith("-") and rows[-1]
        needed = tok.width + (gap if rows[-1] and not tok.tight else 0)
        # Punctuation never opens a row: a 。 stranded on a line of its own
        # reads as a mistake, and it is narrow enough to overhang the limit.
        overflows = rows[-1] and used + needed > limit and not tok.tight
        if starts_speaker or overflows:
            rows.append([])
            used = 0.0
            needed = tok.width
        rows[-1].append(tok)
        used += needed
    return [r for r in rows if r]


def place_row(row: list[Token], width: float, gap: float) -> None:
    lefts = gaps_for(row, gap)
    total = sum(t.width for t in row) + sum(lefts)
    x = (width - total) / 2
    for tok, left in zip(row, lefts):
        x += left
        tok.cx = x + tok.width / 2
        x += tok.width


def split_speakers(text: str) -> list[str]:
    """"-one thing -another" -> a row per speaker, to line up with the Chinese."""
    parts = re.split(r"\s+(?=[-—–]\s*\S)", text.strip())
    return [p.strip() for p in parts if p.strip()] or [text]


def wrap_english(text: str, limit: float, font: str, size: float) -> list[str]:
    rows: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and measure(trial, font, size) > limit:
            rows.append(line)
            line = word
        else:
            line = trial
    if line:
        rows.append(line)
    return rows or [""]


def lay_out(hanzi: str, english: str, st: Style, m: Metrics,
            variant: str = "combined") -> CueLayout:
    show_zh, show_en = VARIANTS[variant]
    hanzi, english = (hanzi or "").strip(), (english or "").strip()

    zh_rows: list[list[Token]] = []
    if show_zh and hanzi:
        zh_rows = wrap_tokens(tokens_for(hanzi, st, m), m.limit, m.gap,
                              st.break_on_dash)
        for row in zh_rows:
            place_row(row, m.W, m.gap)

    en_rows: list[str] = []
    if show_en and english:
        parts = split_speakers(english) if st.break_on_dash else [english]
        for part in parts:
            en_rows += wrap_english(part, m.limit, st.en_font, m.en)

    # A line with no pinyin anywhere — English lyrics typed into the hanzi —
    # drops the empty pinyin row instead of leaving a gap above it.
    has_py = any(t.pinyin for row in zh_rows for t in row)
    py_h = m.py * st.py_line + m.ruby_gap if has_py else 0.0
    ruby_h = m.ruby_h if has_py else m.zh * st.zh_line
    zh_h = len(zh_rows) * ruby_h + max(len(zh_rows) - 1, 0) * m.row_gap
    en_h = len(en_rows) * m.en_h
    widest = 0.0
    for row in zh_rows:
        widest = max(widest, row[-1].cx + row[-1].width / 2
                     - (row[0].cx - row[0].width / 2))
    for text in en_rows:
        widest = max(widest, measure(text, st.en_font, m.en))
    return CueLayout(zh_rows, en_rows,
                     zh_h + (m.block_gap if zh_h and en_h else 0) + en_h, widest,
                     py_h, ruby_h)


# ---------------------------------------------------------------- episode

def frame_for(layouts: list[CueLayout], st: Style, m: Metrics, meta: dict) -> Frame:
    """The episode-wide parts of the backdrop: its steady height and its edges.

    The height is a high quantile rather than the tallest cue: the few cues
    carrying two speakers on two rows are twice the height of the rest, and
    letting those set it would cover a third of the picture all episode for
    the sake of three cues. They grow above the box instead.
    """
    heights = sorted(c.block_h for c in layouts)
    steady = heights[min(int(st.box_steady_pct * len(heights)),
                         len(heights) - 1)] if heights else 0.0

    if st.box_full_width:
        return Frame(steady, 0.0, float(m.W))
    band = meta.get("band") or {}
    ours = max((c.widest for c in layouts), default=0.0)
    hpad = st.box_hpad * m.W
    left = min((m.W - ours) / 2, float(band.get("text_left", m.W)))
    right = max((m.W + ours) / 2, float(band.get("text_right", 0)))
    return Frame(steady, max(left - hpad, 0.0), min(right + hpad, float(m.W)))


def place(c: CueLayout, st: Style, m: Metrics, frame: Frame, meta: dict) -> Placement:
    p = Placement()
    if c.empty:
        return p
    H = m.H
    y = H - st.bottom_margin * H - c.block_h
    box_w = frame.box_x1 - frame.box_x0

    if st.box_covers == "all":
        box_block_h = max(frame.steady, c.block_h) if st.box_steady else c.block_h
        box_top = H - st.bottom_margin * H - box_block_h - m.pad
        if st.cover_burned_in:
            band = meta.get("band") or {}
            box_top = min(box_top, band.get("text_top", band.get("y", H))
                          - st.cover_pad * H)
        box_top = max(box_top, 0)
        p.boxes.append((frame.box_x0, box_top, box_w, H - box_top))
    elif st.box_covers == "chinese" and c.zh_rows:
        zh_h = len(c.zh_rows) * c.ruby_h + (len(c.zh_rows) - 1) * m.row_gap
        p.boxes.append((frame.box_x0, y - m.pad, box_w, zh_h + 2 * m.pad))

    for row in c.zh_rows:
        py_y = y + m.py * st.py_line / 2
        # Summed term by term, not via py_h, so the floating-point rounding
        # matches the files an earlier renderer wrote.
        zh_y = (y + m.py * st.py_line + m.ruby_gap if c.py_h else y) + m.zh * st.zh_line / 2
        for tok in row:
            if tok.pinyin:
                p.text.append(("PY", tok.cx, py_y, tok.pinyin))
            p.text.append(("ZH", tok.cx, zh_y, tok.hanzi))
        y += c.ruby_h + m.row_gap

    if c.zh_rows and c.en_rows:
        y += m.block_gap - m.row_gap
    for text in c.en_rows:
        p.text.append(("EN", m.W / 2, y + m.en_h / 2, text))
        y += m.en_h
    return p
