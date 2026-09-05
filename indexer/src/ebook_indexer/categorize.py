import re
from pathlib import Path

import yaml

from .models import Book

TECH = "Tech & Programming"
SECURITY = "Security & Hacking"
FICTION = "Fiction"
COMICS = "Comics"
TTRPG = "TTRPG"
CERT = "Certification"
OTHER = "Other/Lifestyle"

# Checked in order; first match wins. Certification before Security so
# "Ultimate Cybersecurity Career" stays Security but "Sybex ..." is Cert.
_BUNDLE_RULES = [
    (r"certif|sybex|comptia|get certified", CERT),
    (r"cthulhu|cyberpunk|delta green|paranoia|warhammer|dragonlance|masquerade|rpg|roleplay|worldbuilding|samurai rpg", TTRPG),
    (r"comic|critical role|blade runner|cosplay|roll for initiative", COMICS),
    (r"hack|security|cyber|red team", SECURITY),
    (r"python|devops|linux|software|cloud|web develop|front end|raspberry|architecture|claude|project management|cicd|programmers", TECH),
    (r"wheel of time|enders game|dune|doctorow|valdemar|black company|lovecraft|gutenberg", FICTION),
]

_SUBJECT_RULES = [
    (r"comic|graphic novel", COMICS),
    (r"security|hacking", SECURITY),
    (r"fiction|fantasy|science fiction|novel|horror|short stories", FICTION),
    (r"computer|programming|software|internet", TECH),
    (r"role.?playing|games", TTRPG),
    (r"certification|study guide", CERT),
]


def derive_category(bundle: str, subjects: list[str],
                    fmt_types: list[str], archive_kind: str | None) -> str:
    b = bundle.lower()
    for pattern, cat in _BUNDLE_RULES:
        if re.search(pattern, b):
            return cat
    subj = " ".join(subjects).lower()
    if subj:
        for pattern, cat in _SUBJECT_RULES:
            if re.search(pattern, subj):
                return cat
    if "cbz" in fmt_types or archive_kind == "comic":
        return COMICS
    return OTHER


def load_overrides(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


_OVERRIDABLE = {"category", "title", "authors", "year", "publisher", "description"}
BUILTIN_CATEGORIES = frozenset({TECH, SECURITY, FICTION, COMICS, TTRPG, CERT, OTHER})


def valid_categories(overrides: dict) -> set[str]:
    """Built-in categories plus the top-level ``categories:`` list in overrides.yaml.

    scripts/pull-edits.py maintains that list from the site's category table, so
    categories people created through the site survive a re-index.
    """
    extra = overrides.get("categories") or []
    return set(BUILTIN_CATEGORIES) | {str(c) for c in extra}


def apply_overrides(book: Book, overrides: dict) -> None:
    valid = valid_categories(overrides)
    for field_name, value in (overrides.get(book.id) or {}).items():
        if field_name not in _OVERRIDABLE:
            continue
        if field_name == "category" and value not in valid:
            continue  # not a known category string; keep the derived category
        if field_name == "authors" and isinstance(value, str):
            value = [value]
        setattr(book, field_name, value)
