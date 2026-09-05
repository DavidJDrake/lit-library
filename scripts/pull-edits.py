#!/usr/bin/env python3
"""Fold the site's category edits back into metadata/overrides.yaml.

The site stores category changes and site-created categories in the DynamoDB
library table (see docs/superpowers/specs/2026-09-04-user-categories-design.md).
This script copies them into overrides.yaml so the repo's metadata stays a
faithful backup and the next index/publish converges on what people chose.
Only the leading header comment survives a write; comments elsewhere in
overrides.yaml are dropped (a warning lists them).

Usage: scripts/pull-edits.py [--config config.yaml] [--input scan.json] [--dry-run]
  --input   read a DynamoDB typed scan (aws dynamodb scan --output json) instead of AWS
  --dry-run print what would change without writing
"""
import argparse
import json
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


def split_header(text: str) -> tuple[str, str, dict]:
    """Return the leading comment/blank lines verbatim, the remaining raw body
    text, and the body parsed as a mapping."""
    lines = text.splitlines(keepends=True)
    n = 0
    while n < len(lines) and (lines[n].startswith("#") or not lines[n].strip()):
        n += 1
    header, body = "".join(lines[:n]), "".join(lines[n:])
    return header, body, (yaml.safe_load(body) or {})


def dropped_comments(body: str) -> list[str]:
    """Comment lines in the body that a write will silently discard (yaml.safe_dump
    doesn't preserve comments)."""
    return [line.strip() for line in body.splitlines() if line.strip().startswith("#")]


def merge(overrides: dict, items: list[dict]) -> tuple[dict, list[str], dict[str, str]]:
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
    merged = dict(overrides)
    if site_categories:
        merged["categories"] = site_categories
    else:
        merged.pop("categories", None)
    for book_id, category in books.items():
        entry = dict(merged.get(book_id) or {})
        entry["category"] = category
        merged[book_id] = entry
    return merged, site_categories, books


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
    header, body, existing = (
        split_header(overrides_path.read_text()) if overrides_path.exists() else ("", "", {})
    )
    merged, site_categories, books = merge(existing, items)

    comments = dropped_comments(body)
    if comments:
        print(f"warning: {len(comments)} comment line(s) below the header will be dropped:", file=sys.stderr)
        for line in comments:
            print(f"  {line}", file=sys.stderr)

    catalog_path = cfg.output_dir / "catalog.json"
    if catalog_path.exists():
        known = {b["id"] for b in json.loads(catalog_path.read_text())["books"]}
        for book_id, category in sorted(books.items()):
            if book_id not in known:
                print(f"orphan: {book_id} ({category})")

    print(f"merged {len(books)} book categories, {len(site_categories)} site categories")
    if args.dry_run:
        return 0
    dumped = yaml.safe_dump(merged, allow_unicode=True, sort_keys=True, width=100)
    overrides_path.write_text(header + dumped)
    print(f"wrote {overrides_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
