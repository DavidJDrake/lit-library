import json

from ebook_indexer.enrich import Enricher, TransientFetchError
from ebook_indexer.models import ExtractedMeta

OL_ISBN_RESPONSE = {
    "ISBN:9781593277505": {
        "title": "Attacking Network Protocols",
        "authors": [{"name": "James Forshaw"}],
        "publishers": [{"name": "No Starch Press"}],
        "publish_date": "December 2017",
        "subjects": [{"name": "Computer security"}],
        "cover": {"large": "https://covers.openlibrary.org/b/id/123-L.jpg"},
    }
}

GB_RESPONSE = {
    "items": [{
        "volumeInfo": {
            "title": "Mystery Novel",
            "authors": ["A. Writer"],
            "description": "A gripping tale.",
            "publishedDate": "2019-03-01",
            "categories": ["Fiction"],
            "publisher": "Tor",
            "imageLinks": {"thumbnail": "https://books.google.com/thumb.jpg"},
        }
    }]
}


class FakeFetcher:
    def __init__(self, responses):
        self.responses = responses  # substring -> dict
        self.json_calls = []
        self.bytes_calls = []

    def json(self, url):
        self.json_calls.append(url)
        for frag, resp in self.responses.items():
            if frag in url:
                return resp
        return None

    def bytes(self, url):
        self.bytes_calls.append(url)
        return b"\xff\xd8fakejpeg"


def test_isbn_lookup_fills_missing_fields_only(tmp_path):
    fetcher = FakeFetcher({"openlibrary.org/api/books": OL_ISBN_RESPONSE})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(isbn="9781593277505", title="My Existing Title")
    e.enrich(meta, fallback_title="attacking network protocols")
    assert meta.title == "My Existing Title"          # existing field untouched
    assert meta.authors == ["James Forshaw"]           # missing field filled
    assert meta.publisher == "No Starch Press"
    assert meta.year == 2017
    assert meta.subjects == ["Computer security"]
    assert meta.cover == b"\xff\xd8fakejpeg"           # cover downloaded


def test_google_books_fallback_when_no_isbn(tmp_path):
    fetcher = FakeFetcher({"googleapis.com/books": GB_RESPONSE})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(authors=["A. Writer"])
    e.enrich(meta, fallback_title="Mystery Novel")
    assert meta.title == "Mystery Novel"
    assert meta.description == "A gripping tale."
    assert meta.year == 2019
    # Verify URL encoding uses %20 (space) for term separator, not %2B (+)
    assert any("%20inauthor" in url for url in fetcher.json_calls), \
        f"Expected %20inauthor in URLs, got: {fetcher.json_calls}"
    assert not any("%2B" in url for url in fetcher.json_calls), \
        f"URL should not contain %2B (malformed + encoding), got: {fetcher.json_calls}"


def test_cache_hit_makes_no_network_calls(tmp_path):
    fetcher = FakeFetcher({"openlibrary.org/api/books": OL_ISBN_RESPONSE})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    e.enrich(ExtractedMeta(isbn="9781593277505"), fallback_title="x")
    first_json_calls = len(fetcher.json_calls)
    e2 = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(isbn="9781593277505")
    e2.enrich(meta, fallback_title="x")
    assert len(fetcher.json_calls) == first_json_calls  # no new JSON lookups
    # (a cache hit may still fetch the cover image; only JSON lookups are cached)
    assert meta.authors == ["James Forshaw"]  # still enriched from cache


def test_corrupt_cache_file_treated_as_miss(tmp_path):
    fetcher = FakeFetcher({"openlibrary.org/api/books": OL_ISBN_RESPONSE})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(isbn="9781593277505")
    key = meta.isbn
    import hashlib
    cache_file = tmp_path / (hashlib.sha1(key.encode()).hexdigest() + ".json")
    cache_file.write_text('{"found": true, "title": "Trunc')  # truncated/corrupt
    e.enrich(meta, fallback_title="x")  # must not raise; re-fetches instead
    assert meta.authors == ["James Forshaw"]
    assert json.loads(cache_file.read_text())["found"] is True  # cache repaired


def test_null_authors_degrade_gracefully(tmp_path):
    resp = {
        "ISBN:9781593277505": {
            "title": "Attacking Network Protocols",
            "authors": None,
            "subjects": None,
        }
    }
    fetcher = FakeFetcher({"openlibrary.org/api/books": resp})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(isbn="9781593277505")
    e.enrich(meta, fallback_title="x")  # must not raise
    assert meta.title == "Attacking Network Protocols"
    assert meta.authors == []


def test_list_response_degrades_gracefully(tmp_path):
    fetcher = FakeFetcher({"openlibrary.org/api/books": [], "googleapis.com/books": ["not", "a", "dict"]})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(isbn="9781593277505")
    e.enrich(meta, fallback_title="x")  # must not raise
    assert meta.title is None


def test_total_miss_is_cached_and_harmless(tmp_path):
    fetcher = FakeFetcher({})
    e = Enricher(tmp_path, fetch_json=fetcher.json, fetch_bytes=fetcher.bytes, sleep=lambda s: None)
    meta = ExtractedMeta(title="Unknown Thing")
    e.enrich(meta, fallback_title="Unknown Thing")
    assert meta.title == "Unknown Thing"
    cached = list(tmp_path.glob("*.json"))
    assert len(cached) == 1
    assert json.loads(cached[0].read_text())["found"] is False


class ScriptedFetcher:
    """A fetch_json double where each URL fragment has its own queue of
    responses to return in order. A queued item that is an Exception
    instance is raised instead of returned, so tests can script a
    transient failure followed by a success.
    """

    def __init__(self, scripts: dict[str, list]):
        self.scripts = {frag: list(steps) for frag, steps in scripts.items()}
        self.calls: list[str] = []

    def __call__(self, url: str):
        self.calls.append(url)
        for frag, steps in self.scripts.items():
            if frag in url:
                if not steps:
                    return None
                step = steps.pop(0)
                if isinstance(step, Exception):
                    raise step
                return step
        return None


def test_transient_failure_leaves_no_cache_entry_but_genuine_miss_is_cached(tmp_path):
    # A transient failure that never resolves (exhausts all retry attempts)
    # must not poison the cache: no file should be written at all.
    transient_dir = tmp_path / "transient"
    fetcher = ScriptedFetcher({"googleapis.com/books": [TransientFetchError()] * 4})
    e = Enricher(transient_dir, fetch_json=fetcher, fetch_bytes=lambda u: None, sleep=lambda s: None)
    meta = ExtractedMeta(title="Some Book")
    e.enrich(meta, fallback_title="Some Book")
    assert meta.description is None
    assert list(transient_dir.glob("*.json")) == []

    # A genuine "the service answered and found nothing" must still be
    # cached as before, so re-runs don't re-query it forever.
    genuine_dir = tmp_path / "genuine"
    fetcher2 = ScriptedFetcher({})  # no fragments match -> every call returns None (a clean empty answer)
    e2 = Enricher(genuine_dir, fetch_json=fetcher2, fetch_bytes=lambda u: None, sleep=lambda s: None)
    meta2 = ExtractedMeta(title="Some Other Book")
    e2.enrich(meta2, fallback_title="Some Other Book")
    cached = list(genuine_dir.glob("*.json"))
    assert len(cached) == 1
    assert json.loads(cached[0].read_text())["found"] is False


def test_retry_succeeds_after_rate_limit_and_honors_retry_after(tmp_path):
    fetcher = ScriptedFetcher({
        "googleapis.com/books": [TransientFetchError(retry_after=7.5), GB_RESPONSE],
    })
    sleeps = []
    e = Enricher(tmp_path, fetch_json=fetcher, fetch_bytes=lambda u: b"cover",
                 sleep=lambda s: sleeps.append(s))
    meta = ExtractedMeta(authors=["A. Writer"])
    e.enrich(meta, fallback_title="Mystery Novel")

    assert meta.description == "A gripping tale."
    # The rate limit's Retry-After was honoured, not the default backoff.
    assert 7.5 in sleeps
    # Two lookups against the search endpoint: the failed one and the retry.
    assert sum("googleapis.com/books" in u for u in fetcher.calls) == 2
    # The eventual success is cached.
    cached = list(tmp_path.glob("*.json"))
    assert len(cached) == 1
    assert json.loads(cached[0].read_text())["found"] is True
