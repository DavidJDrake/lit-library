import hashlib
import re
import time
import urllib.parse
from pathlib import Path

import requests

from .jsonio import read_json_or, write_json_atomic
from .models import ExtractedMeta

_USER_AGENT = "ebook-share-indexer/0.1 (personal library indexer)"

# HTTP statuses worth retrying: rate limiting and server-side trouble.
# Anything else (400, 404, ...) is a definitive answer from the service,
# not a transient failure, so it is NOT in this set.
_RETRYABLE_STATUSES = {429, 500, 502, 503, 504}

# A handful of retries, not a hammer: first attempt + this many more.
_MAX_FETCH_ATTEMPTS = 4
_BACKOFF_SECONDS = (1.0, 2.0, 4.0)  # used when no Retry-After header is given


class TransientFetchError(Exception):
    """The network or the remote service failed in a way a retry might fix.

    This is distinct from the service answering and saying "not found":
    that is a definitive result and must still be cached, or every run
    would re-query the same permanent misses. A TransientFetchError means
    we don't actually know the answer yet.
    """

    def __init__(self, message: str = "transient fetch failure", retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None  # HTTP-date form; not parsed, caller falls back to default backoff


def _default_fetch_json(url: str) -> dict | None:
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": _USER_AGENT})
    except requests.RequestException as exc:
        raise TransientFetchError(f"network error: {exc}") from exc
    if r.status_code in _RETRYABLE_STATUSES:
        raise TransientFetchError(
            f"HTTP {r.status_code}",
            retry_after=_parse_retry_after(r.headers.get("Retry-After")),
        )
    try:
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

    A lookup that gets a definitive answer (found, or genuinely not found)
    is cached as one JSON file per book in cache_dir, so re-runs never
    re-query it. A lookup that fails transiently (network error, rate
    limit, server error) is retried a handful of times and, if it still
    doesn't resolve, is left uncached entirely so the next run tries again
    instead of the miss being baked in permanently.
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

    def clear_failed_cache(self) -> int:
        """Delete cache entries recorded as a definitive miss, so the next
        lookup retries them. Entries that found something are left alone,
        and their covers/other data are not re-fetched. Returns the number
        of cache files removed.
        """
        removed = 0
        for cache_file in self.cache_dir.glob("*.json"):
            data = read_json_or(cache_file, None)
            if isinstance(data, dict) and data.get("found") is False:
                cache_file.unlink()
                removed += 1
        return removed

    def _cached_lookup(self, key: str, meta: ExtractedMeta, fallback_title: str) -> dict:
        cache_file = self.cache_dir / (hashlib.sha1(key.encode()).hexdigest() + ".json")
        cached = read_json_or(cache_file, None)
        if cached is not None:
            return cached
        try:
            data = self._lookup(meta, fallback_title)
        except TransientFetchError:
            # Inconclusive: don't write anything, so the next run retries
            # this book instead of a transient failure being cached forever.
            data = None
        finally:
            self.sleep(0.5)  # politeness delay, only on cache miss
        if data is None:
            return {"found": False}
        write_json_atomic(cache_file, data)
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
        except TransientFetchError:
            raise  # let the caller leave this book uncached
        except Exception:
            return {"found": False}

    def _fetch_json_retrying(self, url: str) -> dict | None:
        attempt = 0
        while True:
            try:
                return self.fetch_json(url)
            except TransientFetchError as exc:
                attempt += 1
                if attempt >= _MAX_FETCH_ATTEMPTS:
                    raise
                delay = exc.retry_after
                if delay is None:
                    delay = _BACKOFF_SECONDS[min(attempt - 1, len(_BACKOFF_SECONDS) - 1)]
                self.sleep(delay)

    def _open_library_isbn(self, isbn: str) -> dict:
        url = f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data"
        resp = self._fetch_json_retrying(url)
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
        resp = self._fetch_json_retrying(url)
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
