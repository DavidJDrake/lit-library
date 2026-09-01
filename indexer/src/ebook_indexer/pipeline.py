import json
import re
from datetime import date
from pathlib import Path, PurePosixPath

from .categorize import apply_overrides, derive_category, load_overrides
from .enrich import Enricher
from .extract_archive import classify_archive
from .extract_epub import extract_epub
from .extract_pdf import extract_pdf
from .group import group_files, normalize_name
from .models import Book, BookFormat, ExtractedMeta, ScannedFile
from .scan import scan_library


def prettify(stem: str) -> str:
    s = re.sub(r"[_\-]+", " ", stem)
    s = re.sub(r"\s+", " ", s).strip()
    return s.title() if s == s.lower() else s


def _extract(primary: ScannedFile) -> ExtractedMeta:
    if primary.format == "epub":
        return extract_epub(primary.path)
    if primary.format == "pdf":
        return extract_pdf(primary.path)
    meta = ExtractedMeta()
    meta.archive_kind = classify_archive(primary.path, primary.format)
    return meta


def _publisher_from_bundle(bundle: str) -> str | None:
    m = re.search(r"\bby (.+)$", bundle, re.IGNORECASE)
    return m.group(1).strip() if m else None


def build_books(root: Path, cache_dir: Path, overrides_path: Path,
                added_path: Path, enricher: Enricher | None = None,
                limit: int | None = None) -> tuple[list[Book], dict[str, bytes]]:
    groups = group_files(scan_library(root))
    overrides = load_overrides(overrides_path)
    added = json.loads(added_path.read_text()) if added_path.exists() else {}
    today = date.today().isoformat()

    books: list[Book] = []
    covers: dict[str, bytes] = {}
    for bid, files in sorted(groups.items(), key=lambda kv: kv[1][0].rel_path):
        if limit is not None and len(books) >= limit:
            break
        primary = files[0]  # epub-first ordering from group_files
        meta = _extract(primary)
        stem = PurePosixPath(primary.rel_path).stem
        fallback_title = prettify(stem)
        if enricher is not None:
            enricher.enrich(meta, fallback_title)
        book = Book(
            id=bid,
            title=meta.title or fallback_title,
            authors=meta.authors,
            description=meta.description,
            category=derive_category(primary.bundle, meta.subjects,
                                     [f.format for f in files], meta.archive_kind),
            subjects=meta.subjects,
            publisher=meta.publisher or _publisher_from_bundle(primary.bundle),
            bundle=primary.bundle,
            year=meta.year,
            formats=[BookFormat(type=f.format, size=f.size,
                                s3_key=f"books/{f.rel_path}", rel_path=f.rel_path)
                     for f in files],
            cover_url=None,  # set by catalog.write_outputs when a cover exists
            added_at=added.get(bid, today),
        )
        apply_overrides(book, overrides)
        if meta.cover:
            covers[bid] = meta.cover
        added.setdefault(bid, today)
        books.append(book)

    added_path.parent.mkdir(parents=True, exist_ok=True)
    added_path.write_text(json.dumps(added, indent=0, sort_keys=True))
    return books, covers
