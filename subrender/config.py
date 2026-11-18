"""A folder's subreview.json, and writing the .ass files it describes.

subreview looks for subreview.json beside the transcript and then in each
parent up to the folder it was started on, so a ``reviewed/`` subfolder
inherits its show's settings:

    {
      "variants": ["combined", "chinese", "english"],
      "timing": {"fix_overlaps": true, "extend_short_cues": false},
      "style": { ...any field of subrender.style.Style... }
    }

A folder without one renders the combined track with the default style and
leaves timings alone.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from . import ass, timing
from .layout import SUFFIX, VARIANTS
from .style import Style

CONFIG_NAME = "subreview.json"
KNOWN = {"variants", "timing", "style"}


@dataclass
class Recipe:
    style: Style
    variants: list[str]
    fix_overlaps: bool
    extend_short_cues: bool
    path: Path | str | None

    def timed(self, cues: list[dict]) -> tuple[list[dict], list[str]]:
        return timing.apply(cues, self.fix_overlaps, self.extend_short_cues)


def find(json_path: Path, root: Path) -> Path | None:
    """The nearest subreview.json at or above the transcript, stopping at root."""
    root = root.resolve()
    here = json_path.resolve().parent
    while True:
        candidate = here / CONFIG_NAME
        if candidate.is_file():
            return candidate
        if here == root or root not in here.parents:
            return None
        here = here.parent


def load(json_path: Path, root: Path) -> Recipe:
    path = find(json_path, root)
    raw = json.loads(path.read_text(encoding="utf-8")) if path else {}
    return parse(raw, path)


def parse(raw: dict, path: Path | str | None) -> Recipe:
    """A subreview.json's contents as a Recipe; `path` names it in errors.

    Split from `load` so the browser build, which reads the file from Google
    Drive rather than disk, goes through the same checks.
    """
    try:
        unknown = sorted(set(raw) - KNOWN)
        if unknown:
            raise ValueError(f"unknown setting(s): {', '.join(unknown)}")
        variants = raw.get("variants") or ["combined"]
        bad = [v for v in variants if v not in VARIANTS]
        if bad:
            raise ValueError(f"unknown variant(s) {bad}; choose from {list(VARIANTS)}")
        t = raw.get("timing") or {}
        return Recipe(style=Style.from_dict(raw.get("style") or {}),
                      variants=variants,
                      fix_overlaps=bool(t.get("fix_overlaps", False)),
                      extend_short_cues=bool(t.get("extend_short_cues", False)),
                      path=path)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{path}: {exc}") from None


def stem_of(json_path: Path) -> str:
    name = json_path.name
    for ext in (".translated.json", ".json"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def _install(text: str, target: Path, backups: Path) -> str:
    """Swap `text` into place at `target`, keeping the file it replaces."""
    if target.exists():
        if target.read_text(encoding="utf-8") == text:
            return f"unchanged  {target}"
        backups.mkdir(parents=True, exist_ok=True)
        backup = backups / f"{target.stem}.{time.strftime('%Y%m%d-%H%M%S')}.ass"
        if not backup.exists():
            backup.write_bytes(target.read_bytes())
    # Written beside the target and swapped in, so an interrupted write cannot
    # leave a half-written subtitle where a player expects a whole one.
    tmp = target.with_suffix(".ass.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)
    return f"wrote      {target}"


def render_all(doc: dict, recipe: Recipe, stem: str) -> tuple[list[str], list[tuple[str, str]]]:
    """Every variant the recipe asks for, as (file name, ASS text), plus the
    timing notes. Writes nothing."""
    meta = doc.get("meta") or {}
    cues, notes = recipe.timed(doc.get("cues") or [])
    files = [(f"{stem}{SUFFIX[variant]}.ass",
              ass.render(cues, meta, recipe.style, variant=variant, title=stem))
             for variant in recipe.variants]
    return notes, files


def generate(json_path: Path, recipe: Recipe) -> list[str]:
    """Render every variant into the transcript's own folder. Returns a log.

    Only ever that folder: the .ass files live beside the .translated.json
    they were rendered from, and nothing is written anywhere else.
    """
    doc = json.loads(json_path.read_text(encoding="utf-8"))
    notes, files = render_all(doc, recipe, stem_of(json_path))
    folder = json_path.parent

    log = [f"timing: {n}" for n in notes]
    for name, text in files:
        log.append(_install(text, folder / name, folder / "backups"))
    return log
