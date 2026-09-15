"""Groups copies into editions and editions into works.

See docs/superpowers/specs/2026-09-14-works-and-editions-design.md. A copy is one
catalog entry; an edition is copies that are the same book; a work is editions that
are the same title by the same author, shown as one card.
"""
import re
from collections.abc import Iterable

# Only explicit edition markers. Subtitles are deliberately never removed: stripping
# text after a colon merged six different Dune novels into one work.
_ORDINAL = r"\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth"
_EDITION_MARKERS = re.compile(
    r"\([^)]*\bedition\b[^)]*\)"
    rf"|\b(?:{_ORDINAL}|revised|updated|expanded)\s+edition\b"
    r"|\bedition\s+\d+\b"
    r"|\b\d+(?:st|nd|rd|th)\s+ed\b\.?",
    re.IGNORECASE,
)


def normalize_isbn(raw: str | None) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"[^0-9X]", "", raw.upper())
    if len(digits) == 13 and digits.isdigit() and digits.startswith(("978", "979")):
        return digits
    if len(digits) == 10 and digits[:9].isdigit():
        core = "978" + digits[:9]
        total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core))
        return core + str((10 - total % 10) % 10)
    return None


def edition_title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]", "", _EDITION_MARKERS.sub(" ", title.lower()))


def author_keys(authors: Iterable[str]) -> frozenset[str]:
    keys = set()
    for raw in authors:
        for part in re.split(r"\band\b|&|;|\||\n", raw, flags=re.IGNORECASE):
            part = part.strip()
            if part.count(",") == 1:
                last, first = (s.strip() for s in part.split(","))
                part = f"{first} {last}"
            key = re.sub(r"[^a-z]", "", part.lower())
            if key:
                keys.add(key)
    return frozenset(keys)
