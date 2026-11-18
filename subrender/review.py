"""What the review dashboard asks of the renderer, minus any file or network I/O.

The page (under Pyodide) answers the dashboard through these functions, and
so does a check run on a Mac with CoreText, which is how the two are kept in
agreement: hand in a transcript and a folder's recipe, and get back the same
positions, timings and transcript text either way.
"""

from __future__ import annotations

import json
import re

from . import config, timing
from .layout import Frame, Metrics, frame_for, lay_out, place
from .style import Style

# Keys parked on `meta` for the browser to echo back. The leading underscore
# keeps them out of the transcript on save.
RECIPE_KEY = "_render"     # the folder's style and timing settings
FRAME_KEY = "_frame"       # the episode-wide backdrop: steady height and edges


# --------------------------------------------------------------------------- #
# layout — the same calls subrender.ass.render makes, minus the string writing
# --------------------------------------------------------------------------- #

def recipe_blob(recipe: config.Recipe) -> dict:
    return {"style": recipe.style.as_dict(),
            "fix_overlaps": recipe.fix_overlaps,
            "extend_short_cues": recipe.extend_short_cues,
            "variants": recipe.variants,
            "config": str(recipe.path) if recipe.path else None}


def style_of(meta: dict) -> Style:
    return Style.from_dict((meta.get(RECIPE_KEY) or {}).get("style") or {})


def episode_frame(meta: dict, cues: list[dict]) -> dict:
    """The backdrop's steady height and edges, which depend on every cue."""
    st = style_of(meta)
    m = Metrics.of(st, meta)
    f = frame_for([lay_out(c.get("hanzi", ""), c.get("english", ""), st, m)
                   for c in cues], st, m, meta)
    return {"steady": f.steady, "x0": f.box_x0, "x1": f.box_x1}


def layouts_for(meta: dict, cues: list[dict]) -> list[dict]:
    """Absolute positions for each cue, in the video's own pixel space.

    Called for the whole episode on load and for one cue at a time as you
    type, so the episode-wide frame comes in on `meta` rather than being
    worked out from whichever cues happen to be in this request.
    """
    st = style_of(meta)
    m = Metrics.of(st, meta)
    fr = meta.get(FRAME_KEY) or episode_frame(meta, cues)
    frame = Frame(fr["steady"], fr["x0"], fr["x1"])
    out = []
    for c in cues:
        laid = lay_out(c.get("hanzi", ""), c.get("english", ""), st, m)
        p = place(laid, st, m, frame, meta)
        widest_zh = max((row[-1].cx + row[-1].width / 2 - (row[0].cx - row[0].width / 2)
                         for row in laid.zh_rows), default=0.0)
        out.append({
            "bands": [{"x": x, "y": y, "w": w, "h": h} for (x, y, w, h) in p.boxes],
            "zh": [{"x": x, "y": y, "t": t} for (x, y, t) in p.layer("ZH")],
            "py": [{"x": x, "y": y, "t": t} for (x, y, t) in p.layer("PY")],
            "en": [{"x": x, "y": y, "t": t} for (x, y, t) in p.layer("EN")],
            "zhRows": len(laid.zh_rows),
            "enLines": len(laid.en_rows),
            "pinyinLine": " ".join(t.pinyin for row in laid.zh_rows
                                   for t in row if t.pinyin),
            # How close the widest row came to the wrap limit. Near 1.0 means
            # the next character you type spills onto a second row.
            "fill": widest_zh / m.limit if m.limit else 0.0,
        })
    return out


def style_blob_for(meta: dict) -> dict:
    """What the browser needs to paint what `layouts_for` returns."""
    st = style_of(meta)
    m = Metrics.of(st, meta)

    def layer(font, size, colour, bold, outline, shadow):
        return {"font": font, "size": size, "colour": "#" + colour,
                "bold": bold, "outline": outline, "shadow": shadow}

    return {
        "videoW": m.W,
        "videoH": m.H,
        "box": {"colour": "#" + st.box_colour, "opacity": st.box_opacity},
        "zh": layer(st.zh_font, m.zh, st.zh_colour, False, st.zh_outline, st.zh_shadow),
        "py": layer(st.py_font, m.py, st.py_colour, False, st.py_outline, st.py_shadow),
        "en": layer(st.en_font, m.en, st.en_colour, st.en_bold, st.en_outline, st.en_shadow),
    }


def timings_for(meta: dict, cues: list[dict]) -> tuple[list[dict | None], list[str]]:
    """What the renderer will make of these timings.

    One entry per input cue — None where it would drop the cue — plus notes.
    A folder with its timing clean-up switched off gets every cue back as is.
    """
    r = meta.get(RECIPE_KEY) or {}
    kept, notes = timing.apply(cues, bool(r.get("fix_overlaps")),
                               bool(r.get("extend_short_cues")))
    out: list[dict | None] = [None] * len(cues)
    for c in kept:
        out[c["_i"]] = {"start": round(c["start"], 2), "end": round(c["end"], 2)}
    return out, notes


def doc_payload(doc: dict, recipe: config.Recipe) -> dict:
    """Everything the dashboard needs to open one transcript.

    The folder's style rides on `meta` so every relayout the browser asks for
    is drawn with it, and so does the backdrop's steady height, which depends
    on the whole episode while an as-you-type relayout only sees one cue.
    Saving strips both back off. Where the file and its video live is the
    caller's business, and the caller adds it.
    """
    cues = doc.get("cues") or []
    meta = {**(doc.get("meta") or {}), RECIPE_KEY: recipe_blob(recipe)}
    meta[FRAME_KEY] = episode_frame(meta, cues)
    timings, notes = timings_for(meta, cues)
    return {"meta": meta,
            "cues": cues,
            "layouts": layouts_for(meta, cues),
            "renderTimings": timings,
            "renderNotes": notes,
            "style": style_blob_for(meta)}


# --------------------------------------------------------------------------- #
# splitting a cue in two
# --------------------------------------------------------------------------- #

# Where a Chinese cue may legally be cut. The transcripts use a deliberate
# mix — halfwidth , and ?, fullwidth 。 and ！, ASCII ... for a pause — and
# the fullwidth variants are tolerated in case a cue predates that convention.
_ZH_BREAK = re.compile(r"(?:\.\.\.|[。！？!?，,、；;：:])+")
_EN_SENT = re.compile(r"(?<=[.!?])\s+")
_EN_WORD = re.compile(r"\s+")


def _cut_points(text: str, pattern: re.Pattern, drop_sep: bool) -> list[tuple[int, int]]:
    """Candidate cuts as (end of the first half, start of the second)."""
    out = []
    for m in pattern.finditer(text):
        a = m.start() if drop_sep else m.end()
        b = m.end()
        if 0 < a and b < len(text):
            out.append((a, b))
    return out


def _split_text(text: str, frac: float, cuts: list[tuple[int, int]]) -> tuple[str, str]:
    """Cut `text` near `frac` of the way through, preferring a real boundary."""
    if not text.strip():
        return "", ""
    n = len(text)
    if not cuts:
        # Nothing to break on, so fall back to proportion. For hanzi that is a
        # perfectly good guess; for English the caller has already offered word
        # boundaries, so this only happens on a single word.
        i = max(1, min(n - 1, round(frac * n)))
        return text[:i].strip(), text[i:].strip()
    a, b = min(cuts, key=lambda c: abs(c[0] - frac * n))
    return text[:a].strip(), text[b:].strip()


def split_cue_text(hanzi: str, english: str, frac: float) -> dict:
    """Divide a cue's text at roughly `frac` (0..1) of the way through it.

    Punctuation wins over proportion: a cue split at a comma or a full stop
    reads as two cues, one split mid-clause reads as a mistake. The timing
    split is exact (the caller uses the playhead); the text split is a first
    guess that the reviewer is expected to adjust.
    """
    frac = max(0.0, min(1.0, float(frac)))
    zh_a, zh_b = _split_text(hanzi or "", frac, _cut_points(hanzi or "", _ZH_BREAK, False))

    text = english or ""
    cuts = _cut_points(text, _EN_SENT, True) or _cut_points(text, _EN_WORD, True)
    en_a, en_b = _split_text(text, frac, cuts)

    return {"a": {"hanzi": zh_a, "english": en_a},
            "b": {"hanzi": zh_b, "english": en_b}}


# --------------------------------------------------------------------------- #
# the saved shape
# --------------------------------------------------------------------------- #

def strip_suffix(name: str) -> str:
    for suffix in (".translated.json", ".json"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def transcript_text(meta: dict, cues: list[dict]) -> tuple[str, int]:
    """The lean editable shape, the shape the transcribing pipelines wrote.

    Cues arrive already filtered and in order; `n` is assigned here so the
    numbering is always a clean 1..N no matter what was removed.

    A cue from the burned-in-subtitle pipeline also carries an `ocr` block — how many frames agreed on the
    reading, and what the ones that disagreed said instead. It is the only
    record of where the line came from and there is no way to recover it, so it
    is written straight back out, last, after the fields a human edits.
    """
    rows = []
    for i, c in enumerate(cues, 1):
        row = {
            "n": i,
            "start": round(float(c.get("start") or 0.0), 2),
            "end": round(float(c.get("end") or 0.0), 2),
            "pinyin": c.get("pinyin", ""),
            "hanzi": c.get("hanzi", ""),
            "english": c.get("english", ""),
        }
        if c.get("ocr"):
            row["ocr"] = c["ocr"]
        rows.append(row)
    # Anything parked on `meta` for the browser's benefit is its own business
    # and does not belong in the transcript.
    m = {k: v for k, v in (meta or {}).items() if not k.startswith("_")}
    m["editable"] = True
    return json.dumps({"meta": m, "cues": rows}, ensure_ascii=False, indent=2), len(rows)
