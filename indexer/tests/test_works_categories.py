from ebook_indexer.models import Book
from ebook_indexer.works import CategoryChange, display_edition, settle_categories


def book(id, edition=None, work=None, category="Fiction", year=None, added="2026-01-01"):
    return Book(id=id, title=id, authors=[], description=None, category=category, subjects=[], publisher=None,
                bundle="B", year=year, formats=[], cover_url=None, added_at=added,
                edition_id=edition or id, work_id=work or id)


def test_display_edition_prefers_highest_year_then_latest_added_then_smallest_id():
    a = book("a", year=2019, added="2026-01-01")
    b = book("b", year=2022, added="2026-01-01")
    c = book("c", year=None, added="2026-09-01")
    assert display_edition(["a", "b", "c"], {"a": a, "b": b, "c": c}) == "b"
    d = book("d", year=2022, added="2026-03-01")
    assert display_edition(["b", "d"], {"b": b, "d": d}) == "d"
    e = book("e", year=2022, added="2026-03-01")
    assert display_edition(["e", "d"], {"d": d, "e": e}) == "d"
    assert display_edition(["c", "a"], {"a": a, "c": c}) == "a"  # a missing year sorts lowest


def test_an_override_on_any_copy_wins_and_the_work_id_copy_is_preferred():
    books = [
        book("w", work="w", category="Certification"),
        book("x", work="w", category="Security & Hacking", added="2026-02-01"),
        book("y", work="w", category="Tech & Programming", added="2026-03-01"),
    ]
    overrides = {"x": {"category": "Security & Hacking"}, "w": {"category": "Certification"}}
    changes = settle_categories(books, overrides)
    assert {b.category for b in books} == {"Certification"}
    assert changes == [CategoryChange("w", frozenset({"Certification", "Security & Hacking", "Tech & Programming"}), "Certification")]


def test_without_overrides_the_display_edition_category_wins():
    books = [
        book("old", work="old", category="Security & Hacking", year=2019),
        book("new", work="old", category="Tech & Programming", year=2022, added="2026-02-01"),
    ]
    settle_categories(books, {})
    assert {b.category for b in books} == {"Tech & Programming"}


def test_an_override_with_an_invalid_category_is_not_an_override():
    books = [book("a", work="a", category="Fiction", year=2020),
             book("b", work="a", category="Comics", year=2024, added="2026-02-01")]
    settle_categories(books, {"a": {"category": "Not A Category"}})
    assert {b.category for b in books} == {"Comics"}


def test_single_copy_and_already_consistent_works_report_no_change():
    books = [book("solo"), book("p", work="p"), book("q", work="p", added="2026-02-01")]
    assert settle_categories(books, {}) == []
