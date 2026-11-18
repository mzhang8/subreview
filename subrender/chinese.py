"""Word segmentation and pinyin.

The hanzi is rendered exactly as the transcript has it. jieba decides where the
words fall — which matters, because 银行 is yínháng but character by character
it would be yín xíng — and a space you type into the hanzi forces a break there.
Pinyin is always derived from the hanzi, never read from the file.
"""

from __future__ import annotations

import re
import threading
from functools import lru_cache

CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")

# jieba's tokenizer is not reentrant. The page runs on one thread, so this
# only matters to a caller that lays out cues on several at once.
LOCK = threading.RLock()


def has_hanzi(s: str) -> bool:
    return bool(CJK.search(s))


@lru_cache(maxsize=1)
def _jieba():
    import jieba
    jieba.setLogLevel(60)
    jieba.initialize()
    return jieba


def tokenize(text: str) -> list[str]:
    with LOCK:
        return [t for t in _jieba().lcut(text, HMM=True) if t.strip()]


def word_pinyin(word: str) -> str:
    """Tone-marked pinyin for one token; empty for a token with no hanzi."""
    if not has_hanzi(word):
        return ""
    from pypinyin import Style, pinyin
    with LOCK:
        return "".join(s[0] for s in pinyin(word, style=Style.TONE,
                                            errors="ignore", heteronym=False))


def line_pinyin(text: str) -> str:
    """Space-separated pinyin for a whole cue, one group per word."""
    return " ".join(p for p in (word_pinyin(t) for t in tokenize(text)) if p)
