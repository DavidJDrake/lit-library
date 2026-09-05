from pathlib import Path

from ebook_indexer.categorize import apply_overrides, derive_category, load_overrides
from ebook_indexer.models import Book


def book(**kw) -> Book:
    defaults = dict(id="abc123", title="T", authors=[], description=None,
                    category="Other/Lifestyle", subjects=[], publisher=None,
                    bundle="B", year=None, formats=[], cover_url=None,
                    added_at="2026-08-31")
    defaults.update(kw)
    return Book(**defaults)


def test_bundle_rules_win():
    assert derive_category("Hacking by No Starch Press", [], ["epub"], None) == "Security & Hacking"
    assert derive_category("Call of Cthulhu by Chaosium", [], ["pdf"], None) == "TTRPG"
    assert derive_category("All-In-One Python by Packt", [], ["epub"], None) == "Tech & Programming"
    assert derive_category("Sybex Certification Prep by Wiley", [], ["pdf"], None) == "Certification"
    assert derive_category("Robert Jordans The Wheel of Time", [], ["epub"], None) == "Fiction"


def test_public_domain_fiction_bundles_and_horror_subjects():
    assert derive_category("H. P. Lovecraft by Project Gutenberg", ["Horror tales"], ["epub"], None) == "Fiction"
    assert derive_category("Some Bundle", ["Horror tales", "Short stories"], ["epub"], None) == "Fiction"


def test_subjects_used_when_bundle_matches_nothing():
    assert derive_category("Some Bundle", ["Fiction / Fantasy"], ["epub"], None) == "Fiction"
    assert derive_category("Some Bundle", ["Computer security"], ["epub"], None) == "Security & Hacking"


def test_comic_formats_fall_back_to_comics():
    assert derive_category("Some Bundle", [], ["cbz"], None) == "Comics"
    assert derive_category("Some Bundle", [], ["zip"], "comic") == "Comics"


def test_default_category():
    assert derive_category("Live Like a Samurai by Shambhala", [], ["epub"], None) == "Other/Lifestyle"


def test_overrides_roundtrip(tmp_path):
    p = tmp_path / "overrides.yaml"
    p.write_text("abc123:\n  category: Fiction\n  title: Better Title\n")
    ov = load_overrides(p)
    b = book()
    apply_overrides(b, ov)
    assert b.category == "Fiction"
    assert b.title == "Better Title"


def test_missing_overrides_file(tmp_path):
    assert load_overrides(tmp_path / "nope.yaml") == {}


def test_string_authors_override_coerced_to_list():
    b = book()
    apply_overrides(b, {"abc123": {"authors": "Jane Doe"}})
    assert b.authors == ["Jane Doe"]


def test_invalid_category_override_is_ignored():
    b = book(category="Tech & Programming")
    apply_overrides(b, {"abc123": {"category": "Not A Real Category"}})
    assert b.category == "Tech & Programming"  # derived category kept


def test_valid_category_override_applied():
    b = book(category="Tech & Programming")
    apply_overrides(b, {"abc123": {"category": "Fiction"}})
    assert b.category == "Fiction"
