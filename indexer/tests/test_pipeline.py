import json
from pathlib import Path

from ebook_indexer.catalog import write_outputs
from ebook_indexer.pipeline import build_books, prettify


def make_library(tmp_path, make_epub, make_pdf) -> Path:
    root = tmp_path / "library"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "attacking_network_protocols.epub")
    make_pdf(dest=root / "Hacking by No Starch Press" / "PDF" / "attacking_network_protocols.pdf",
             title="Attacking Network Protocols")
    make_epub(dest=root / "Glen Cooks Chronicles of the Black Company and More" / "EPUB" / "the_black_company.epub",
              title="The Black Company", authors=("Glen Cook",),
              subjects=("Fiction",), isbn="9780812521399", with_cover=False)
    return root


def test_build_books_groups_and_extracts(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    books, covers = build_books(
        root=root, cache_dir=tmp_path / "cache",
        overrides_path=tmp_path / "overrides.yaml",
        added_path=tmp_path / "added.json",
    )
    assert len(books) == 2
    paired = next(b for b in books if b.title == "Attacking Network Protocols")
    assert [f.type for f in paired.formats] == ["epub", "pdf"]
    assert paired.formats[0].s3_key == "books/Hacking by No Starch Press/EPUB/attacking_network_protocols.epub"
    assert paired.category == "Security & Hacking"
    assert paired.id in covers  # embedded epub cover captured
    fiction = next(b for b in books if b.title == "The Black Company")
    assert fiction.category == "Fiction"
    assert fiction.authors == ["Glen Cook"]


def test_added_dates_are_sticky(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    added_path = tmp_path / "added.json"
    args = dict(root=root, cache_dir=tmp_path / "cache",
                overrides_path=tmp_path / "overrides.yaml", added_path=added_path)
    books1, _ = build_books(**args)
    added_path.write_text(json.dumps({b.id: "2020-01-01" for b in books1}))
    books2, _ = build_books(**args)
    assert all(b.added_at == "2020-01-01" for b in books2)


def test_write_outputs_produces_catalog_and_covers(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    books, covers = build_books(
        root=root, cache_dir=tmp_path / "cache",
        overrides_path=tmp_path / "overrides.yaml",
        added_path=tmp_path / "added.json",
    )
    out = tmp_path / "out"
    catalog_path = write_outputs(books, covers, out)
    data = json.loads(catalog_path.read_text())
    assert "generatedAt" in data and len(data["books"]) == 2
    entry = next(b for b in data["books"] if b["title"] == "Attacking Network Protocols")
    assert entry["coverUrl"] == f"/covers/{entry['id']}.webp"
    assert (out / "covers" / f"{entry['id']}.webp").exists()
    assert set(entry["formats"][0]) == {"type", "size", "s3Key"}
    assert "rel_path" not in json.dumps(data)


def test_prettify():
    assert prettify("attacking_network_protocols") == "Attacking Network Protocols"
    assert prettify("Already Nice Name") == "Already Nice Name"
