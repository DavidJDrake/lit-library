from pathlib import Path

import pymupdf

from .models import ExtractedMeta

# Desktop-publishing artifacts left in the Info-dict Title by tools like
# InDesign/Word/QuarkXPress/PageMaker/FrameMaker/LaTeX exports, or a plain
# "untitled" placeholder. Treated as absent so the filename-based fallback
# title applies instead.
_JUNK_TITLE_SUFFIXES = (".indd", ".doc", ".docx", ".qxd", ".pmd", ".fm", ".tex")


def _is_junk_title(title: str) -> bool:
    t = title.lower()
    return t == "untitled" or t.endswith(_JUNK_TITLE_SUFFIXES)


def extract_pdf(path: Path) -> ExtractedMeta:
    meta = ExtractedMeta()
    try:
        with pymupdf.open(str(path)) as doc:
            info = doc.metadata or {}
            title = (info.get("title") or "").strip() or None
            meta.title = None if title and _is_junk_title(title) else title
            author_text = (info.get("author") or "").replace(";", ",")
            meta.authors = [a.strip() for a in author_text.split(",") if a.strip()]
            if doc.page_count > 0:
                pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5))
                meta.cover = pix.tobytes("png")
    except Exception:
        pass  # corrupt/encrypted PDFs degrade to empty metadata by design
    return meta
