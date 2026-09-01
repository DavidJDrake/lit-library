from ebook_indexer.extract_pdf import extract_pdf


def test_extracts_title_and_splits_authors(make_pdf):
    meta = extract_pdf(make_pdf())
    assert meta.title == "Test PDF Book"
    assert meta.authors == ["Jane Doe", "John Roe"]


def test_renders_first_page_as_png_cover(make_pdf):
    meta = extract_pdf(make_pdf())
    assert meta.cover is not None and meta.cover[:8] == b"\x89PNG\r\n\x1a\n"


def test_blank_metadata_gives_none_title(make_pdf):
    meta = extract_pdf(make_pdf(title="", author=""))
    assert meta.title is None and meta.authors == []


def test_corrupt_pdf_returns_empty_meta(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a pdf")
    meta = extract_pdf(bad)
    assert meta.title is None and meta.cover is None
