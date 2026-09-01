import hashlib
import re
from collections import defaultdict
from pathlib import PurePosixPath

from .models import ScannedFile

_FORMAT_ORDER = {"epub": 0, "pdf": 1, "cbz": 2, "zip": 3}


def normalize_name(filename: str) -> str:
    stem = PurePosixPath(filename).stem
    return re.sub(r"[^a-z0-9]+", "", stem.lower())


def book_id(bundle: str, norm_name: str) -> str:
    return hashlib.sha1(f"{bundle}/{norm_name}".encode()).hexdigest()[:16]


def group_files(files: list[ScannedFile]) -> dict[str, list[ScannedFile]]:
    groups: dict[str, list[ScannedFile]] = defaultdict(list)
    for f in files:
        key = book_id(f.bundle, normalize_name(PurePosixPath(f.rel_path).name))
        groups[key].append(f)
    return {
        k: sorted(v, key=lambda f: _FORMAT_ORDER[f.format])
        for k, v in groups.items()
    }
