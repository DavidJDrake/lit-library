from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class ScannedFile:
    path: Path       # absolute path on disk
    rel_path: str    # posix-style, relative to library root
    bundle: str      # top-level folder name
    format: str      # epub | pdf | cbz | zip
    size: int


@dataclass
class ExtractedMeta:
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    description: str | None = None
    subjects: list[str] = field(default_factory=list)
    isbn: str | None = None
    publisher: str | None = None
    year: int | None = None
    cover: bytes | None = None
    archive_kind: str | None = None  # for zips: comic | code | books | other


@dataclass
class BookFormat:
    type: str
    size: int
    s3_key: str
    rel_path: str


@dataclass
class Book:
    id: str
    title: str
    authors: list[str]
    description: str | None
    category: str
    subjects: list[str]
    publisher: str | None
    bundle: str
    year: int | None
    formats: list[BookFormat]
    cover_url: str | None
    added_at: str
