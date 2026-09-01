import json

from ebook_indexer.enrich import Enricher
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
