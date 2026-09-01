import json
from datetime import datetime, timezone
from pathlib import Path

from .covers import thumbnail_webp
from .models import Book


def write_outputs(books: list[Book], covers_by_id: dict[str, bytes],
                  out_dir: Path) -> Path:
    covers_dir = out_dir / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)
    for book in books:
        raw = covers_by_id.get(book.id)
        thumb = thumbnail_webp(raw) if raw else None
        if thumb:
            (covers_dir / f"{book.id}.webp").write_bytes(thumb)
            book.cover_url = f"/covers/{book.id}.webp"

    data = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "books": [
            {
                "id": b.id,
                "title": b.title,
                "authors": b.authors,
                "description": b.description,
                "category": b.category,
                "subjects": b.subjects,
                "publisher": b.publisher,
                "bundle": b.bundle,
                "year": b.year,
                "formats": [
                    {"type": f.type, "size": f.size, "s3Key": f.s3_key}
                    for f in b.formats
                ],
                "coverUrl": b.cover_url,
                "addedAt": b.added_at,
            }
            for b in books
        ],
    }
    catalog_path = out_dir / "catalog.json"
    catalog_path.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    return catalog_path
