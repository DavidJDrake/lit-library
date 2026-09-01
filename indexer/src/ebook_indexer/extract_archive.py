import zipfile
from pathlib import Path, PurePosixPath

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
CODE_EXTS = {".py", ".js", ".ts", ".java", ".c", ".cpp", ".h", ".sh",
             ".rb", ".go", ".html", ".css", ".ipynb", ".json", ".yml", ".yaml"}
BOOK_EXTS = {".epub", ".pdf", ".mobi", ".prc", ".azw3"}


def classify_archive(path: Path, fmt: str) -> str:
    if fmt == "cbz":
        return "comic"
    try:
        with zipfile.ZipFile(path) as zf:
            exts = [PurePosixPath(n).suffix.lower() for n in zf.namelist()
                    if not n.endswith("/")]
    except (zipfile.BadZipFile, OSError):
        return "other"
    if not exts:
        return "other"
    if any(e in BOOK_EXTS for e in exts):
        return "books"
    n_images = sum(1 for e in exts if e in IMAGE_EXTS)
    if n_images / len(exts) > 0.5:
        return "comic"
    if any(e in CODE_EXTS for e in exts):
        return "code"
    return "other"
