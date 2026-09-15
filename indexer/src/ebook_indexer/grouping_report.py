"""Renders out/grouping-report.md: a read-only preview of how copies group into cards."""
from collections import defaultdict

from .models import Book
from .works import CategoryChange, Grouping, author_keys, edition_title_key


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render_report(books: list[Book], grouping: Grouping, changes: list[CategoryChange]) -> str:
    by_id = {b.id: b for b in books}
    works: dict[str, list[Book]] = defaultdict(list)
    for b in books:
        works[b.work_id].append(b)
    rules: dict[str, set[str]] = defaultdict(set)
    for link in grouping.links:
        rules[link.a].add(link.rule)
        rules[link.b].add(link.rule)

    multi = sorted((m for m in works.values() if len(m) > 1), key=lambda m: by_id[m[0].work_id].title.lower())
    lines = [
        "# Grouping report", "",
        f"- Copies: {len(books)}",
        f"- Editions: {len({b.edition_id for b in books})}",
        f"- Works (cards): {len(works)}",
        f"- Cards grouping more than one copy: {len(multi)}",
        "",
        "## Cards that group more than one copy", "",
    ]
    if not multi:
        lines += ["None.", ""]
    for members in multi:
        lines += [f"### {_cell(by_id[members[0].work_id].title)} ({len(members)} copies)", "",
                  "| Copy | Title | Bundle | Authors | Year | Edition | Linked by |",
                  "|---|---|---|---|---|---|---|"]
        for b in sorted(members, key=lambda b: (b.edition_id, b.added_at, b.id)):
            lines.append(f"| `{b.id}` | {_cell(b.title)} | {_cell(b.bundle)} | {_cell(', '.join(b.authors))} | "
                         f"{b.year or ''} | `{b.edition_id}` | {', '.join(sorted(rules[b.id])) or '—'} |")
        lines.append("")

    lines += ["## Categories that settle", ""]
    if not changes:
        lines.append("None.")
    for c in changes:
        lines.append(f"- **{_cell(by_id[c.work_id].title)}** (`{c.work_id}`): "
                     f"{', '.join(sorted(c.before))} → {c.after}")
    lines.append("")

    lines += ["## Same titles kept apart", ""]
    canonical = [b for b in books if b.id == b.edition_id]
    by_title: dict[str, list[Book]] = defaultdict(list)
    for b in canonical:
        by_title[edition_title_key(b.title)].append(b)
    kept = 0
    for _key, editions in sorted(by_title.items()):
        if len({b.work_id for b in editions}) < 2:
            continue
        kept += 1
        if any(b.edition_id in grouping.managed for b in editions):
            reason = "an admin correction keeps them apart"
        elif any(not author_keys(b.authors) for b in editions):
            reason = "no authors to compare"
        else:
            reason = "no author in common"
        lines.append(f"- **{_cell(editions[0].title)}** — {reason}:")
        for b in sorted(editions, key=lambda b: b.work_id):
            lines.append(f"  - `{b.work_id}` {_cell(', '.join(b.authors)) or '(no authors)'} — {_cell(b.bundle)}")
    if not kept:
        lines.append("None.")
    lines.append("")
    return "\n".join(lines)
