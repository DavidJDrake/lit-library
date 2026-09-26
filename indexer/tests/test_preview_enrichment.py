import importlib.util
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "preview-enrichment.py"


def _load_module():
    """preview-enrichment.py has a hyphen in its name, so it can't be imported normally."""
    spec = importlib.util.spec_from_file_location("preview_enrichment", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preview_enrichment = _load_module()


class Book:
    """Stand-in for ebook_indexer.models.Book -- only the fields the diff reads."""

    def __init__(self, id, title, authors=(), description=None, publisher=None,
                 year=None, subjects=()):
        self.id = id
        self.title = title
        self.authors = list(authors)
        self.description = description
        self.publisher = publisher
        self.year = year
        self.subjects = list(subjects)


def test_load_catalog_indexes_by_id(tmp_path):
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"books": [{"id": "aaaa", "title": "A"}, {"id": "bbbb", "title": "B"}]}))
    catalog = preview_enrichment.load_catalog(path)
    assert set(catalog) == {"aaaa", "bbbb"}
    assert catalog["aaaa"]["title"] == "A"


def test_load_catalog_missing_or_corrupt_is_empty(tmp_path):
    assert preview_enrichment.load_catalog(tmp_path / "missing.json") == {}
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json")
    assert preview_enrichment.load_catalog(corrupt) == {}


def test_diff_books_reports_filled_gaps_only():
    old_by_id = {
        "a": {"title": "Cyberpunk2020Corerulebook", "authors": [], "year": None,
              "publisher": None, "subjects": [], "description": None},
    }
    book = Book("a", title="Cyberpunk 2020 Core Rulebook", authors=["Mike Pondsmith"],
                description="A tabletop RPG.", publisher="R. Talsorian", year=1990,
                subjects=["Games"])
    changes, new_books = preview_enrichment.diff_books([book], old_by_id)
    assert new_books == []
    assert changes["title"] == [("a", "Cyberpunk 2020 Core Rulebook",
                                  "Cyberpunk2020Corerulebook", "Cyberpunk 2020 Core Rulebook")]
    assert changes["authors"][0][2:] == ([], ["Mike Pondsmith"])
    assert changes["year"][0][2:] == (None, 1990)
    assert changes["description"][0][2:] == (None, "A tabletop RPG.")


def test_diff_books_no_change_when_equal():
    old_by_id = {"a": {"title": "T", "authors": ["X"], "year": 2020,
                       "publisher": "P", "subjects": ["S"], "description": "D"}}
    book = Book("a", title="T", authors=["X"], description="D", publisher="P",
                year=2020, subjects=["S"])
    changes, new_books = preview_enrichment.diff_books([book], old_by_id)
    assert all(rows == [] for rows in changes.values())
    assert new_books == []


def test_diff_books_absent_from_catalog_is_a_new_book():
    book = Book("a", title="T", authors=["X"])
    changes, new_books = preview_enrichment.diff_books([book], {})
    assert all(rows == [] for rows in changes.values())
    assert [b.id for b in new_books] == ["a"]


def test_render_report_groups_by_field_and_lists_new_books():
    changes = {f: [] for f in preview_enrichment.FIELDS}
    changes["year"] = [("a", "Some Title", None, 1990)]
    report = preview_enrichment.render_report(changes, [Book("b", title="New Book")], total=2)
    assert "## Year (1)" in report
    assert "Some Title" in report and "1990" in report
    assert "## Not yet in the published catalog (1)" in report
    assert "New Book" in report


def test_cli_writes_report_offline_without_touching_out_or_added(tmp_path, make_epub):
    """End-to-end through main(): builds a tiny library offline (cache-only, no
    network) and checks it never writes added.json, covers/, or out/, and the
    review file lands where --report says."""
    root = tmp_path / "library"
    make_epub(dest=root / "Some Bundle" / "EPUB" / "a_book.epub", title="A Book",
              authors=("Author One",), with_cover=False)
    metadata = tmp_path / "metadata"
    metadata.mkdir()
    added_path = metadata / "added.json"
    config = tmp_path / "config.yaml"
    config.write_text(
        f"library_root: {root}\noutput_dir: out\nmetadata_dir: metadata\n"
        "aws_region: us-east-1\nbooks_bucket: \"\"\nsite_bucket: \"\"\n"
        "cloudfront_distribution_id: \"\"\n"
    )
    catalog = tmp_path / "published-catalog.json"
    catalog.write_text(json.dumps({"books": []}))
    report = tmp_path / "preview.md"

    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--config", str(config), "--offline",
         "--catalog", str(catalog), "--report", str(report)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert report.exists()
    assert "A Book" in report.read_text()
    assert not added_path.exists()
    assert not (tmp_path / "out").exists()
    assert not (metadata / "covers").exists()
