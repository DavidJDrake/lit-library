import hashlib
import re
import time
import urllib.parse
from pathlib import Path

import requests

from .jsonio import read_json_or, write_json_atomic
from .models import ExtractedMeta

_USER_AGENT = "ebook-share-indexer/0.1 (personal library indexer)"


def _default_fetch_json(url: str) -> dict | None:
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": _USER_AGENT})
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def _default_fetch_bytes(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": _USER_AGENT})
        r.raise_for_status()
        return r.content
    except Exception:
        return None


def _year_from(text: str | None) -> int | None:
    if not text:
        return None
    m = re.search(r"\b(1[89]\d{2}|20\d{2})\b", text)
    return int(m.group(1)) if m else None


class Enricher:
    """Fills gaps in ExtractedMeta from Open Library, then Google Books.

    All lookups (hits AND misses) are cached as one JSON file per book in
    cache_dir, so re-runs never re-query.
    """

    def __init__(self, cache_dir: Path, fetch_json=None, fetch_bytes=None, sleep=None):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.fetch_json = fetch_json or _default_fetch_json
        self.fetch_bytes = fetch_bytes or _default_fetch_bytes
        self.sleep = sleep if sleep is not None else time.sleep

    def enrich(self, meta: ExtractedMeta, fallback_title: str) -> None:
        key = meta.isbn or f"{fallback_title}|{meta.authors[0] if meta.authors else ''}"
        data = self._cached_lookup(key, meta, fallback_title)
        if not data.get("found"):
            return
        if not meta.title and data.get("title"):
            meta.title = data["title"]
        if not meta.authors and data.get("authors"):
            meta.authors = data["authors"]
        if not meta.description and data.get("description"):
            meta.description = data["description"]
        if not meta.subjects and data.get("subjects"):
            meta.subjects = data["subjects"]
        if not meta.publisher and data.get("publisher"):
            meta.publisher = data["publisher"]
        if not meta.year and data.get("year"):
            meta.year = data["year"]
        if meta.cover is None and data.get("cover_url"):
            meta.cover = self.fetch_bytes(data["cover_url"])

    def _cached_lookup(self, key: str, meta: ExtractedMeta, fallback_title: str) -> dict:
        cache_file = self.cache_dir / (hashlib.sha1(key.encode()).hexdigest() + ".json")
        cached = read_json_or(cache_file, None)
        if cached is not None:
            return cached
        data = self._lookup(meta, fallback_title)
        write_json_atomic(cache_file, data)
        self.sleep(0.5)  # politeness delay, only on cache miss
        return data

    def _lookup(self, meta: ExtractedMeta, fallback_title: str) -> dict:
        try:
            data = {"found": False}
            if meta.isbn:
                data = self._open_library_isbn(meta.isbn)
            if not data.get("found"):
                title = meta.title or fallback_title
                data = self._google_books(title, meta.authors)
            elif not data.get("description"):
                gb = self._google_books(data.get("title") or meta.title or fallback_title, meta.authors)
                if gb.get("found") and gb.get("description"):
                    data["description"] = gb["description"]
            return data
        except Exception:
            return {"found": False}

    def _open_library_isbn(self, isbn: str) -> dict:
        url = f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data"
        resp = self.fetch_json(url)
        entry = resp.get(f"ISBN:{isbn}") if isinstance(resp, dict) else None
        if not entry:
            return {"found": False}
        return {
            "found": True,
            "title": entry.get("title"),
            "authors": [a["name"] for a in (entry.get("authors") or []) if a.get("name")],
            "description": None,  # data API has no description; Google Books fills it
            "subjects": [s["name"] for s in (entry.get("subjects") or [])[:10] if s.get("name")],
            "publisher": (entry.get("publishers") or [{}])[0].get("name"),
            "year": _year_from(entry.get("publish_date")),
            "cover_url": (entry.get("cover") or {}).get("large"),
        }

    def _google_books(self, title: str, authors: list[str]) -> dict:
        q = f"intitle:{title}"
        if authors:
            q += f" inauthor:{authors[0]}"
        url = "https://www.googleapis.com/books/v1/volumes?q=" + urllib.parse.quote(q)
        resp = self.fetch_json(url)
        items = resp.get("items") if isinstance(resp, dict) else None
        if not items:
            return {"found": False}
        v = items[0].get("volumeInfo") or {}
        thumb = (v.get("imageLinks") or {}).get("thumbnail")
        return {
            "found": True,
            "title": v.get("title"),
            "authors": v.get("authors") or [],
            "description": v.get("description"),
            "subjects": v.get("categories") or [],
            "publisher": v.get("publisher"),
            "year": _year_from(v.get("publishedDate")),
            "cover_url": thumb.replace("http://", "https://") if thumb else None,
        }
