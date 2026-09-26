#!/usr/bin/env python3
"""Preview what enrichment would change, without publishing anything.

Builds the catalogue in memory with enrichment enabled -- writing neither
added.json, covers/, nor out/, and never touching AWS -- then compares each
book against the currently published catalogue and writes a review file:
every book whose title, authors, year, publisher, subjects or description
would change, old value vs new, grouped by field so a human can skim it
before anyone runs `index` for real.

Usage: scripts/preview-enrichment.py --config config.yaml [--limit N] [--offline]
                                     [--catalog out/catalog.json] [--report FILE]

  --offline  cache-only: no network calls at all (Enricher(offline=True))
  --catalog  published catalog.json to diff against (default: out/catalog.json
             in the main checkout, found via `git rev-parse --git-common-dir`
             so this works the same from a worktree)
  --report   where to write the review file (default: enrichment-preview.md
             next to --config)

Pass the Google Books key on the command line only -- never in a file:
  GOOGLE_BOOKS_API_KEY=$(cat ~/.config/ebook-share/google-books-api-key) \\
    scripts/preview-enrichment.py --config config.yaml --limit 40
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "indexer" / "src"))
from ebook_indexer.config import load_config  # noqa: E402
from ebook_indexer.enrich import Enricher  # noqa: E402
from ebook_indexer.pipeline import build_books  # noqa: E402

FIELDS = ("title", "authors", "year", "publisher", "subjects", "description")


def _main_checkout_catalog() -> Path | None:
    """out/catalog.json in the main checkout, located via git so the default
    works the same whether this runs from the main checkout or a worktree."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    common_dir = result.stdout.strip()
    if not common_dir:
        return None
    return Path(common_dir).parent / "out" / "catalog.json"


def load_catalog(path: Path) -> dict[str, dict]:
    """id -> catalog entry, read from a published catalog.json. Missing or
    unreadable is treated as an empty catalogue -- every book then shows up
    as 'not yet catalogued' rather than the run failing."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    books = data.get("books") if isinstance(data, dict) else None
    if not isinstance(books, list):
        return {}
    return {b["id"]: b for b in books if isinstance(b, dict) and "id" in b}


def _list_value(value) -> list:
    return list(value) if value else []


def _book_value(book, field: str):
    if field in ("authors", "subjects"):
        return _list_value(getattr(book, field))
    return getattr(book, field)


def _old_value(entry: dict, field: str):
    if field in ("authors", "subjects"):
        return _list_value(entry.get(field))
    return entry.get(field)


def diff_books(books, old_by_id: dict[str, dict]) -> tuple[dict[str, list], list]:
    """Field -> [(id, title, old, new), ...] for books enrichment would change,
    plus the list of books absent from the published catalogue entirely.

    Only reports a change when the new value is non-empty: enrichment fills
    gaps, it never clears a field, so a "change" to empty would only mean
    the comparison itself is broken, not a real enrichment effect.
    """
    changes: dict[str, list] = {field: [] for field in FIELDS}
    new_books = []
    for book in books:
        old = old_by_id.get(book.id)
        if old is None:
            new_books.append(book)
            continue
        for field in FIELDS:
            new_v = _book_value(book, field)
            old_v = _old_value(old, field)
            if new_v != old_v and new_v not in (None, [], ""):
                changes[field].append((book.id, book.title, old_v, new_v))
    return changes, new_books


def _cell(value) -> str:
    if isinstance(value, list):
        text = ", ".join(str(v) for v in value) if value else "(none)"
    elif value in (None, ""):
        text = "(none)"
    else:
        text = str(value)
    text = text.replace("|", "\\|").replace("\n", " ")
    return text[:160].rstrip() + "\u2026" if len(text) > 160 else text


def render_report(changes: dict[str, list], new_books: list, total: int) -> str:
    changed_ids = {bid for rows in changes.values() for bid, *_ in rows}
    lines = [
        "# Enrichment preview", "",
        f"- Books compared: {total}",
        f"- Books with at least one field that would change: {len(changed_ids)}",
        f"- Not yet in the published catalog: {len(new_books)}", "",
    ]
    for field in FIELDS:
        rows = changes[field]
        lines.append(f"## {field.capitalize()} ({len(rows)})")
        lines.append("")
        if not rows:
            lines += ["None.", ""]
            continue
        lines += ["| Book | Old | New |", "|---|---|---|"]
        for bid, title, old, new in rows:
            lines.append(f"| {_cell(title)} (`{bid}`) | {_cell(old)} | {_cell(new)} |")
        lines.append("")
    lines.append(f"## Not yet in the published catalog ({len(new_books)})")
    lines.append("")
    if not new_books:
        lines += ["None.", ""]
    else:
        for b in new_books:
            lines.append(
                f"- {_cell(b.title)} (`{b.id}`) -- authors: {_cell(b.authors)}, "
                f"year: {_cell(b.year)}, publisher: {_cell(b.publisher)}"
            )
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--offline", action="store_true",
                     help="cache-only: no network calls, no cache writes")
    ap.add_argument("--catalog", type=Path, default=None,
                     help="published catalog.json to diff against (default: out/catalog.json "
                          "in the main checkout)")
    ap.add_argument("--report", type=Path, default=None,
                     help="where to write the review file (default: enrichment-preview.md "
                          "next to --config)")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    catalog_path = args.catalog or _main_checkout_catalog()
    if catalog_path is None:
        print("could not locate the main checkout's out/catalog.json; pass --catalog", file=sys.stderr)
        return 2
    old_by_id = load_catalog(catalog_path)
    if not old_by_id:
        print(f"warning: no books read from {catalog_path}; every book will show as "
              "'not yet catalogued'", file=sys.stderr)

    enricher = Enricher(
        cfg.metadata_dir / "cache",
        google_books_api_key=os.environ.get("GOOGLE_BOOKS_API_KEY") or None,
        offline=args.offline,
    )
    books, _covers = build_books(
        root=cfg.library_root,
        overrides_path=cfg.metadata_dir / "overrides.yaml",
        added_path=cfg.metadata_dir / "added.json",
        enricher=enricher,
        limit=args.limit,
        hash_cache_path=cfg.metadata_dir / "hashes.json",
        write_added=False,
        with_covers=False,
    )

    changes, new_books = diff_books(books, old_by_id)
    report_path = args.report or (args.config.resolve().parent / "enrichment-preview.md")
    report_path.write_text(render_report(changes, new_books, len(books)))
    changed = len({bid for rows in changes.values() for bid, *_ in rows})
    print(f"{len(books)} books compared against {catalog_path}; {changed} would change "
          f"({len(new_books)} not yet catalogued); wrote {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
