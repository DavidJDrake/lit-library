import zipfile

from ebook_indexer.extract_archive import classify_archive


def make_zip(tmp_path, names):
    p = tmp_path / "a.zip"
    with zipfile.ZipFile(p, "w") as zf:
        for n in names:
            zf.writestr(n, b"data")
    return p


def test_cbz_is_comic_without_opening(tmp_path):
    p = tmp_path / "missing.cbz"  # deliberately does not exist
    assert classify_archive(p, "cbz") == "comic"


def test_image_heavy_zip_is_comic(tmp_path):
    p = make_zip(tmp_path, ["p1.jpg", "p2.jpg", "p3.png", "info.txt"])
    assert classify_archive(p, "zip") == "comic"


def test_code_zip(tmp_path):
    p = make_zip(tmp_path, ["src/main.py", "src/app.js", "README.md"])
    assert classify_archive(p, "zip") == "code"


def test_books_zip(tmp_path):
    p = make_zip(tmp_path, ["one.epub", "two.mobi", "cover.jpg"])
    assert classify_archive(p, "zip") == "books"


def test_unreadable_zip_is_other(tmp_path):
    p = tmp_path / "bad.zip"
    p.write_bytes(b"junk")
    assert classify_archive(p, "zip") == "other"
