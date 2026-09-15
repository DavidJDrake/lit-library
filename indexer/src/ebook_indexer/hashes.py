"""SHA-256 per library file, cached by relative path, size and modification time.

Hashing the whole library (about 95 GB) on every publish would be far too slow, so a
file is re-read only when it is new or its size or mtime changed. The cache lives at
metadata/hashes.json (gitignored) and is rebuilt if unreadable.
"""
import hashlib
from pathlib import Path

from .jsonio import read_json_or, write_json_atomic

_CHUNK = 1 << 20


class HashCache:
    def __init__(self, path: Path | None):
        self.path = path
        self.hashed = 0
        self.warnings: list[str] = []
        self._entries: dict[str, dict] = {}
        self._seen: set[str] = set()
        if path is not None and path.exists():
            data = read_json_or(path, None)
            if isinstance(data, dict):
                self._entries = {k: v for k, v in data.items() if isinstance(v, dict)}
            else:
                self.warnings.append(f"{path} is unreadable; rebuilding the hash cache")

    def sha256(self, file_path: Path, rel_path: str) -> str | None:
        try:
            st = file_path.stat()
        except OSError as e:
            self.warnings.append(f"cannot read {rel_path} ({e}); it contributes no file hash")
            return None
        self._seen.add(rel_path)
        entry = self._entries.get(rel_path)
        if (entry and entry.get("size") == st.st_size and entry.get("mtime") == st.st_mtime
                and isinstance(entry.get("sha256"), str)):
            return entry["sha256"]
        digest = hashlib.sha256()
        try:
            with file_path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(_CHUNK), b""):
                    digest.update(chunk)
        except OSError as e:
            self._seen.discard(rel_path)
            self.warnings.append(f"cannot read {rel_path} ({e}); it contributes no file hash")
            return None
        self.hashed += 1
        self._entries[rel_path] = {"size": st.st_size, "mtime": st.st_mtime, "sha256": digest.hexdigest()}
        return self._entries[rel_path]["sha256"]

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, {k: v for k, v in sorted(self._entries.items()) if k in self._seen})
