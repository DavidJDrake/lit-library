import json

import pytest

from ebook_indexer.models import ScannedFile
from ebook_indexer.publish import delete_book_objects, find_orphan_books


class FakeS3:
    """Pages like the real client so the pagination path is actually exercised."""

    def __init__(self, keys, page_size=1000):
        self.keys = list(keys)
        self.page_size = page_size
        self.deleted = []
        self.list_calls = []

    def list_objects_v2(self, **kwargs):
        self.list_calls.append(kwargs)
        start = int(kwargs.get("ContinuationToken") or 0)
        page = self.keys[start:start + self.page_size]
        end = start + len(page)
        return {
            "Contents": [{"Key": k} for k in page],
            "IsTruncated": end < len(self.keys),
            "NextContinuationToken": str(end),
        }

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)


def sf(rel: str) -> ScannedFile:
    return ScannedFile(path=f"/lib/{rel}", rel_path=rel, bundle=rel.split("/", 1)[0],
                       format="epub", size=1)


def test_reports_only_keys_with_no_matching_library_file():
    s3 = FakeS3(["books/A/keep.epub", "books/A/gone.epub", "books/.junk/stray.epub"])
    orphans = find_orphan_books(s3, "b", [sf("A/keep.epub")])
    assert orphans == ["books/.junk/stray.epub", "books/A/gone.epub"]


def test_ignores_everything_outside_the_books_prefix():
    s3 = FakeS3(["books/A/keep.epub"])
    find_orphan_books(s3, "b", [sf("A/keep.epub")])
    assert all(c["Prefix"] == "books/" for c in s3.list_calls)


def test_follows_pagination_so_a_large_library_is_not_half_checked():
    keys = [f"books/A/b{i:04d}.epub" for i in range(2500)]
    s3 = FakeS3(keys, page_size=1000)
    orphans = find_orphan_books(s3, "b", [sf("A/b0000.epub")])
    assert len(orphans) == 2499
    assert len(s3.list_calls) == 3


def test_nothing_is_orphaned_when_the_bucket_matches_the_library():
    s3 = FakeS3(["books/A/one.epub", "books/B/two.pdf"])
    assert find_orphan_books(s3, "b", [sf("A/one.epub"), sf("B/two.pdf")]) == []


def test_delete_removes_the_objects_and_forgets_them_in_the_upload_state(tmp_path):
    state = tmp_path / "publish-state.json"
    state.write_text(json.dumps({"books/A/gone.epub": 10, "books/A/keep.epub": 20}))
    s3 = FakeS3([])
    n = delete_book_objects(s3, "b", ["books/A/gone.epub"], state)
    assert n == 1
    assert s3.deleted == ["books/A/gone.epub"]
    # The surviving book must still be remembered, or the next publish re-uploads it.
    assert json.loads(state.read_text()) == {"books/A/keep.epub": 20}


def test_delete_refuses_keys_outside_books_so_the_catalogue_cannot_be_reached(tmp_path):
    state = tmp_path / "publish-state.json"
    state.write_text("{}")
    s3 = FakeS3([])
    with pytest.raises(ValueError, match="outside books/"):
        delete_book_objects(s3, "b", ["catalog.json"], state)
    assert s3.deleted == []


def test_delete_of_nothing_is_harmless(tmp_path):
    state = tmp_path / "publish-state.json"
    state.write_text(json.dumps({"books/A/keep.epub": 20}))
    s3 = FakeS3([])
    assert delete_book_objects(s3, "b", [], state) == 0
    assert json.loads(state.read_text()) == {"books/A/keep.epub": 20}
