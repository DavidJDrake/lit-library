import json
from pathlib import Path

import yaml

from ebook_indexer import enrich
from ebook_indexer.cli import main
from ebook_indexer.grouping_report import render_report
from ebook_indexer.models import Book
from ebook_indexer.works import CategoryChange, Grouping, Link


def book(id, title, edition, work, authors=("Ann Author",), bundle="B", category="Fiction"):
    return Book(id=id, title=title, authors=list(authors), description=None, category=category, subjects=[],
                publisher=None, bundle=bundle, year=2020, formats=[], cover_url=None, added_at="2026-01-01",
                edition_id=edition, work_id=work)


def test_report_lists_totals_grouped_cards_settled_categories_and_titles_kept_apart():
    books = [
        book("a", "The Works, Volume 1", "a", "a", bundle="Lovecraft Circle"),
        book("b", "The Works, Volume 1", "a", "a", bundle="Poe"),
        book("h1", "Happiness", "h1", "h1", authors=("Tim Lomas",)),
        book("h2", "Happiness", "h2", "h2", authors=("Thich Nhat Hanh",)),
    ]
    grouping = Grouping(edition_id={b.id: b.edition_id for b in books}, work_id={b.id: b.work_id for b in books},
                        links=[Link("a", "b", "identical file")], managed=frozenset(), warnings=[])
    text = render_report(books, grouping, [CategoryChange("a", frozenset({"Fiction", "Comics"}), "Fiction")])
    assert "- Copies: 4" in text
    assert "- Editions: 3" in text
    assert "- Works (cards): 3" in text
    assert "The Works, Volume 1 (2 copies)" in text
    assert "| `b` | The Works, Volume 1 | Poe | Ann Author | 2020 | `a` | identical file |" in text
    assert "Comics, Fiction → Fiction" in text
    assert "Happiness" in text.split("## Same titles kept apart", 1)[1]
    assert "no author in common" in text


def write_config(tmp_path, root) -> Path:
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.safe_dump({"library_root": str(root), "output_dir": "out", "metadata_dir": "metadata",
                                   "aws_region": "us-east-1", "books_bucket": "", "site_bucket": "",
                                   "cloudfront_distribution_id": ""}))
    return cfg


def test_cli_writes_the_report_and_nothing_else(tmp_path, make_epub, monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("grouping-report touched the network")
    monkeypatch.setattr(enrich, "_default_fetch_json", boom)
    monkeypatch.setattr(enrich, "_default_fetch_bytes", boom)

    root = tmp_path / "library"
    src = make_epub(dest=root / "One" / "EPUB" / "b.epub", title="Book", with_cover=True)
    (root / "Two" / "EPUB").mkdir(parents=True)
    (root / "Two" / "EPUB" / "b.epub").write_bytes(src.read_bytes())
    cfg = write_config(tmp_path, root)

    assert main(["grouping-report", "--config", str(cfg)]) == 0

    report = (tmp_path / "out" / "grouping-report.md").read_text()
    assert "- Works (cards): 1" in report
    assert not (tmp_path / "out" / "catalog.json").exists()
    assert not (tmp_path / "out" / "covers").exists()
    assert not (tmp_path / "metadata" / "added.json").exists()
    assert not (tmp_path / "metadata" / "overrides.yaml").exists()
    cache = tmp_path / "metadata" / "cache"
    assert not cache.exists() or list(cache.iterdir()) == []
    assert json.loads((tmp_path / "metadata" / "hashes.json").read_text())
