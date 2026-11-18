"""Optional timing clean-up applied at render time, off unless a folder asks.

Both rules are for transcripts whose cue boundaries came from a voice detector:
`fix_overlaps` keeps two cues from being on screen at once, and
`extend_short_cues` holds a too-brief cue longer so it can be read. A folder
whose timings were set by hand turns them off and gets exactly what it wrote.

Each works on copies and returns notes describing what it changed, so the
dashboard can show them before you generate.
"""

from __future__ import annotations

from .chinese import CJK


def fix_overlaps(cues: list[dict], min_dur: float = 0.25) -> tuple[list[dict], list[str]]:
    """Trim an end that laps the next cue; drop an overlapping exact duplicate.

    Returns the surviving cues (copies, carrying `_i`, their index in the
    input) and the notes. A cue whose end precedes its start is given
    `min_dur`, since libass silently declines to draw such an event.
    """
    out: list[dict] = []
    notes: list[str] = []
    for i, src in enumerate(cues):
        c = {**src, "_i": i,
             "start": float(src.get("start") or 0.0),
             "end": float(src.get("end") or 0.0)}
        hz = (c.get("hanzi") or "").strip()
        if c["end"] <= c["start"]:
            notes.append(f"cue at {c['start']:.2f}s ended before it started "
                         f"({c['end']:.2f}s); gave it {min_dur:.2f}s: {hz[:24]}")
            c["end"] = c["start"] + min_dur
        if out:
            prev = out[-1]
            if c["start"] < prev["end"]:
                if hz == (prev.get("hanzi") or "").strip():
                    notes.append(f"dropped duplicate cue at {c['start']:.2f}s: {hz[:24]}")
                    prev["end"] = max(prev["end"], c["end"])
                    continue
                if c["start"] < prev["start"]:
                    notes.append(f"cue at {c['start']:.2f}s starts before the cue "
                                 f"it follows ({prev['start']:.2f}s); moved it to "
                                 f"{prev['end']:.2f}s -- CHECK THIS TIMING: {hz[:24]}")
                    c["start"] = prev["end"]
                    if c["end"] - c["start"] < min_dur:
                        c["end"] = c["start"] + min_dur
                    out.append(c)
                    continue
                notes.append(f"trimmed {prev['end']:.2f}s -> {c['start']:.2f}s so it "
                             f"stops before the next cue")
                prev["end"] = c["start"]
                if prev["end"] - prev["start"] < min_dur:
                    prev["end"] = prev["start"] + min_dur
        out.append(c)
    return out, notes


# Reading rates: conservative, since this is children's programming being used
# to study a second language.
CPS_EN = 17.0            # English characters per second
SEC_PER_HANZI = 0.30
READ_BASE = 0.40         # fixed cost of noticing a new line at all
READ_FLOOR = 1.00
READ_CEIL = 7.00


def reading_time(cue: dict) -> float:
    need_zh = READ_BASE + SEC_PER_HANZI * len(CJK.findall(cue.get("hanzi") or ""))
    need_en = READ_BASE + len(cue.get("english") or "") / CPS_EN
    return min(max(need_zh, need_en, READ_FLOOR), READ_CEIL)


def extend_short_cues(cues: list[dict], min_gap: float = 0.08) -> tuple[list[dict], list[str]]:
    """Hold a too-brief cue longer, but only into the silence after it.

    Only ever moves an end later, and never closer than `min_gap` to the next
    cue's start, so it cannot overlap its neighbour. Mutates the cues it is
    given, which are expected to be fix_overlaps' copies.
    """
    grown, total = 0, 0.0
    for i, c in enumerate(cues):
        need = reading_time(c)
        if c["end"] - c["start"] >= need:
            continue
        limit = cues[i + 1]["start"] - min_gap if i + 1 < len(cues) else c["start"] + need
        new_end = min(c["start"] + need, limit)
        if new_end > c["end"] + 1e-6:
            total += new_end - c["end"]
            c["end"] = round(new_end, 2)
            grown += 1
    notes = [f"held {grown} short cues longer (+{total:.1f}s total) so they can be read"] if grown else []
    return cues, notes


def apply(cues: list[dict], fix: bool, extend: bool) -> tuple[list[dict], list[str]]:
    """The cues as they will be rendered, each carrying `_i`, plus notes."""
    if not fix and not extend:
        return [{**c, "_i": i} for i, c in enumerate(cues)], []
    if fix:
        out, notes = fix_overlaps(cues)
    else:
        out = [{**c, "_i": i, "start": float(c.get("start") or 0.0),
                "end": float(c.get("end") or 0.0)} for i, c in enumerate(cues)]
        notes = []
    if extend:
        out, more = extend_short_cues(out)
        notes += more
    return out, notes
