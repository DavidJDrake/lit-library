import json
from pathlib import Path

from ebook_indexer.works import CopyRecord, group_copies

FIXTURE = Path(__file__).resolve().parents[2] / "test-fixtures" / "work-corrections.json"


def copy(id, bundle="B1", title="Book", authors=("Ann Author",), formats=("epub",),
         hashes=None, isbn=None, added="2026-01-01"):
    return CopyRecord(id=id, bundle=bundle, title=title, authors=tuple(authors),
                      formats=frozenset(formats), file_hashes=frozenset(hashes or {f"h-{id}"}),
                      isbn=isbn, added_at=added)


def cards(grouping):
    by = {}
    for cid, wid in grouping.work_id.items():
        by.setdefault(wid, []).append(cid)
    return sorted(sorted(v) for v in by.values())


def test_identical_file_makes_one_edition_with_the_earliest_copy_canonical():
    g = group_copies([
        copy("b", bundle="Later", hashes={"same"}, added="2026-09-13"),
        copy("a", bundle="Earlier", hashes={"same"}, added="2026-09-04"),
    ])
    assert g.edition_id == {"a": "a", "b": "a"}
    assert g.work_id == {"a": "a", "b": "a"}
    assert any(l.rule == "identical file" for l in g.links)


def test_isbn_10_and_13_make_one_edition():
    g = group_copies([copy("a", bundle="X", isbn="0306406152"), copy("b", bundle="Y", isbn="9780306406157", title="Other")])
    assert g.edition_id["b"] == "a"


def test_one_bundles_formats_of_a_title_are_one_edition():
    g = group_copies([
        copy("e", title="Social Engineering", formats=("epub",)),
        copy("p", title="Social Engineering", formats=("pdf",)),
    ])
    assert g.edition_id["p"] == "e"
    assert any(l.rule == "bundle formats" for l in g.links)


def test_same_format_copies_of_a_title_in_one_bundle_are_not_linked_by_that_rule():
    # Several same-titled PDFs with no other format (e.g. RPG supplements) stay separate.
    g = group_copies([
        copy("p1", title="Traitor's Manual", formats=("pdf",), authors=()),
        copy("p2", title="Traitor's Manual", formats=("pdf",), authors=()),
    ])
    assert g.edition_id["p1"] != g.edition_id["p2"]


def test_editions_of_a_title_by_the_same_author_are_one_work():
    g = group_copies([
        copy("old", bundle="X", title="Learning DevOps", added="2026-01-01"),
        copy("new", bundle="Y", title="Learning DevOps - Second Edition", added="2026-02-01"),
    ])
    assert g.edition_id["new"] == "new"
    assert g.work_id == {"old": "old", "new": "old"}


def test_subtitled_novels_stay_separate():
    titles = ["Dune: The Butlerian Jihad", "Dune: The Machine Crusade", "Dune: The Battle of Corrin"]
    g = group_copies([copy(f"d{i}", bundle=f"B{i}", title=t, authors=("Brian Herbert and Kevin J. Anderson",))
                      for i, t in enumerate(titles)])
    assert len(set(g.work_id.values())) == 3


def test_same_title_with_different_authors_stays_separate():
    g = group_copies([copy("x", bundle="X", title="Happiness", authors=("Tim Lomas",)),
                      copy("y", bundle="Y", title="Happiness", authors=("Thich Nhat Hanh",))])
    assert g.work_id["x"] != g.work_id["y"]


def test_same_title_without_authors_and_different_files_stays_separate():
    g = group_copies([copy("x", bundle="X", title="Nightcity", authors=()),
                      copy("y", bundle="Y", title="Nightcity", authors=())])
    assert g.work_id["x"] != g.work_id["y"]


def test_titles_that_are_only_an_edition_marker_do_not_share_a_work_bucket():
    # edition_title_key("First Edition") == "" — an empty key must never link editions.
    g = group_copies([
        copy("x", bundle="X", title="First Edition", authors=("Ann Author",), hashes={"h-x"}),
        copy("y", bundle="Y", title="First Edition", authors=("Ann Author",), hashes={"h-y"}),
    ])
    assert g.work_id["x"] != g.work_id["y"]


def test_links_chain():
    g = group_copies([
        copy("a", bundle="X", hashes={"h1"}),
        copy("b", bundle="Y", hashes={"h1"}, isbn="9780306406157", title="Other"),
        copy("c", bundle="Z", isbn="9780306406157", title="Third"),
    ])
    assert g.edition_id == {"a": "a", "b": "a", "c": "a"}


def test_a_later_copy_joining_leaves_ids_unchanged():
    before = group_copies([copy("a", bundle="X", hashes={"h"}, added="2026-01-01")])
    after = group_copies([copy("a", bundle="X", hashes={"h"}, added="2026-01-01"),
                          copy("z", bundle="Y", hashes={"h"}, added="2026-09-13")])
    assert after.edition_id["a"] == before.edition_id["a"] == "a"
    assert after.work_id["z"] == "a"


def test_ties_break_on_smallest_id():
    g = group_copies([copy("b", bundle="X", hashes={"h"}), copy("a", bundle="Y", hashes={"h"})])
    assert g.edition_id == {"a": "a", "b": "a"}


def test_work_override_to_itself_isolates_but_keeps_edition_links():
    g = group_copies([
        copy("a", bundle="X", title="T", added="2026-01-01"),
        copy("b", bundle="Y", title="T", added="2026-01-02"),
        copy("c", bundle="Z", title="Different", hashes={"h-b"}, added="2026-01-03"),
    ], {"b": "b"})
    assert g.work_id["a"] == "a"
    assert g.work_id["b"] == "b"
    assert g.edition_id["c"] == "b"
    assert g.managed == frozenset({"b"})


def test_managed_edition_takes_no_automatic_links_in_either_direction():
    g = group_copies([
        copy("a", bundle="X", title="T", added="2026-01-01"),
        copy("b", bundle="Y", title="T", added="2026-01-02"),
        copy("c", bundle="Z", title="T", added="2026-01-03"),
    ], {"b": "b"})
    assert cards(g) == [["a", "c"], ["b"]]


def test_work_override_to_another_id_joins_that_work():
    g = group_copies([copy("a", bundle="X", title="One"), copy("b", bundle="Y", title="Two")], {"b": "a"})
    assert g.work_id["b"] == "a"
    assert any(l.rule == "work override" for l in g.links)


def test_work_override_naming_an_unknown_id_is_ignored_with_a_warning():
    g = group_copies([copy("a", title="One")], {"a": "zzzz"})
    assert g.work_id["a"] == "a"
    assert any("zzzz" in w for w in g.warnings)


def test_work_override_keyed_by_a_non_canonical_copy_applies_to_its_edition():
    g = group_copies([
        copy("a", bundle="X", title="One", added="2026-01-01"),
        copy("b", bundle="Y", title="Two", added="2026-01-02"),
        copy("b2", bundle="Z", title="Two", hashes={"h-b"}, added="2026-01-03"),
    ], {"b2": "a"})
    assert g.managed == frozenset({"b"})
    assert g.work_id == {"a": "a", "b": "a", "b2": "a"}


def test_work_override_naming_a_non_canonical_copy_joins_that_copys_work():
    g = group_copies([
        copy("a", bundle="X", title="One", added="2026-01-01"),
        copy("a2", bundle="Z", title="One", hashes={"h-a"}, added="2026-01-03"),
        copy("b", bundle="Y", title="Two", added="2026-01-02"),
    ], {"b": "a2"})
    assert g.work_id["b"] == "a"


def test_the_edition_id_override_wins_over_a_copy_id_override_whatever_their_order():
    records = [
        copy("a", bundle="X", title="One", added="2026-01-01"),
        copy("b", bundle="Y", title="Two", added="2026-01-02"),
        copy("c", bundle="W", title="Three", added="2026-01-03"),
        copy("c2", bundle="Z", title="Three", hashes={"h-c"}, added="2026-01-04"),
    ]
    for overrides in ({"c": "a", "c2": "b"}, {"c2": "b", "c": "a"}):
        assert group_copies(records, overrides).work_id["c"] == "a"


def test_among_copy_id_overrides_for_one_edition_the_smallest_key_wins():
    records = [
        copy("a", bundle="X", title="One", added="2026-01-01"),
        copy("b", bundle="Y", title="Two", added="2026-01-02"),
        copy("c", bundle="W", title="Three", added="2026-01-03"),
        copy("c2", bundle="Z", title="Three", hashes={"h-c"}, added="2026-01-04"),
        copy("c3", bundle="V", title="Three", hashes={"h-c"}, added="2026-01-05"),
    ]
    for overrides in ({"c3": "b", "c2": "a"}, {"c2": "a", "c3": "b"}):
        assert group_copies(records, overrides).work_id["c"] == "a"


def test_work_links_list_every_automatic_pair_symmetrically_and_ignore_overrides():
    g = group_copies([
        copy("a", bundle="X", title="T", added="2026-01-01"),
        copy("b", bundle="Y", title="T", added="2026-01-02"),
        copy("c", bundle="Z", title="T (2nd edition)", added="2026-01-03"),
        copy("c2", bundle="V", title="T", hashes={"h-c"}, added="2026-01-04"),
        copy("d", bundle="W", title="Other", added="2026-01-05"),
    ], {"b": "b"})
    assert g.work_links == {"a": ["b", "c"], "b": ["a", "c"], "c": ["a", "b"]}
    assert cards(g) == [["a", "c", "c2"], ["b"], ["d"]]


def test_shared_fixture_folded_overrides_give_the_recorded_cards_and_ids():
    data = json.loads(FIXTURE.read_text())
    for n, case in enumerate(data["cases"]):
        links = {frozenset(pair) for pair in case["links"]}
        for s, step in enumerate(case["steps"]):
            present = case["editions"][:step["library"]]
            records = []
            for i, e in enumerate(present):
                # Every edition shares one title; an author is shared exactly when two editions are linked.
                authors = tuple(f"Author {min(x, y)} {max(x, y)}" for x, y in (sorted(p) for p in links) if e in (x, y))
                entries = [(e, f"2026-01-01T00:00:{i:02d}")]
                entries += [(c, f"2026-01-01T00:01:{i:02d}") for c, of in case["copies"].items() if of == e]
                records += [CopyRecord(id=entry, bundle=f"bundle-{entry}", title="Same Title", authors=authors,
                                       formats=frozenset({"epub"}), file_hashes=frozenset({f"hash-{e}"}),
                                       isbn=None, added_at=added) for entry, added in entries]
            g = group_copies(records, step["rows"])
            cards_with_ids = {}
            for e in present:
                cards_with_ids.setdefault(g.work_id[e], []).append(e)
            assert cards_with_ids == step["cards"], f"case {n} step {s}"
            if step["op"]["kind"] == "publish":
                assert g.work_id == step["catalogWorkId"], f"case {n} step {s}: catalog workId"
            expected_links = {}
            for x, y in (sorted(p) for p in links):
                if x in present and y in present:
                    expected_links.setdefault(x, []).append(y)
                    expected_links.setdefault(y, []).append(x)
            assert g.work_links == {e: sorted(v) for e, v in expected_links.items()}, f"case {n} step {s}: links"
