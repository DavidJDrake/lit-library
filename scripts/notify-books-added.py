#!/usr/bin/env python3
"""Tell the site that new books were published.

Run by scripts/publish-new.sh after a successful publish. Computes which books
are new: added.json keys now vs. a snapshot taken before the run, counting only
copies that start a new edition (catalog.json editionId equals the id), since a
copy joining an existing edition is not news. Invokes the notifications Lambda
(stack output NotificationsFunctionName) so everyone gets a "N new books added"
notification. Never fails the publish: any problem is a warning and exit 0.

Usage: scripts/notify-books-added.py --before before.json --added metadata/added.json
                                     [--catalog out/catalog.json] [--outputs infra/outputs.json]
                                     [--region us-east-1] [--dry-run]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BOOK_IDS = 20


def warn(msg: str) -> int:
    print(f"warning: {msg}", file=sys.stderr)
    return 0


def new_book_ids(before: dict, added: dict) -> list[str]:
    return sorted(set(added) - set(before))


def new_edition_ids(new_ids: list[str], catalog_books: list | None) -> list[str]:
    """New copies that start a new edition. A copy that joined an existing edition carries
    that edition's older id. Without a catalog, every new copy counts."""
    if catalog_books is None:
        return new_ids
    edition_of = {b["id"]: b.get("editionId", b["id"]) for b in catalog_books if isinstance(b, dict) and "id" in b}
    return [i for i in new_ids if edition_of.get(i, i) == i]


def load_catalog_books(path: str, explicit: bool) -> list | None:
    p = Path(path)
    if not p.exists() and not explicit:
        return None
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        warn(f"could not read {path} ({e}); counting every new copy")
        return None
    books = data.get("books") if isinstance(data, dict) else None
    if not isinstance(books, list):
        warn(f"{path} has no books list; counting every new copy")
        return None
    return books


def build_payload(new_ids: list[str]) -> dict:
    return {"source": "indexer", "type": "books_added", "count": len(new_ids), "bookIds": new_ids[:MAX_BOOK_IDS]}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True)
    ap.add_argument("--added", required=True)
    ap.add_argument("--catalog", help="catalog.json to tell new editions from new copies (default: out/catalog.json)")
    ap.add_argument("--outputs", default=str(ROOT / "infra" / "outputs.json"))
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv[1:])

    try:
        before = json.loads(Path(args.before).read_text()) if Path(args.before).exists() else {}
    except (OSError, ValueError) as e:
        return warn(f"could not read {args.before} ({e}); books-added notification skipped")
    if not isinstance(before, dict):
        return warn(f"{args.before} is not a JSON object (got {type(before).__name__}); books-added notification skipped")
    try:
        added = json.loads(Path(args.added).read_text())
    except (OSError, ValueError) as e:
        return warn(f"could not read {args.added} ({e}); books-added notification skipped")
    if not isinstance(added, dict):
        return warn(f"{args.added} is not a JSON object (got {type(added).__name__}); books-added notification skipped")
    ids = new_book_ids(before, added)
    if not ids:
        print("no new books; nothing to notify")
        return 0
    catalog_books = load_catalog_books(args.catalog or str(ROOT / "out" / "catalog.json"), explicit=bool(args.catalog))
    editions = new_edition_ids(ids, catalog_books)
    if not editions:
        copies = "copy" if len(ids) == 1 else "copies"
        print(f"no new editions ({len(ids)} new {copies} joined existing editions); nothing to notify")
        return 0
    payload = build_payload(editions)
    if args.dry_run:
        print(json.dumps(payload))
        return 0

    try:
        stack_outputs = json.loads(Path(args.outputs).read_text())
    except (OSError, ValueError) as e:
        return warn(f"could not find NotificationsFunctionName in {args.outputs} ({e}); books-added notification skipped")
    if not isinstance(stack_outputs, dict):
        return warn(f"{args.outputs} is not a JSON object (got {type(stack_outputs).__name__}); books-added notification skipped")
    try:
        outputs = next(iter(stack_outputs.values()))
        fn = outputs["NotificationsFunctionName"]
    except (KeyError, StopIteration, TypeError) as e:
        return warn(f"could not find NotificationsFunctionName in {args.outputs} ({e}); books-added notification skipped")
    try:
        import boto3
        out = boto3.client("lambda", region_name=args.region).invoke(FunctionName=fn, Payload=json.dumps(payload).encode())
        result = json.loads(out["Payload"].read() or b"{}")
    except Exception as e:  # noqa: BLE001 — anything here is a warning by design
        return warn(f"invoke failed ({e}); books-added notification skipped")
    if not result.get("ok"):
        return warn(f"notifications Lambda refused the event: {result}")
    print(f"notified {result.get('recipients', '?')} recipient(s): {payload['count']} new books")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
