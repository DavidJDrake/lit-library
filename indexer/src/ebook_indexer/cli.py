import argparse
import sys
from pathlib import Path

from .catalog import write_outputs
from .config import load_config
from .enrich import Enricher
from .pipeline import build_books
from .publish import invalidate_catalog, publish_site, sync_books
from .scan import scan_library


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ebook-indexer")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="scan, extract, enrich, write catalog")
    p_index.add_argument("--config", required=True, type=Path)
    p_index.add_argument("--limit", type=int, default=None)
    p_index.add_argument("--skip-enrich", action="store_true")

    p_publish = sub.add_parser("publish", help="sync books and site assets to S3")
    p_publish.add_argument("--config", required=True, type=Path)

    args = parser.parse_args(argv)
    cfg = load_config(args.config)

    if args.command == "index":
        enricher = None
        if not args.skip_enrich:
            enricher = Enricher(cfg.metadata_dir / "cache")
        books, covers = build_books(
            root=cfg.library_root,
            cache_dir=cfg.metadata_dir / "cache",
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

    return 1
