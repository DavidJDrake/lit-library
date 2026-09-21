"""Groups copies into editions and editions into works.

See docs/superpowers/specs/2026-09-14-works-and-editions-design.md. A copy is one
catalog entry; an edition is copies that are the same book; a work is editions that
are the same title by the same author, shown as one card.
"""
import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

from .categorize import valid_categories
from .models import Book

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


@dataclass(frozen=True)
class CopyRecord:
    id: str
    bundle: str
    title: str
    authors: tuple[str, ...]
    formats: frozenset[str]
    file_hashes: frozenset[str]
    isbn: str | None
    added_at: str


@dataclass(frozen=True)
class Link:
    a: str
    b: str
    rule: str


@dataclass
class Grouping:
    edition_id: dict[str, str]
    work_id: dict[str, str]
    links: list[Link]
    managed: frozenset[str]
    warnings: list[str]
    # Edition id -> sorted ids of every other edition linked by title and author, ignoring
    # overrides. Editions with no such link are absent. The site groups over these.
    work_links: dict[str, list[str]] = field(default_factory=dict)


class _UnionFind:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.parent[ra] = rb
        return True


def _earliest(ids, added_at: dict[str, str]) -> str:
    return min(ids, key=lambda i: (added_at[i], i))


def group_copies(copies: list[CopyRecord], work_overrides: dict[str, str] | None = None) -> Grouping:
    work_overrides = work_overrides or {}
    ids = [c.id for c in copies]
    added_at = {c.id: c.added_at for c in copies}
    links: list[Link] = []
    warnings: list[str] = []

    # Editions: identical bytes, a shared ISBN, or one bundle's formats of a title.
    editions_uf = _UnionFind(ids)
    by_hash: dict[str, list[str]] = defaultdict(list)
    by_isbn: dict[str, list[str]] = defaultdict(list)
    by_bundle_title: dict[tuple[str, str], list[CopyRecord]] = defaultdict(list)
    for c in copies:
        for h in c.file_hashes:
            by_hash[h].append(c.id)
        isbn = normalize_isbn(c.isbn)
        if isbn:
            by_isbn[isbn].append(c.id)
        by_bundle_title[(c.bundle, edition_title_key(c.title))].append(c)
    for rule, buckets in (("identical file", by_hash), ("isbn", by_isbn)):
        for members in buckets.values():
            for other in members[1:]:
                if editions_uf.union(members[0], other):
                    links.append(Link(members[0], other, rule))
    for members in by_bundle_title.values():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if not (a.formats & b.formats) and editions_uf.union(a.id, b.id):
                    links.append(Link(a.id, b.id, "bundle formats"))

    edition_members: dict[str, list[str]] = defaultdict(list)
    for cid in ids:
        edition_members[editions_uf.find(cid)].append(cid)
    edition_id: dict[str, str] = {}
    for members in edition_members.values():
        canonical = _earliest(members, added_at)
        for m in members:
            edition_id[m] = canonical
    editions = sorted(set(edition_id.values()), key=lambda e: (added_at[e], e))

    # Managed editions: an override on any copy applies to that copy's edition. When several
    # apply to one edition, the key that is the edition id wins, otherwise the smallest key.
    managed: dict[str, str] = {}
    chosen_key: dict[str, str] = {}
    for key in sorted(work_overrides):
        if key not in edition_id:
            warnings.append(f"work override on unknown id {key}; ignored")
            continue
        e = edition_id[key]
        if e not in chosen_key or key == e:
            chosen_key[e] = key
            managed[e] = work_overrides[key]

    # Works: same edition-insensitive title plus a shared author, skipping managed editions.
    works_uf = _UnionFind(editions)
    titles: dict[str, set[str]] = defaultdict(set)
    authors: dict[str, set[str]] = defaultdict(set)
    for c in copies:
        e = edition_id[c.id]
        titles[e].add(edition_title_key(c.title))
        authors[e] |= author_keys(c.authors)
    by_title: dict[str, list[str]] = defaultdict(list)
    for e in editions:
        for t in titles[e]:
            if t:
                by_title[t].append(e)
    work_links: dict[str, set[str]] = defaultdict(set)
    for members in by_title.values():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if not authors[a] & authors[b]:
                    continue
                work_links[a].add(b)
                work_links[b].add(a)
                if a not in managed and b not in managed and works_uf.union(a, b):
                    links.append(Link(a, b, "title and author"))
    for e, target in managed.items():
        if target == e:
            continue
        if target not in edition_id:
            warnings.append(f"work override on {e} names unknown id {target}; the edition stays its own work")
            continue
        if works_uf.union(e, edition_id[target]):
            links.append(Link(e, edition_id[target], "work override"))

    work_members: dict[str, list[str]] = defaultdict(list)
    for e in editions:
        work_members[works_uf.find(e)].append(e)
    work_of_edition: dict[str, str] = {}
    for members in work_members.values():
        canonical = _earliest(members, added_at)
        for m in members:
            work_of_edition[m] = canonical
    work_id = {cid: work_of_edition[edition_id[cid]] for cid in ids}
    return Grouping(edition_id, work_id, links, frozenset(managed), warnings,
                    {e: sorted(linked) for e, linked in sorted(work_links.items())})


def display_edition(edition_ids: Iterable[str], canonical: dict[str, Book]) -> str:
    # Stable sorts, applied last-priority first: smallest id, then latest added, then highest year.
    ordered = sorted(set(edition_ids))
    ordered.sort(key=lambda e: canonical[e].added_at, reverse=True)
    ordered.sort(key=lambda e: canonical[e].year if canonical[e].year is not None else float("-inf"), reverse=True)
    return ordered[0]


@dataclass(frozen=True)
class CategoryChange:
    work_id: str
    before: frozenset[str]
    after: str


def settle_categories(books: list[Book], overrides: dict) -> list[CategoryChange]:
    """Give every copy of a work one category. Category is a shelf, which belongs to the work."""
    valid = valid_categories(overrides)
    by_work: dict[str, list[Book]] = defaultdict(list)
    for b in books:
        by_work[b.work_id].append(b)
    changes = []
    for work_id, members in by_work.items():
        before = frozenset(b.category for b in members)
        overridden = [b for b in members
                      if isinstance(overrides.get(b.id), dict) and overrides[b.id].get("category") in valid]
        if overridden:
            category = min(overridden, key=lambda b: (b.id != work_id, b.added_at, b.id)).category
        else:
            canonical = {b.edition_id: b for b in members if b.id == b.edition_id}
            category = canonical[display_edition(canonical, canonical)].category
        for b in members:
            b.category = category
        if len(before) > 1 or category not in before:
            changes.append(CategoryChange(work_id, before, category))
    return sorted(changes, key=lambda c: c.work_id)
