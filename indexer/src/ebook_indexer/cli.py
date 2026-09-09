import argparse
import os
import sys
from pathlib import Path

from .catalog import write_outputs
from .config import load_config
from .enrich import Enricher
from .pipeline import build_books
from .publish import delete_book_objects, find_orphan_books, invalidate_catalog, publish_site, sync_books
from .scan import scan_library

OVERRIDES_STUB = """\
# Manual metadata overrides. Keyed by book id (from catalog.json).
# Editable fields: category, title, authors, year, publisher, description.
# Valid categories: Tech & Programming, Security & Hacking, Fiction,
#   Comics, TTRPG, Certification, Other/Lifestyle
# Example:
# 0123456789abcdef:
#   category: Fiction
#   title: Better Title
"""


def _seed_overrides_stub(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(OVERRIDES_STUB)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ebook-indexer")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="scan, extract, enrich, write catalog")
    p_index.add_argument("--config", required=True, type=Path)
    p_index.add_argument("--limit", type=int, default=None)
    p_index.add_argument("--skip-enrich", action="store_true")
    p_index.add_argument(
        "--retry-failed-enrichment",
        action="store_true",
        help="clear cached enrichment misses (not-found results) so this run "
             "re-attempts them; successful lookups are left untouched",
    )

    p_publish = sub.add_parser("publish", help="sync books and site assets to S3")
    p_publish.add_argument("--config", required=True, type=Path)

    p_prune = sub.add_parser(
        "prune",
        help="list book files in S3 that are no longer in the library (add --delete to remove them)",
    )
    p_prune.add_argument("--config", required=True, type=Path)
    p_prune.add_argument("--delete", action="store_true",
                         help="actually delete; without it, prune only reports")

    args = parser.parse_args(argv)
    cfg = load_config(args.config)

    if args.command == "index":
        _seed_overrides_stub(cfg.metadata_dir / "overrides.yaml")
        enricher = None
        if not args.skip_enrich:
            enricher = Enricher(
                cfg.metadata_dir / "cache",
                google_books_api_key=os.environ.get("GOOGLE_BOOKS_API_KEY") or None,
            )
            if args.retry_failed_enrichment:
                n = enricher.clear_failed_cache()
                print(f"Cleared {n} failed enrichment cache entries for retry")
        books, covers = build_books(
            root=cfg.library_root,
            overrides_path=cfg.metadata_dir / "overrides.yaml",
            added_path=cfg.metadata_dir / "added.json",
            enricher=enricher,
            limit=args.limit,
        )
        catalog_path = write_outputs(books, covers, cfg.output_dir)
        n_covers = sum(1 for b in books if b.cover_url)
        print(f"Indexed {len(books)} books ({n_covers} with covers) -> {catalog_path}")
        return 0

    if args.command == "publish":
        if not cfg.books_bucket or not cfg.site_bucket:
            print("books_bucket and site_bucket must be set in config", file=sys.stderr)
            return 2
        import boto3

        s3 = boto3.client("s3", region_name=cfg.aws_region)
        cf = boto3.client("cloudfront", region_name=cfg.aws_region)
        files = scan_library(cfg.library_root)
        n = sync_books(s3, cfg.books_bucket, files,
                       cfg.metadata_dir / "publish-state.json")
        m = publish_site(s3, cfg.site_bucket, cfg.output_dir)
        invalidate_catalog(cf, cfg.cloudfront_distribution_id)
        print(f"Uploaded {n} book files, {m} site objects")
        return 0

    if args.command == "prune":
        if not cfg.books_bucket:
            print("books_bucket must be set in config", file=sys.stderr)
            return 2
        import boto3

        files = scan_library(cfg.library_root)
        # A scan that finds nothing almost certainly means the library is not where
        # the config says (an unmounted drive, the wrong config), and every book in
        # the bucket would look orphaned. Deleting the whole library on a
        # misconfiguration is not a risk worth taking for a cleanup command.
        if not files:
            print(f"no books found under {cfg.library_root}; refusing to prune", file=sys.stderr)
            return 2

        s3 = boto3.client("s3", region_name=cfg.aws_region)
        orphans = find_orphan_books(s3, cfg.books_bucket, files)
        if not orphans:
            print(f"no orphaned book files ({len(files)} in the library)")
            return 0

        for key in orphans:
            print(key)
        if not args.delete:
            print(f"\n{len(orphans)} orphaned file(s); re-run with --delete to remove them")
            return 0

        n = delete_book_objects(s3, cfg.books_bucket, orphans,
                                cfg.metadata_dir / "publish-state.json")
        print(f"\ndeleted {n} orphaned file(s)")
        return 0

    return 1
