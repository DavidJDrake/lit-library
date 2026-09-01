from ebook_indexer.extract_epub import extract_epub


def test_extracts_dublin_core_fields(make_epub):
    meta = extract_epub(make_epub())
    assert meta.title == "Attacking Network Protocols"
    assert meta.authors == ["James Forshaw"]
    assert meta.description == "A deep dive into network protocol security."
    assert meta.subjects == ["Computers", "Security"]
    assert meta.publisher == "No Starch Press"
    assert meta.year == 2021
    assert meta.isbn == "9781593277505"


def test_extracts_epub2_cover(make_epub):
    meta = extract_epub(make_epub(with_cover=True))
    assert meta.cover is not None and meta.cover[:2] == b"\xff\xd8"  # JPEG magic


def test_missing_cover_is_none(make_epub):
    assert extract_epub(make_epub(with_cover=False)).cover is None


def test_corrupt_file_returns_empty_meta(tmp_path):
    bad = tmp_path / "bad.epub"
    bad.write_bytes(b"not a zip at all")
    meta = extract_epub(bad)
    assert meta.title is None and meta.authors == [] and meta.cover is None
