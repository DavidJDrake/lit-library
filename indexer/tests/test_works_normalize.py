from ebook_indexer.works import author_keys, edition_title_key, normalize_isbn


def test_isbn_13_passes_through_and_isbn_10_converts():
    assert normalize_isbn("978-0-306-40615-7") == "9780306406157"
    assert normalize_isbn("0306406152") == "9780306406157"
    assert normalize_isbn("030640615X") == "9780306406157"


def test_non_isbns_are_rejected():
    assert normalize_isbn(None) is None
    assert normalize_isbn("") is None
    assert normalize_isbn("http://www.gutenberg.org/2147") is None
    assert normalize_isbn("12345") is None


def test_edition_markers_are_removed():
    base = edition_title_key("Learning DevOps")
    assert base == "learningdevops"
    for variant in [
        "Learning DevOps - Second Edition",
        "Learning DevOps, 2nd Edition",
        "Learning DevOps (2nd edition)",
        "Learning DevOps (Second Edition, Revised)",
        "Learning DevOps Revised Edition",
        "Learning DevOps Edition 2",
        "Learning DevOps 2nd ed.",
        "LEARNING DEVOPS: SECOND EDITION",
    ]:
        assert edition_title_key(variant) == base, variant


def test_subtitles_are_kept():
    titles = ["Dune: The Butlerian Jihad", "Dune: The Machine Crusade", "Dune: The Battle of Corrin"]
    assert len({edition_title_key(t) for t in titles}) == 3


def test_author_strings_split_and_invert():
    assert author_keys(["MARCUS J. CAREY and JENNIFER JIN"]) & author_keys(["Marcus J. Carey"])
    assert author_keys(["Michelle Chismon; Kate Gawron"]) & author_keys(["Michelle Chismon"])
    assert author_keys(["Anderson, Kevin J."]) == author_keys(["Kevin J. Anderson"])
    assert author_keys(["Brian Herbert & Kevin J. Anderson"]) == {"brianherbert", "kevinjanderson"}
    assert author_keys(["A | B\nC"]) == {"a", "b", "c"}


def test_different_authors_do_not_overlap():
    assert not (author_keys(["Tim Lomas"]) & author_keys(["Thich Nhat Hanh"]))
    assert author_keys([]) == frozenset()
    assert author_keys(["  "]) == frozenset()
