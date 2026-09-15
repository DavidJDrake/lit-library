import hashlib
import json
import os

import pytest

from ebook_indexer.hashes import HashCache


def test_hashes_and_reuses_unchanged_files(tmp_path):
    f = tmp_path / "book.epub"
    f.write_bytes(b"hello")
    cache_path = tmp_path / "hashes.json"
    first = HashCache(cache_path)
    assert first.sha256(f, "B/book.epub") == hashlib.sha256(b"hello").hexdigest()
    assert first.hashed == 1
    first.save()
    second = HashCache(cache_path)
    assert second.sha256(f, "B/book.epub") == hashlib.sha256(b"hello").hexdigest()
    assert second.hashed == 0


def test_rehashes_when_size_or_mtime_changes(tmp_path):
    f = tmp_path / "book.epub"
    f.write_bytes(b"one")
    cache_path = tmp_path / "hashes.json"
    c = HashCache(cache_path)
    c.sha256(f, "B/book.epub")
    c.save()
    f.write_bytes(b"two!")
    st = f.stat()
    os.utime(f, (st.st_atime, st.st_mtime + 10))
    c2 = HashCache(cache_path)
    assert c2.sha256(f, "B/book.epub") == hashlib.sha256(b"two!").hexdigest()
    assert c2.hashed == 1


def test_corrupt_cache_is_rebuilt_with_a_warning(tmp_path):
    cache_path = tmp_path / "hashes.json"
    cache_path.write_text("{not json")
    f = tmp_path / "book.epub"
    f.write_bytes(b"x")
    c = HashCache(cache_path)
    assert any("rebuilding" in w for w in c.warnings)
    assert c.sha256(f, "B/book.epub")


def test_save_drops_entries_for_files_not_seen_this_run(tmp_path):
    cache_path = tmp_path / "hashes.json"
    a, b = tmp_path / "a.epub", tmp_path / "b.epub"
    a.write_bytes(b"a")
    b.write_bytes(b"b")
    c = HashCache(cache_path)
    c.sha256(a, "B/a.epub")
    c.sha256(b, "B/b.epub")
    c.save()
    c2 = HashCache(cache_path)
    c2.sha256(a, "B/a.epub")
    c2.save()
    assert set(json.loads(cache_path.read_text())) == {"B/a.epub"}


def test_missing_file_returns_none_with_a_warning(tmp_path):
    c = HashCache(None)
    assert c.sha256(tmp_path / "gone.epub", "B/gone.epub") is None
    assert any("gone.epub" in w for w in c.warnings)


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root can read unreadable files")
def test_unreadable_file_returns_none_with_a_warning(tmp_path):
    f = tmp_path / "locked.epub"
    f.write_bytes(b"x")
    f.chmod(0)
    try:
        c = HashCache(None)
        assert c.sha256(f, "B/locked.epub") is None
        assert any("locked.epub" in w for w in c.warnings)
    finally:
        f.chmod(0o644)


def test_in_memory_cache_never_writes(tmp_path):
    f = tmp_path / "book.epub"
    f.write_bytes(b"x")
    c = HashCache(None)
    c.sha256(f, "B/book.epub")
    c.save()
    assert list(tmp_path.iterdir()) == [f]
