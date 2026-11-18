"""Write the ASS file.

Every element is its own ``\\pos()``ed event — the backdrop on layer 0, each
pinyin group, each word and each English line on layer 1 — so libass does no
layout of its own and the file shows exactly what the preview showed.
"""

from __future__ import annotations

from .layout import Metrics, frame_for, lay_out, place
from .style import Style

HEADER = """\
[Script Info]
Title: {title}
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: {w}
PlayResY: {h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{zh}
{py}
{en}
Style: Box,{en_font},{en_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def bgr(rgb: str) -> str:
    """ASS colours are BGR, written back to front."""
    rgb = rgb.lstrip("#")
    return f"{rgb[4:6]}{rgb[2:4]}{rgb[0:2]}".upper()


def alpha(opacity: float) -> str:
    return f"&H{max(0, min(255, round((1 - opacity) * 255))):02X}&"


def timestamp(seconds: float) -> str:
    seconds = max(seconds, 0.0)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def escape(text: str) -> str:
    """Neutralise the characters libass would read as markup."""
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def _num(x: float) -> str:
    return "0" if not x else f"{x:.2f}"


def _style_line(name: str, font: str, size: int, colour: str, bold: bool,
                outline: float, shadow: float) -> str:
    c = bgr(colour)
    # The shadow is drawn in BackColour: half-transparent black reads as a
    # shadow, solid black as a smudge.
    back = "&H80000000" if shadow else "&H00000000"
    return (f"Style: {name},{font},{size},&H00{c},&H00{c},&H00000000,{back},"
            f"{-1 if bold else 0},0,0,0,100,100,0,0,1,"
            f"{_num(outline * size)},{_num(shadow * size)},5,0,0,0,1")


def render(cues: list[dict], meta: dict, st: Style, *, variant: str = "combined",
           title: str = "") -> str:
    """The ASS text for one variant. `cues` are already timing-adjusted."""
    m = Metrics.of(st, meta)
    lines = [HEADER.format(
        title=title or meta.get("source", "subreview"), w=m.W, h=m.H,
        zh=_style_line("ZH", st.zh_font, m.zh, st.zh_colour, False,
                       st.zh_outline, st.zh_shadow),
        py=_style_line("PY", st.py_font, m.py, st.py_colour, False,
                       st.py_outline, st.py_shadow),
        en=_style_line("EN", st.en_font, m.en, st.en_colour, st.en_bold,
                       st.en_outline, st.en_shadow),
        en_font=st.en_font, en_size=m.en)]

    layouts = [lay_out(c.get("hanzi", ""), c.get("english", ""), st, m, variant)
               for c in cues]
    frame = frame_for(layouts, st, m, meta)

    box_fill = f"\\1c&H{bgr(st.box_colour)}&\\1a{alpha(st.box_opacity)}"
    for cue, laid in zip(cues, layouts):
        if laid.empty:
            continue
        start, end = timestamp(cue["start"]), timestamp(cue["end"])
        p = place(laid, st, m, frame, meta)
        for (x, y, w, h) in p.boxes:
            lines.append(
                f"Dialogue: 0,{start},{end},Box,,0,0,0,,"
                f"{{\\an7\\pos({x:.0f},{y:.0f})\\bord0\\shad0{box_fill}\\p1}}"
                f"m 0 0 l {w:.0f} 0 l {w:.0f} {h:.0f} l 0 {h:.0f}")
        for (layer, x, y, text) in p.text:
            lines.append(
                f"Dialogue: 1,{start},{end},{layer},,0,0,0,,"
                f"{{\\an5\\pos({x:.1f},{y:.1f})}}{escape(text)}")

    return "\n".join(lines) + "\n"
