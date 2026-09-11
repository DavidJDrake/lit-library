from pathlib import Path

from .models import ScannedFile

CONTENT_EXTS = {".epub": "epub", ".pdf": "pdf", ".cbz": "cbz", ".zip": "zip"}


def scan_library(root: Path) -> list[ScannedFile]:
    files = []
    for path in root.rglob("*"):
        if not path.is_file() or path.name.endswith("Zone.Identifier"):
            continue
        fmt = CONTENT_EXTS.get(path.suffix.lower())
        if fmt is None:
            continue
        rel = path.relative_to(root).as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue  # hidden folders and files (e.g. ".playwright-mcp/", "._book.epub")
        files.append(
            ScannedFile(
                path=path.resolve(),
                rel_path=rel,
                bundle=rel.split("/", 1)[0],
                format=fmt,
                size=path.stat().st_size,
            )
        )
    return sorted(files, key=lambda f: f.rel_path)
