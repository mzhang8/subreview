"""The browser build's way into subrender, under Pyodide.

Strings in, JSON strings out: the page hands over file contents it fetched
from Google Drive and gets back the layouts, timings, transcript text and
ASS files that subrender.review and subrender.config make of them.
"""

from __future__ import annotations

import json

from subrender import chinese, config, review


def warm() -> None:
    """Load jieba's dictionary and pypinyin's tables now, not on first keystroke."""
    chinese.line_pinyin("预热一下")


def _recipe(config_text: str | None, config_name: str | None) -> config.Recipe:
    raw = json.loads(config_text) if config_text else {}
    return config.parse(raw, config_name)


def _out(payload) -> str:
    return json.dumps(payload, ensure_ascii=False)


def doc(doc_text: str, config_text: str | None, config_name: str | None) -> str:
    return _out(review.doc_payload(json.loads(doc_text), _recipe(config_text, config_name)))


def layout(body: str) -> str:
    b = json.loads(body)
    return _out({"layouts": review.layouts_for(b.get("meta") or {}, b.get("cues") or [])})


def timings(body: str) -> str:
    b = json.loads(body)
    t, notes = review.timings_for(b.get("meta") or {}, b.get("cues") or [])
    return _out({"renderTimings": t, "renderNotes": notes})


def split(body: str) -> str:
    b = json.loads(body)
    return _out(review.split_cue_text(b.get("hanzi", ""), b.get("english", ""),
                                      b.get("frac", 0.5)))


def transcript(body: str) -> str:
    b = json.loads(body)
    text, count = review.transcript_text(b.get("meta") or {}, b.get("cues") or [])
    return _out({"text": text, "cues": count})


def render(doc_text: str, config_text: str | None, config_name: str | None,
           stem: str) -> str:
    notes, files = config.render_all(json.loads(doc_text),
                                     _recipe(config_text, config_name), stem)
    return _out({"notes": notes, "files": files})
