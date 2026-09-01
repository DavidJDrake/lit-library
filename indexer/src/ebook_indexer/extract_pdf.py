from pathlib import Path

import pymupdf

from .models import ExtractedMeta


def extract_pdf(path: Path) -> ExtractedMeta:
    meta = ExtractedMeta()
    try:
        with pymupdf.open(str(path)) as doc:
            info = doc.metadata or {}
            meta.title = (info.get("title") or "").strip() or None
            author_text = (info.get("author") or "").replace(";", ",")
            meta.authors = [a.strip() for a in author_text.split(",") if a.strip()]
            if doc.page_count > 0:
                pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5))
                meta.cover = pix.tobytes("png")
    except Exception:
        pass  # corrupt/encrypted PDFs degrade to empty metadata by design
    return meta
