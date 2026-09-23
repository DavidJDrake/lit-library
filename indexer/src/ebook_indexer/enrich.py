import difflib
import hashlib
import re
import time
import unicodedata
import urllib.parse
from pathlib import Path

import requests

from .jsonio import read_json_or, write_json_atomic
from .models import ExtractedMeta

_USER_AGENT = "ebook-share-indexer/0.1 (personal library indexer)"

# Below this, a Google Books candidate's title is considered unrelated to
# the query, not just a differently-worded edition of it. Chosen from
# observed cases: real edition/subtitle differences ("Learning DevOps" vs
# "Learning DevOps: The complete guide...", "Cryptography Algorithms" vs
# "...Second Edition") normalize to a clean prefix match and score 1.0, so
# they never rely on this threshold. Unrelated titles that merely share
# words ("Design Patterns" vs "Head First Design Patterns" -> 0.73,
# "Raspberry Pi Official Magazine 155" vs "Raspberry Pi Book of Making
# 2027" -> 0.64) fall well short of it. 0.85 leaves comfortable margin on
# both sides without leaning on the fuzzy-ratio path to do the real work.
_TITLE_MATCH_THRESHOLD = 0.85

# A prefix relationship (one title being the other plus a trailing
# subtitle/edition marker) is only treated as a match when the shorter
# side is long enough that a short, generic prefix can't fire on
# unrelated titles by accident.
_MIN_PREFIX_WORDS = 2
_MIN_PREFIX_CHARS = 8

# A numbered-series marker at the end of a (normalized) title: either a
# keyword ("volume"/"vol"/"issue"/"part"/"no"/"number"/"num", optionally
# followed by "." before normalization strips it) immediately followed by
# digits, or a bare trailing number (also catches "#37", since "#" is
# stripped to a space by normalization). Both require the number to be
# the last thing in the title -- that's what "trailing" means here and
# matches how these series titles are actually phrased ("The MagPi 037",
# "..., Volume 2").
_DESIGNATOR_KEYWORD_RE = re.compile(r"\b(?:volume|vol|issue|part|no|number|num)\.?\s*0*(\d+)$")
_TRAILING_NUMBER_RE = re.compile(r"(?:^|\s)0*(\d+)$")


def _normalize_title(title: str | None) -> str:
    if not title:
        return ""
    s = unicodedata.normalize("NFKD", title)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    return s


def _split_designator(normalized_title: str) -> tuple[str, int | None]:
    """Split a normalized title into (base_title, designator).

    designator is the numbered-series marker at the end of the title, with
    zero-padding stripped ("037" and "37" are the same designator, so "The
    MagPi 037" and "The MagPi Issue 37" reduce to the same (base,
    designator) pair). None means the title carries no such marker.
    base_title is what's left after removing the marker -- what the title
    calls itself once the issue/volume number is set aside.
    """
    m = _DESIGNATOR_KEYWORD_RE.search(normalized_title) or _TRAILING_NUMBER_RE.search(normalized_title)
    if not m:
        return normalized_title, None
    return normalized_title[:m.start()].rstrip(), int(m.group(1))


def _normalize_author(author: str | None) -> str:
    if not author:
        return ""
    s = unicodedata.normalize("NFKD", author)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _title_score(query_title: str, candidate_title: str) -> float:
    """How plausibly candidate_title names the same book as query_title.

    1.0 means "treat as the same title" -- either normalizing to the same
    string, or one being a word-boundary prefix of the other (a subtitle
    or edition marker tacked on). Otherwise it's a plain fuzzy-string
    ratio, which is deliberately not trusted alone to call a match (see
    _TITLE_MATCH_THRESHOLD).

    A numbered-series marker (issue/volume/part/#N) is checked first and
    is decisive: a magazine issue or volume must never match a different
    number in the same series, or a series record with no number at all,
    no matter how similar the rest of the title looks -- fuzzy-string
    similarity does not distinguish "Volume 1" from "Volume 2" (they
    scored 0.97), which was the library's biggest source of wrong matches
    (168 magazine issues, 5-volume sets).
    """
    nq, nc = _normalize_title(query_title), _normalize_title(candidate_title)
    if not nq or not nc:
        return 0.0
    base_q, designator_q = _split_designator(nq)
    base_c, designator_c = _split_designator(nc)
    if designator_q != designator_c:
        return 0.0
    if base_q == base_c:
        return 1.0
    if len(base_q.split()) >= _MIN_PREFIX_WORDS or len(base_q) >= _MIN_PREFIX_CHARS:
        if base_c.startswith(base_q + " ") or base_q.startswith(base_c + " "):
            return 1.0
    return difflib.SequenceMatcher(None, base_q, base_c).ratio()


def _authors_match(query_authors: list[str], candidate_authors: list[str]) -> bool:
    """True if any query author plausibly names the same person as any
    candidate author. Substring containment handles initials/full-name
    variants ("J.R.R. Tolkien" vs "Tolkien"); a shared last word catches
    "A. Writer" vs "Writer, A.".
    """
    queries = [_normalize_author(a) for a in query_authors if a]
    candidates = [_normalize_author(a) for a in candidate_authors if a]
    for qa in queries:
        for ca in candidates:
            if not qa or not ca:
                continue
            if qa == ca or qa in ca or ca in qa:
                return True
            if qa.split()[-1] == ca.split()[-1] and len(qa.split()[-1]) >= 3:
                return True
    return False


def _is_plausible_match(query_title: str, query_authors: list[str], volume_info: dict) -> bool:
    score = _title_score(query_title, volume_info.get("title") or "")
    if score < _TITLE_MATCH_THRESHOLD:
        return False
    if query_authors:
        # The title alone -- even an exact/prefix match -- is not trusted
        # when we already know the author: two different books can share
        # a title (or one be a subtitle-prefix of the other), so a known
        # author must corroborate it.
        return _authors_match(query_authors, volume_info.get("authors") or [])
    return True

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

    google_books_api_key, if given, is sent with every Google Books
    request. Google Books' own docs say public requests must carry an API
    key or access token; without one, calls fall into a shared anonymous
    quota that this library has observed fully exhausted. The key is
    never required here (Open Library needs none, and Google Books calls
    are still attempted without one), just passed through when supplied.
    offline: bool -- if True, a cache miss is treated as not found and
    never fetched, slept on, or written; `offline=True` reads the cache only.
    """

    def __init__(self, cache_dir: Path, fetch_json=None, fetch_bytes=None, sleep=None,
                 google_books_api_key: str | None = None, offline: bool = False):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.fetch_json = fetch_json or _default_fetch_json
        self.fetch_bytes = fetch_bytes or _default_fetch_bytes
        self.sleep = sleep if sleep is not None else time.sleep
        self.google_books_api_key = google_books_api_key
        # Cache-only: a miss is treated as not found and never fetched or written. Used by
        # the grouping report, which must not touch the network or the cache.
        self.offline = offline

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
        if meta.cover is None and data.get("cover_url") and not self.offline:
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
        if self.offline:
            return {"found": False}
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
        if self.google_books_api_key:
            url += "&key=" + urllib.parse.quote(self.google_books_api_key, safe="")
        resp = self._fetch_json_retrying(url)
        items = resp.get("items") if isinstance(resp, dict) else None
        if not items:
            return {"found": False}
        v = None
        best_score = -1.0
        for item in items:
            candidate = item.get("volumeInfo") or {}
            if not _is_plausible_match(title, authors, candidate):
                continue
            score = _title_score(title, candidate.get("title") or "")
            if score > best_score:
                best_score = score
                v = candidate
        if v is None:
            # Every candidate the search returned was implausible -- a
            # definitive "no match", not a transient failure, so it's
            # cached like any other genuine miss.
            return {"found": False}
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
