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


def test_indd_junk_title_falls_back_to_none(make_pdf):
    meta = extract_pdf(make_pdf(title="BlackhandsStreetWeapons2020-txt.indd"))
    assert meta.title is None


def test_untitled_junk_title_falls_back_to_none(make_pdf):
    meta = extract_pdf(make_pdf(title="untitled"))
    assert meta.title is None


def test_untitled_junk_title_is_case_insensitive(make_pdf):
    meta = extract_pdf(make_pdf(title="Untitled"))
    assert meta.title is None


def test_other_junk_suffixes_fall_back_to_none(make_pdf):
    for suffix in (".doc", ".docx", ".qxd", ".pmd", ".fm", ".tex"):
        meta = extract_pdf(make_pdf(title=f"SomeBook{suffix}"))
        assert meta.title is None, f"expected junk title rejected for {suffix}"


def test_legitimate_title_is_kept(make_pdf):
    meta = extract_pdf(make_pdf(title="Attacking Network Protocols"))
    assert meta.title == "Attacking Network Protocols"


def test_corrupt_pdf_returns_empty_meta(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a pdf")
    meta = extract_pdf(bad)
    assert meta.title is None and meta.cover is None
