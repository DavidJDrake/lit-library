#!/usr/bin/env python3
"""Fold the site's category edits back into metadata/overrides.yaml.

The site stores category changes and site-created categories in the DynamoDB
library table (see docs/superpowers/specs/2026-09-04-user-categories-design.md).
This script copies them into overrides.yaml so the repo's metadata stays a
faithful backup and the next index/publish converges on what people chose.
It updates only the entries that changed, so comments, section notes and
entry order in overrides.yaml survive. Admin work corrections become
`work:` keys, and a `work:` key with no correction row is removed, so
corrections belong in the app, not in the file.

Usage: scripts/pull-edits.py [--config config.yaml] [--input scan.json] [--dry-run]
  --input   read a DynamoDB typed scan (aws dynamodb scan --output json) instead of AWS
  --dry-run print what would change without writing
"""
import argparse
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "indexer" / "src"))
from ebook_indexer.categorize import BUILTIN_CATEGORIES  # noqa: E402
from ebook_indexer.config import load_config  # noqa: E402


def _plain(attr: dict):
    """Unwrap one DynamoDB typed attribute ({"S": "x"} -> "x"); strings are all we store."""
    if "S" in attr:
        return attr["S"]
    if "N" in attr:
        return attr["N"]
    if "BOOL" in attr:
        return attr["BOOL"]
    return None


def load_items(args, cfg) -> list[dict]:
    if args.input:
        raw = json.loads(Path(args.input).read_text())["Items"]
    else:
        import boto3  # only needed when talking to AWS
        client = boto3.client("dynamodb", region_name=cfg.aws_region)
        raw, kwargs = [], {"TableName": cfg.library_table}
        while True:
            page = client.scan(**kwargs)
            raw.extend(page["Items"])
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return [{k: _plain(v) for k, v in item.items()} for item in raw]


_TOP_KEY = re.compile(r"""^(?P<q>['"]?)(?P<key>[^\s'"#:][^:]*?)(?P=q):(?:[ \t]|$)""")


def _is_continuation(line: str) -> bool:
    return line[:1] in (" ", "\t") or line.startswith("- ")


def top_level_chunks(text: str) -> list[tuple[str | None, str]]:
    """Split overrides.yaml into ordered chunks: (key, text) for one top-level entry with its
    indented lines and list items, or (None, text) for what lies between entries — the header,
    blank lines, section comments. Blank lines followed by more of an entry belong to the
    entry, because a multi-line quoted value can contain them."""
    chunks: list[list] = []
    blanks: list[str] = []

    def gap(lines: list[str]) -> None:
        if chunks and chunks[-1][0] is None:
            chunks[-1][1] += "".join(lines)
        else:
            chunks.append([None, "".join(lines)])

    for line in text.splitlines(keepends=True):
        match = _TOP_KEY.match(line)
        if match and not line.startswith(("#", " ", "\t", "- ")):
            if blanks:
                gap(blanks)
                blanks = []
            chunks.append([match.group("key"), line])
        elif not line.strip():
            blanks.append(line)
        elif _is_continuation(line) and chunks and chunks[-1][0] is not None:
            chunks[-1][1] += "".join(blanks) + line
            blanks = []
        else:
            if blanks:
                gap(blanks)
                blanks = []
            gap([line])
    if blanks:
        gap(blanks)
    return [(key, body) for key, body in chunks]


def render_entry(key: str, value) -> str:
    return yaml.safe_dump({key: value}, allow_unicode=True, sort_keys=True, width=100)


def rewrite(text: str, merged: dict) -> str:
    # yaml.safe_load turns an unquoted all-digit top-level key (e.g. a hex book id that
    # happens to be all digits) into an int; top_level_chunks always returns it as the str
    # it appears as in the file, so normalise here to keep the two comparable.
    parsed = {str(k): v for k, v in (yaml.safe_load(text) or {}).items()}
    out: list[str] = []
    present: set[str] = set()
    for key, chunk in top_level_chunks(text):
        if key is None:
            out.append(chunk)
            continue
        present.add(key)
        if key not in merged:
            continue
        out.append(chunk if merged[key] == parsed.get(key) else render_entry(key, merged[key]))
    new_keys = [k for k in merged if k not in present]
    if new_keys:
        if out and not "".join(out).endswith("\n"):
            out.append("\n")
        out.extend(render_entry(k, merged[k]) for k in sorted(new_keys, key=str))
    return "".join(out)


def merge(overrides: dict, items: list[dict]) -> tuple[dict, list[str], dict[str, str], dict[str, str]]:
    site_categories = sorted(
        i["sk"] for i in items if i.get("pk") == "CATEGORY" and i["sk"] not in BUILTIN_CATEGORIES
    )
    books = {}
    for i in items:
        if i.get("pk") != "BOOK":
            continue
        category = i.get("category")
        if category is None:
            print(f"warning: BOOK {i.get('sk')} has no category; skipped", file=sys.stderr)
            continue
        books[i["sk"]] = category
    work_rows = {i["sk"]: i["workId"] for i in items if i.get("pk") == "WORKEDIT" and i.get("workId")}

    merged = dict(overrides)
    if site_categories:
        merged["categories"] = site_categories
    else:
        merged.pop("categories", None)
    for book_id, category in books.items():
        entry = dict(merged.get(book_id) or {})
        entry["category"] = category
        merged[book_id] = entry
    # The app owns work keys: a key with no correction row was reset in the app.
    for key in list(merged):
        entry = merged[key]
        if isinstance(entry, dict) and "work" in entry and key not in work_rows:
            remaining = {k: v for k, v in entry.items() if k != "work"}
            if remaining:
                merged[key] = remaining
            else:
                del merged[key]
    for edition_id, work_id in work_rows.items():
        entry = dict(merged.get(edition_id) or {})
        entry["work"] = work_id
        merged[edition_id] = entry
    return merged, site_categories, books, work_rows


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--input")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv[1:])

    cfg = load_config(Path(args.config))
    if not args.input and not cfg.library_table:
        print("config.yaml has no library_table (run scripts/apply-outputs.py after deploying)", file=sys.stderr)
        return 1
    items = load_items(args, cfg)

    overrides_path = cfg.metadata_dir / "overrides.yaml"
    text = overrides_path.read_text() if overrides_path.exists() else ""
    # Normalise keys to str: an unquoted all-digit top-level key parses as an int otherwise,
    # which would no longer match the corresponding str key elsewhere (see rewrite()).
    existing = {str(k): v for k, v in (yaml.safe_load(text) or {}).items()}
    merged, site_categories, books, work_rows = merge(existing, items)

    catalog_path = cfg.output_dir / "catalog.json"
    if catalog_path.exists():
        known = {b["id"] for b in json.loads(catalog_path.read_text())["books"]}
        for book_id, category in sorted(books.items()):
            if book_id not in known:
                print(f"orphan: {book_id} ({category})")
        for edition_id, work_id in sorted(work_rows.items()):
            if edition_id not in known:
                print(f"orphan: {edition_id} (work {work_id})")

    print(f"merged {len(books)} book categories, {len(site_categories)} site categories, "
          f"{len(work_rows)} work corrections")
    if args.dry_run:
        return 0
    new_text = rewrite(text, merged)
    if new_text == text:
        print(f"{overrides_path} already up to date")
        return 0
    overrides_path.write_text(new_text)
    print(f"wrote {overrides_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
