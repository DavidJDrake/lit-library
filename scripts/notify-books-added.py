#!/usr/bin/env python3
"""Tell the site that new books were published.

Run by scripts/publish-new.sh after a successful publish. Computes which book ids
are new (added.json keys now vs. a snapshot taken before the run) and invokes the
notifications Lambda (stack output NotificationsFunctionName) so everyone gets a
"N new books added" notification. Never fails the publish: any problem is a
warning and exit 0.

Usage: scripts/notify-books-added.py --before before.json --added metadata/added.json
                                     [--outputs infra/outputs.json] [--region us-east-1] [--dry-run]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BOOK_IDS = 20


def new_book_ids(before: dict, added: dict) -> list[str]:
    return sorted(set(added) - set(before))


def build_payload(new_ids: list[str]) -> dict:
    return {"source": "indexer", "type": "books_added", "count": len(new_ids), "bookIds": new_ids[:MAX_BOOK_IDS]}


def warn(msg: str) -> int:
    print(f"warning: {msg}", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True)
    ap.add_argument("--added", required=True)
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
    payload = build_payload(ids)
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
