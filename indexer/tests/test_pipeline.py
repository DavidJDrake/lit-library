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
        root=root,
        overrides_path=tmp_path / "overrides.yaml",
        added_path=tmp_path / "added.json",
    )
    assert len(books) == 2
    paired = next(b for b in books if b.title == "Attacking Network Protocols")
    assert [f.type for f in paired.formats] == ["epub", "pdf"]
    assert paired.formats[0].s3_key == "books/Hacking by No Starch Press/EPUB/attacking_network_protocols.epub"
    assert paired.category == "Security & Hacking"
    assert paired.id in covers  # embedded epub cover captured
    assert covers[paired.id][:4] == b"RIFF"  # thumbnailed to webp inside build_books
    fiction = next(b for b in books if b.title == "The Black Company")
    assert fiction.category == "Fiction"
    assert fiction.authors == ["Glen Cook"]


def test_added_dates_are_sticky(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    added_path = tmp_path / "added.json"
    args = dict(root=root,
                overrides_path=tmp_path / "overrides.yaml", added_path=added_path)
    books1, _ = build_books(**args)
    added_path.write_text(json.dumps({b.id: "2020-01-01" for b in books1}))
    books2, _ = build_books(**args)
    assert all(b.added_at == "2020-01-01" for b in books2)


def test_corrupt_added_json_treated_as_empty(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    added_path = tmp_path / "added.json"
    added_path.write_text('{"a": "2020-01-01"')  # truncated/corrupt JSON
    books, _ = build_books(
        root=root,
        overrides_path=tmp_path / "overrides.yaml",
        added_path=added_path,
    )  # must not raise; run proceeds with fresh added-dates
    assert len(books) == 2
    assert json.loads(added_path.read_text())  # rewritten with valid JSON


def test_write_outputs_produces_catalog_and_covers(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    books, covers = build_books(
        root=root,
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


def test_identical_copies_in_two_bundles_share_an_edition_and_work(tmp_path, make_epub):
    root = tmp_path / "library"
    src = make_epub(dest=root / "Bundle One" / "EPUB" / "the_black_company.epub",
                    title="The Black Company", authors=("Glen Cook",), with_cover=False)
    dest = root / "Bundle Two" / "EPUB" / "the_black_company.epub"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(src.read_bytes())
    books, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml",
                           added_path=tmp_path / "added.json", hash_cache_path=tmp_path / "hashes.json")
    assert len(books) == 2
    assert len({b.edition_id for b in books}) == 1
    assert len({b.work_id for b in books}) == 1
    assert (tmp_path / "hashes.json").exists()
    data = json.loads(write_outputs(books, {}, tmp_path / "out").read_text())
    assert {e["workId"] for e in data["books"]} == {books[0].work_id}
    assert list(data["books"][0])[:3] == ["id", "editionId", "workId"]


def test_categories_settle_across_a_work(tmp_path, make_epub):
    root = tmp_path / "library"
    make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "linux_basics.epub",
              title="Linux Basics", authors=("Ann Author",), date="2019-01-01", isbn="9780306406157",
              description="first", with_cover=False)
    make_epub(dest=root / "Python Programming Bundle" / "EPUB" / "linux_basics.epub",
              title="Linux Basics", authors=("Ann Author",), date="2024-01-01", isbn="9781593277505",
              description="second", with_cover=False)
    captured = {}
    books, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json",
                           on_grouped=lambda g, c: captured.update(grouping=g, changes=c))
    assert len({b.work_id for b in books}) == 1
    assert len({b.edition_id for b in books}) == 2
    assert {b.category for b in books} == {"Tech & Programming"}
    assert [c.before for c in captured["changes"]] == [frozenset({"Security & Hacking", "Tech & Programming"})]


def test_catalog_carries_work_links_on_canonical_entries_only(tmp_path, make_epub):
    root = tmp_path / "library"
    first = make_epub(dest=root / "Hacking by No Starch Press" / "EPUB" / "linux_basics.epub",
                      title="Linux Basics", authors=("Ann Author",), isbn="9780306406157", with_cover=False)
    make_epub(dest=root / "Python Programming Bundle" / "EPUB" / "linux_basics.epub",
              title="Linux Basics", authors=("Ann Author",), isbn="9781593277505", with_cover=False)
    copy = root / "Security Bundle" / "EPUB" / "linux_basics.epub"
    copy.parent.mkdir(parents=True)
    copy.write_bytes(first.read_bytes())
    make_epub(dest=root / "Glen Cook" / "EPUB" / "the_black_company.epub",
              title="The Black Company", authors=("Glen Cook",), isbn="9780812521399", with_cover=False)
    (tmp_path / "overrides.yaml").write_text("")
    books, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml",
                           added_path=tmp_path / "added.json", hash_cache_path=tmp_path / "hashes.json")
    data = json.loads(write_outputs(books, {}, tmp_path / "out").read_text())
    by_title = {}
    for entry in data["books"]:
        by_title.setdefault(entry["title"], []).append(entry)
    linux = by_title["Linux Basics"]
    editions = sorted({e["editionId"] for e in linux})
    assert len(linux) == 3 and len(editions) == 2
    for entry in linux:
        if entry["id"] == entry["editionId"]:
            assert entry["workLinks"] == [e for e in editions if e != entry["id"]]
        else:
            assert "workLinks" not in entry
    assert "workLinks" not in by_title["The Black Company"][0]


def test_an_interrupted_run_keeps_the_hashes_it_computed(tmp_path, make_epub, make_pdf, monkeypatch):
    import ebook_indexer.pipeline as pipeline
    root = make_library(tmp_path, make_epub, make_pdf)
    real_extract, calls = pipeline._extract, []

    def extract_then_fail(primary):
        calls.append(primary)
        if len(calls) == 2:
            raise KeyboardInterrupt
        return real_extract(primary)

    monkeypatch.setattr(pipeline, "_extract", extract_then_fail)
    cache = tmp_path / "hashes.json"
    try:
        build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json",
                    hash_cache_path=cache)
    except KeyboardInterrupt:
        pass
    assert cache.exists() and len(json.loads(cache.read_text())) >= 1


def test_a_limited_run_does_not_prune_the_hash_cache(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    cache = tmp_path / "hashes.json"
    kwargs = dict(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json",
                  hash_cache_path=cache)
    build_books(**kwargs)
    full = set(json.loads(cache.read_text()))
    assert len(full) == 3
    build_books(**kwargs, limit=1)
    assert set(json.loads(cache.read_text())) == full


def test_write_added_false_leaves_added_json_untouched(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    added = tmp_path / "added.json"
    added.write_text("{}")
    build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=added, write_added=False)
    assert added.read_text() == "{}"


def test_with_covers_false_skips_thumbnails(tmp_path, make_epub, make_pdf):
    root = make_library(tmp_path, make_epub, make_pdf)
    _, covers = build_books(root=root, overrides_path=tmp_path / "overrides.yaml",
                            added_path=tmp_path / "added.json", with_covers=False)
    assert covers == {}


def test_work_override_in_overrides_yaml_is_honoured(tmp_path, make_epub):
    root = tmp_path / "library"
    make_epub(dest=root / "One" / "EPUB" / "t.epub", title="Title", authors=("Ann Author",), isbn="9780306406157",
              description="1", with_cover=False)
    make_epub(dest=root / "Two" / "EPUB" / "t.epub", title="Title", authors=("Ann Author",), isbn="9781593277505",
              description="2", with_cover=False)
    first, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json")
    assert len({b.work_id for b in first}) == 1
    later = max(first, key=lambda b: b.id)
    (tmp_path / "overrides.yaml").write_text(f"{later.id}:\n  work: {later.id}\n")
    second, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json")
    assert len({b.work_id for b in second}) == 2


def test_isbn_override_separates_books_that_share_a_wrong_isbn(tmp_path, make_epub):
    root = tmp_path / "library"
    make_epub(dest=root / "Devops" / "EPUB" / "docker.epub", title="Learn Docker", authors=("Ann Author",),
              isbn="9781838827472", with_cover=False)
    make_epub(dest=root / "Devops" / "EPUB" / "kubernetes.epub", title="Kubernetes on Windows", authors=("Bob Writer",),
              isbn="9781838827472", with_cover=False)
    first, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json")
    assert len({b.edition_id for b in first}) == 1  # the shared (wrong) ISBN makes them one edition
    kube = next(b for b in first if b.title == "Kubernetes on Windows")
    (tmp_path / "overrides.yaml").write_text(f"{kube.id}:\n  isbn: '9781838821562'\n")
    second, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json")
    assert len({b.edition_id for b in second}) == 2
    assert len({b.work_id for b in second}) == 2


def test_isbn_override_keys_the_enrichment_lookup(tmp_path, make_epub):
    root = tmp_path / "library"
    make_epub(dest=root / "Devops" / "EPUB" / "kubernetes.epub", title="Kubernetes on Windows", isbn="9781838827472",
              with_cover=False)
    first, _ = build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json")
    (tmp_path / "overrides.yaml").write_text(f"{first[0].id}:\n  isbn: '9781838821562'\n")

    class Recorder:
        isbns: list = []
        def enrich(self, meta, fallback_title):
            self.isbns.append(meta.isbn)

    rec = Recorder()
    build_books(root=root, overrides_path=tmp_path / "overrides.yaml", added_path=tmp_path / "added.json", enricher=rec)
    assert rec.isbns == ["9781838821562"]
