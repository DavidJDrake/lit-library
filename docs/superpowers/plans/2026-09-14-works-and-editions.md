# Works and Editions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show one card per work — every edition of a title by the same author, however many bundles its files came from — with automatic, conservative grouping and admin merge/split/reset in the app.

**Architecture:** The indexer groups copies into editions and works and adds `editionId` and `workId` to every flat `catalog.json` entry; no existing id changes. The site groups entries into work cards, applying admin corrections (rows of `editionId → workId` in the library table) on top. `pull-edits.py` folds corrections into `work:` keys in `overrides.yaml`, which the indexer honours, so a publish and the site always agree — a property pinned by a shared, generated fixture that both the Python and TypeScript tests read.

**Tech Stack:** Python 3.12 indexer (pytest, PyYAML, pymupdf); TypeScript Lambdas on Node 22 (vitest, AWS SDK v3, CDK 2.268); React 19 + Vite web app (vitest, Testing Library, Fuse.js).

**Spec:** `docs/superpowers/specs/2026-09-14-works-and-editions-design.md`

## Global Constraints

- Every catalog entry keeps its existing `id`. New fields are `editionId` and `workId` (camelCase in `catalog.json`).
- Canonical ids: `editionId` = id of the edition's earliest-added copy (`addedAt`, then smallest `id`); `workId` = `editionId` of the work's earliest-added edition (ties: smallest `editionId`).
- Display edition: highest `year` (missing sorts lowest), then latest edition added date, then smallest `editionId`. Edition added date = its earliest copy's `addedAt`.
- Serving a format within an edition: the most recently added copy with that format (ties: smallest `id`).
- Subtitles are never removed from titles. Only these edition markers are: "Nth Edition" with digits or ordinal words first–tenth, "Revised/Updated/Expanded Edition", a parenthesised group containing "edition", "Edition N", "Nth ed.".
- Author normalisation: split on "and", "&", ";", "|", newline; one comma means "Last, First" → "First Last"; keep letters only, lowercase.
- Override key `work: <id>` is keyed by edition id and makes the edition **managed**: no automatic title-and-author links in either direction; joins the work of `<id>` unless `<id>` is itself. Edition-level links still apply.
- Library table correction rows: `pk = WORKEDIT`, `sk = <editionId>`, attributes `workId`, `by`, `at`.
- API: `PUT /api/works/edits` body `{"edits": {editionId: workId}}` (1–100 entries); `POST /api/works/edits/reset` body `{"editionIds": [...]}` (1–100, unique). Every id matches `^[0-9a-f]{16}$`. Both admin-only.
- Overlay `GET /api/library` adds `workEdits: {editionId: workId}`.
- The site treats a catalog entry without `editionId`/`workId` as its own edition and work.
- `metadata/hashes.json` is gitignored.
- **Never run `scripts/publish-new.sh`, `ebook_indexer publish`, `cdk deploy`, or any command that writes to live AWS.** Local tests only. Never publish from a git worktree.
- Tests: indexer `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q`; infra `cd infra && npx vitest run` and `npm run typecheck`; web `cd web && npx vitest run` and `npm run typecheck`. Run the full suite for every package you touched, and include its output in your report.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk
  ```
- Branch `works-and-editions`, worktree `/home/jay/projects/ebook-share/.worktrees/works-editions`.

## File map

| File | Responsibility |
|---|---|
| `scripts/gen-work-corrections-fixture.py` | Reference model of corrections; writes the shared fixture |
| `test-fixtures/work-corrections.json` | Generated cases: libraries, operations, rows and resulting cards |
| `indexer/src/ebook_indexer/works.py` | ISBN/title/author normalisation, grouping, display edition, category settling |
| `indexer/src/ebook_indexer/hashes.py` | SHA-256 cache keyed by path, size and mtime |
| `indexer/src/ebook_indexer/grouping_report.py` | Renders `out/grouping-report.md` |
| `indexer/src/ebook_indexer/models.py` | `Book` gains `edition_id`, `work_id` |
| `indexer/src/ebook_indexer/pipeline.py` | Hashing, grouping and settling inside `build_books` |
| `indexer/src/ebook_indexer/catalog.py` | Emits `editionId`, `workId` |
| `indexer/src/ebook_indexer/enrich.py` | Cache-only (`offline`) mode |
| `indexer/src/ebook_indexer/cli.py` | `grouping-report` subcommand; hash cache path for `index` |
| `scripts/pull-edits.py` | Comment-preserving writes; folds correction rows into `work` keys |
| `scripts/notify-books-added.py` | Counts new editions |
| `infra/lambda/library/{lib,index,store}.ts` | Correction routes, validation, storage, overlay field |
| `infra/lib/library.ts` | Registers the two routes |
| `infra/lambda/download/{download,opds-feed}.ts` | One OPDS publication per edition |
| `web/src/catalog/works.ts` | Effective work ids, grouping into cards, correction row builders |
| `web/src/catalog/{types,library,search}.ts` | Edition types, correction API client, search and facets over works |
| `web/src/components/{Library,BookCard,BookDetail,WorkAdminControls}.tsx`, `web/src/styles.css` | Cards, edition picker, admin controls |

---

### Task 1: Reference model and shared correction fixture

**Files:**
- Create: `scripts/gen-work-corrections-fixture.py`
- Create: `test-fixtures/work-corrections.json` (generated)
- Test: `indexer/tests/test_work_corrections_fixture.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `test-fixtures/work-corrections.json` with this shape, read by Task 3 (Python) and Task 12 (TypeScript):
  ```json
  {"version": 1, "cases": [{
    "editions": ["a", "b", "c"],
    "links": [["a", "b"], ["b", "c"]],
    "catalogWorkId": {"a": "a", "b": "a", "c": "a"},
    "steps": [{
      "op": {"kind": "split", "edition": "b"},
      "rows": {"b": "b", "c": "a"},
      "cards": [["a", "c"], ["b"]]
    }]
  }]}
  ```
  `editions` are listed in added order (index 0 is earliest). `links` are automatic title-and-author links. `op` is one of `{"kind": "merge", "from": <cardId>, "into": <cardId>}`, `{"kind": "split", "edition": <editionId>}`, `{"kind": "reset", "card": <cardId>}`. `rows` are the correction rows after the step. `cards` are sorted lists of sorted edition ids. Edition ids are single lowercase letters `a`–`j` so the indexer test can build author names from them.

- [ ] **Step 1: Write the failing test**

Create `indexer/tests/test_work_corrections_fixture.py`:

```python
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "gen-work-corrections-fixture.py"
FIXTURE = REPO / "test-fixtures" / "work-corrections.json"


def test_committed_fixture_matches_the_generator(tmp_path):
    out = tmp_path / "fixture.json"
    subprocess.run([sys.executable, str(SCRIPT), "--out", str(out)], check=True, capture_output=True, text=True)
    assert json.loads(out.read_text()) == json.loads(FIXTURE.read_text())


def test_fixture_has_the_documented_shape():
    data = json.loads(FIXTURE.read_text())
    assert data["version"] == 1
    assert len(data["cases"]) == 200
    kinds = {step["op"]["kind"] for case in data["cases"] for step in case["steps"]}
    assert kinds == {"merge", "split", "reset"}
    for case in data["cases"]:
        assert all(len(e) == 1 and "a" <= e <= "j" for e in case["editions"])
        assert set(case["catalogWorkId"]) == set(case["editions"])
        for step in case["steps"]:
            covered = sorted(e for card in step["cards"] for e in card)
            assert covered == sorted(case["editions"])


def test_known_bridge_split_case_is_recorded_correctly():
    # a-b and b-c are linked, a-c are not: splitting b must leave a and c together.
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--explain-bridge"], check=True, capture_output=True, text=True,
    )
    assert json.loads(result.stdout) == {"rows": {"b": "b", "c": "a"}, "cards": [["a", "c"], ["b"]]}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_work_corrections_fixture.py`
Expected: FAIL — the script and fixture do not exist.

- [ ] **Step 3: Write the generator**

Create `scripts/gen-work-corrections-fixture.py`:

```python
#!/usr/bin/env python3
"""Generate test-fixtures/work-corrections.json: the reference behaviour of admin work
corrections, shared by the indexer's tests and the site's tests.

Each case is a small library of editions, listed in added order, with automatic
title-and-author links between some of them, and a sequence of merge, split and reset
operations. After every operation the case records the correction rows
(editionId -> workId) and the cards those rows must produce.

Two mechanisms apply rows, and they must always agree:
  * the site follows ids: an edition's row, otherwise its catalog workId, repeatedly;
  * a publish folds each row into a managed `work` override and groups with union-find,
    where a managed edition takes no automatic links and joins its row's target.
This script refuses to write a fixture in which they ever disagree, or in which
resetting every corrected card fails to restore automatic grouping. See the spec's
"Why this model" section (docs/superpowers/specs/2026-09-14-works-and-editions-design.md).

Usage: scripts/gen-work-corrections-fixture.py [--out PATH] [--cases N] [--seed N]
       scripts/gen-work-corrections-fixture.py --explain-bridge
"""
import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LETTERS = "abcdefghij"


def components(editions, links, managed, explicit):
    parent = {e: e for e in editions}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in links:
        if a in managed or b in managed:
            continue
        parent[find(a)] = find(b)
    for a, b in explicit:
        parent[find(a)] = find(b)
    groups = {}
    for e in editions:
        groups.setdefault(find(e), []).append(e)
    return groups.values()


def catalog_work_ids(editions, links):
    out = {}
    for comp in components(editions, links, set(), []):
        first = min(comp, key=editions.index)
        for e in comp:
            out[e] = first
    return out


def effective(editions, catalog, rows):
    out = {}
    for e in editions:
        w, seen, cycle = rows.get(e, catalog[e]), {e}, False
        while True:
            nxt = rows[w] if w in rows else catalog[w]
            if nxt == w:
                break
            if nxt in seen:
                cycle = True
                break
            seen.add(w)
            w = nxt
        out[e] = catalog[e] if cycle else w
    return out


def as_cards(groups):
    return sorted(sorted(g) for g in groups)


def site_cards(editions, catalog, rows):
    by_card = {}
    for e, w in effective(editions, catalog, rows).items():
        by_card.setdefault(w, []).append(e)
    return as_cards(by_card.values())


def publish_cards(editions, links, rows):
    explicit = [(e, w) for e, w in rows.items() if w != e]
    return as_cards(components(editions, links, set(rows), explicit))


def op_merge(editions, catalog, rows, source, target):
    eff = effective(editions, catalog, rows)
    new = dict(rows)
    for e in editions:
        if eff[e] == source:
            new[e] = target
    return new


def op_split(editions, catalog, rows, edition):
    eff = effective(editions, catalog, rows)
    card = eff[edition]
    rest = [e for e in editions if eff[e] == card and e != edition]
    if not rest:
        return dict(rows)
    remainder = card if edition != card else min(rest, key=editions.index)
    new = dict(rows)
    new[edition] = edition
    if edition == card:
        new[remainder] = remainder
    for e in rest:
        if e != remainder:
            new[e] = remainder
    return new


def op_reset(editions, catalog, rows, card):
    eff = effective(editions, catalog, rows)
    members = {e for e in editions if eff[e] == card}
    autos = {catalog[e] for e in members}
    drop = members | {e for e in editions if catalog[e] in autos}
    return {e: w for e, w in rows.items() if e not in drop}


def make_case(rng):
    n = rng.randint(2, 10)
    editions = list(LETTERS[:n])
    links = [[a, b] for i, a in enumerate(editions) for b in editions[i + 1:] if rng.random() < 0.3]
    catalog = catalog_work_ids(editions, links)
    rows, steps = {}, []
    for _ in range(rng.randint(1, 8)):
        cards = sorted(set(effective(editions, catalog, rows).values()))
        roll = rng.random()
        if roll < 0.35 and len(cards) > 1:
            source, target = rng.sample(cards, 2)
            op = {"kind": "merge", "from": source, "into": target}
            rows = op_merge(editions, catalog, rows, source, target)
        elif roll < 0.7:
            edition = rng.choice(editions)
            op = {"kind": "split", "edition": edition}
            rows = op_split(editions, catalog, rows, edition)
        else:
            card = rng.choice(cards)
            op = {"kind": "reset", "card": card}
            rows = op_reset(editions, catalog, rows, card)
        site, publish = site_cards(editions, catalog, rows), publish_cards(editions, links, rows)
        if site != publish:
            raise SystemExit(f"model disagreement: {editions} {links} {rows}: site {site} publish {publish}")
        steps.append({"op": op, "rows": dict(sorted(rows.items())), "cards": site})
    restored, guard = dict(rows), 0
    while restored and guard < 50:
        first = next(iter(restored))
        restored = op_reset(editions, catalog, restored, effective(editions, catalog, restored)[first])
        guard += 1
    if restored or site_cards(editions, catalog, {}) != publish_cards(editions, links, {}):
        raise SystemExit(f"reset did not restore automatic grouping: {editions} {links}")
    return {"editions": editions, "links": links, "catalogWorkId": catalog, "steps": steps}


def generate(cases, seed):
    rng = random.Random(seed)
    made = [make_case(rng) for _ in range(cases)]
    kinds = {s["op"]["kind"] for c in made for s in c["steps"]}
    if kinds != {"merge", "split", "reset"}:
        raise SystemExit(f"fixture does not exercise every operation: {sorted(kinds)}")
    return {"version": 1, "cases": made}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "test-fixtures" / "work-corrections.json"))
    ap.add_argument("--cases", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20260914)
    ap.add_argument("--explain-bridge", action="store_true")
    args = ap.parse_args(argv[1:])

    if args.explain_bridge:
        editions, links = ["a", "b", "c"], [["a", "b"], ["b", "c"]]
        catalog = catalog_work_ids(editions, links)
        rows = op_split(editions, catalog, {}, "b")
        print(json.dumps({"rows": dict(sorted(rows.items())), "cards": site_cards(editions, catalog, rows)}))
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(generate(args.cases, args.seed), indent=1, sort_keys=True) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Generate the fixture**

Run: `cd /home/jay/projects/ebook-share/.worktrees/works-editions && python3 scripts/gen-work-corrections-fixture.py`
Expected: `wrote .../test-fixtures/work-corrections.json`, with no `model disagreement` or `reset did not restore` exit.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_work_corrections_fixture.py`
Expected: 3 passed. Then run the full indexer suite.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-work-corrections-fixture.py test-fixtures/work-corrections.json indexer/tests/test_work_corrections_fixture.py
git commit -m "test: reference model and shared fixture for work corrections

Generates the cases both the indexer and the site will be tested against,
refusing to write any case where following ids and folding into managed
overrides disagree, or where resetting fails to restore automatic grouping.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 2: Title, author and ISBN normalisation

**Files:**
- Create: `indexer/src/ebook_indexer/works.py`
- Test: `indexer/tests/test_works_normalize.py`

**Interfaces:**
- Consumes: nothing.
- Produces, in `ebook_indexer.works`:
  - `normalize_isbn(raw: str | None) -> str | None` — 13 digits, converting a valid ISBN-10; `None` if not an ISBN.
  - `edition_title_key(title: str) -> str`
  - `author_keys(authors: Iterable[str]) -> frozenset[str]`

- [ ] **Step 1: Write the failing tests**

Create `indexer/tests/test_works_normalize.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_works_normalize.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'ebook_indexer.works'`.

- [ ] **Step 3: Implement**

Create `indexer/src/ebook_indexer/works.py`:

```python
"""Groups copies into editions and editions into works.

See docs/superpowers/specs/2026-09-14-works-and-editions-design.md. A copy is one
catalog entry; an edition is copies that are the same book; a work is editions that
are the same title by the same author, shown as one card.
"""
import re
from collections.abc import Iterable

# Only explicit edition markers. Subtitles are deliberately never removed: stripping
# text after a colon merged six different Dune novels into one work.
_ORDINAL = r"\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth"
_EDITION_MARKERS = re.compile(
    r"\([^)]*\bedition\b[^)]*\)"
    rf"|\b(?:{_ORDINAL}|revised|updated|expanded)\s+edition\b"
    r"|\bedition\s+\d+\b"
    r"|\b\d+(?:st|nd|rd|th)\s+ed\b\.?",
    re.IGNORECASE,
)


def normalize_isbn(raw: str | None) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"[^0-9X]", "", raw.upper())
    if len(digits) == 13 and digits.isdigit() and digits.startswith(("978", "979")):
        return digits
    if len(digits) == 10 and digits[:9].isdigit():
        core = "978" + digits[:9]
        total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core))
        return core + str((10 - total % 10) % 10)
    return None


def edition_title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]", "", _EDITION_MARKERS.sub(" ", title.lower()))


def author_keys(authors: Iterable[str]) -> frozenset[str]:
    keys = set()
    for raw in authors:
        for part in re.split(r"\band\b|&|;|\||\n", raw, flags=re.IGNORECASE):
            part = part.strip()
            if part.count(",") == 1:
                last, first = (s.strip() for s in part.split(","))
                part = f"{first} {last}"
            key = re.sub(r"[^a-z]", "", part.lower())
            if key:
                keys.add(key)
    return frozenset(keys)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_works_normalize.py`
Expected: 6 passed. Then run the full indexer suite.

- [ ] **Step 5: Commit**

```bash
git add indexer/src/ebook_indexer/works.py indexer/tests/test_works_normalize.py
git commit -m "feat(indexer): title, author and ISBN normalisation for grouping

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 3: Grouping copies into editions and works

**Files:**
- Modify: `indexer/src/ebook_indexer/works.py`
- Test: `indexer/tests/test_works_grouping.py`

**Interfaces:**
- Consumes: `normalize_isbn`, `edition_title_key`, `author_keys` (Task 2); `test-fixtures/work-corrections.json` (Task 1).
- Produces, in `ebook_indexer.works`:
  ```python
  @dataclass(frozen=True)
  class CopyRecord:
      id: str
      bundle: str
      title: str
      authors: tuple[str, ...]
      formats: frozenset[str]
      file_hashes: frozenset[str]
      isbn: str | None
      added_at: str

  @dataclass(frozen=True)
  class Link:
      a: str
      b: str
      rule: str   # "identical file" | "isbn" | "bundle formats" | "title and author" | "work override"

  @dataclass
  class Grouping:
      edition_id: dict[str, str]    # copy id -> edition id
      work_id: dict[str, str]       # copy id -> work id
      links: list[Link]
      managed: frozenset[str]       # edition ids with a work override
      warnings: list[str]

  def group_copies(copies: list[CopyRecord], work_overrides: dict[str, str] | None = None) -> Grouping
  ```
  `work_overrides` maps an id (normally an edition id) to the `work` value from `overrides.yaml`.

- [ ] **Step 1: Write the failing tests**

Create `indexer/tests/test_works_grouping.py`:

```python
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


def test_shared_fixture_folded_overrides_give_the_recorded_cards():
    data = json.loads(FIXTURE.read_text())
    for n, case in enumerate(data["cases"]):
        editions = case["editions"]
        links = {frozenset(pair) for pair in case["links"]}
        records = []
        for i, e in enumerate(editions):
            # Every edition shares one title; an author is shared exactly when two editions are linked.
            authors = tuple(f"Author {min(x, y)} {max(x, y)}" for x, y in (tuple(p) for p in links) if e in (x, y))
            records.append(CopyRecord(id=e, bundle=f"bundle-{e}", title="Same Title", authors=authors,
                                      formats=frozenset({"epub"}), file_hashes=frozenset({f"hash-{e}"}),
                                      isbn=None, added_at=f"2026-01-01T00:00:{i:02d}"))
        assert cards(group_copies(records, {})) == sorted(
            sorted(g) for g in _groups(case["catalogWorkId"])), f"case {n}: automatic grouping"
        for s, step in enumerate(case["steps"]):
            assert cards(group_copies(records, step["rows"])) == step["cards"], f"case {n} step {s}"


def _groups(work_of):
    by = {}
    for e, w in work_of.items():
        by.setdefault(w, []).append(e)
    return by.values()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_works_grouping.py`
Expected: FAIL — `ImportError: cannot import name 'CopyRecord'`.

- [ ] **Step 3: Implement**

Append to `indexer/src/ebook_indexer/works.py` (and add `from collections import defaultdict` and `from dataclasses import dataclass` to its imports):

```python
@dataclass(frozen=True)
class CopyRecord:
    id: str
    bundle: str
    title: str
    authors: tuple[str, ...]
    formats: frozenset[str]
    file_hashes: frozenset[str]
    isbn: str | None
    added_at: str


@dataclass(frozen=True)
class Link:
    a: str
    b: str
    rule: str


@dataclass
class Grouping:
    edition_id: dict[str, str]
    work_id: dict[str, str]
    links: list[Link]
    managed: frozenset[str]
    warnings: list[str]


class _UnionFind:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.parent[ra] = rb
        return True


def _earliest(ids, added_at: dict[str, str]) -> str:
    return min(ids, key=lambda i: (added_at[i], i))


def group_copies(copies: list[CopyRecord], work_overrides: dict[str, str] | None = None) -> Grouping:
    work_overrides = work_overrides or {}
    ids = [c.id for c in copies]
    added_at = {c.id: c.added_at for c in copies}
    links: list[Link] = []
    warnings: list[str] = []

    # Editions: identical bytes, a shared ISBN, or one bundle's formats of a title.
    editions_uf = _UnionFind(ids)
    by_hash: dict[str, list[str]] = defaultdict(list)
    by_isbn: dict[str, list[str]] = defaultdict(list)
    by_bundle_title: dict[tuple[str, str], list[CopyRecord]] = defaultdict(list)
    for c in copies:
        for h in c.file_hashes:
            by_hash[h].append(c.id)
        isbn = normalize_isbn(c.isbn)
        if isbn:
            by_isbn[isbn].append(c.id)
        by_bundle_title[(c.bundle, edition_title_key(c.title))].append(c)
    for rule, buckets in (("identical file", by_hash), ("isbn", by_isbn)):
        for members in buckets.values():
            for other in members[1:]:
                if editions_uf.union(members[0], other):
                    links.append(Link(members[0], other, rule))
    for members in by_bundle_title.values():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if not (a.formats & b.formats) and editions_uf.union(a.id, b.id):
                    links.append(Link(a.id, b.id, "bundle formats"))

    edition_members: dict[str, list[str]] = defaultdict(list)
    for cid in ids:
        edition_members[editions_uf.find(cid)].append(cid)
    edition_id: dict[str, str] = {}
    for members in edition_members.values():
        canonical = _earliest(members, added_at)
        for m in members:
            edition_id[m] = canonical
    editions = sorted(set(edition_id.values()), key=lambda e: (added_at[e], e))

    # Managed editions: an override on any copy applies to that copy's edition.
    managed: dict[str, str] = {}
    for key, target in work_overrides.items():
        if key not in edition_id:
            warnings.append(f"work override on unknown id {key}; ignored")
            continue
        managed[edition_id[key]] = target

    # Works: same edition-insensitive title plus a shared author, skipping managed editions.
    works_uf = _UnionFind(editions)
    titles: dict[str, set[str]] = defaultdict(set)
    authors: dict[str, set[str]] = defaultdict(set)
    for c in copies:
        e = edition_id[c.id]
        titles[e].add(edition_title_key(c.title))
        authors[e] |= author_keys(c.authors)
    by_title: dict[str, list[str]] = defaultdict(list)
    for e in editions:
        if e not in managed:
            for t in titles[e]:
                by_title[t].append(e)
    for members in by_title.values():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if authors[a] & authors[b] and works_uf.union(a, b):
                    links.append(Link(a, b, "title and author"))
    for e, target in managed.items():
        if target == e:
            continue
        if target not in edition_id:
            warnings.append(f"work override on {e} names unknown id {target}; the edition stays its own work")
            continue
        if works_uf.union(e, edition_id[target]):
            links.append(Link(e, edition_id[target], "work override"))

    work_members: dict[str, list[str]] = defaultdict(list)
    for e in editions:
        work_members[works_uf.find(e)].append(e)
    work_of_edition: dict[str, str] = {}
    for members in work_members.values():
        canonical = _earliest(members, added_at)
        for m in members:
            work_of_edition[m] = canonical
    work_id = {cid: work_of_edition[edition_id[cid]] for cid in ids}
    return Grouping(edition_id, work_id, links, frozenset(managed), warnings)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_works_grouping.py`
Expected: 16 passed. If the fixture test fails, the grouping is wrong — never edit the fixture to match. Then run the full indexer suite.

- [ ] **Step 5: Commit**

```bash
git add indexer/src/ebook_indexer/works.py indexer/tests/test_works_grouping.py
git commit -m "feat(indexer): group copies into editions and works

Identical files, shared ISBNs and one bundle's formats make an edition;
same edition-insensitive title plus a shared author makes a work. work
overrides make an edition managed. Verified against the shared fixture.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 4: File hash cache

**Files:**
- Create: `indexer/src/ebook_indexer/hashes.py`
- Modify: `.gitignore`
- Test: `indexer/tests/test_hashes.py`

**Interfaces:**
- Consumes: `read_json_or`, `write_json_atomic` from `ebook_indexer.jsonio`.
- Produces: `class HashCache(path: Path | None)` with `sha256(file_path: Path, rel_path: str) -> str | None`, `save() -> None`, and attributes `hashed: int` (files actually read this run) and `warnings: list[str]`. `path=None` means an in-memory cache that `save()` does not write.

- [ ] **Step 1: Write the failing tests**

Create `indexer/tests/test_hashes.py`:

```python
import hashlib
import json
import os

import pytest

from ebook_indexer.hashes import HashCache


def test_hashes_and_reuses_unchanged_files(tmp_path):
    f = tmp_path / "book.epub"
    f.write_bytes(b"hello")
    cache_path = tmp_path / "hashes.json"
    first = HashCache(cache_path)
    assert first.sha256(f, "B/book.epub") == hashlib.sha256(b"hello").hexdigest()
    assert first.hashed == 1
    first.save()
    second = HashCache(cache_path)
    assert second.sha256(f, "B/book.epub") == hashlib.sha256(b"hello").hexdigest()
    assert second.hashed == 0


def test_rehashes_when_size_or_mtime_changes(tmp_path):
    f = tmp_path / "book.epub"
    f.write_bytes(b"one")
    cache_path = tmp_path / "hashes.json"
    c = HashCache(cache_path)
    c.sha256(f, "B/book.epub")
    c.save()
    f.write_bytes(b"two!")
    st = f.stat()
    os.utime(f, (st.st_atime, st.st_mtime + 10))
    c2 = HashCache(cache_path)
    assert c2.sha256(f, "B/book.epub") == hashlib.sha256(b"two!").hexdigest()
    assert c2.hashed == 1


def test_corrupt_cache_is_rebuilt_with_a_warning(tmp_path):
    cache_path = tmp_path / "hashes.json"
    cache_path.write_text("{not json")
    f = tmp_path / "book.epub"
    f.write_bytes(b"x")
    c = HashCache(cache_path)
    assert any("rebuilding" in w for w in c.warnings)
    assert c.sha256(f, "B/book.epub")


def test_save_drops_entries_for_files_not_seen_this_run(tmp_path):
    cache_path = tmp_path / "hashes.json"
    a, b = tmp_path / "a.epub", tmp_path / "b.epub"
    a.write_bytes(b"a")
    b.write_bytes(b"b")
    c = HashCache(cache_path)
    c.sha256(a, "B/a.epub")
    c.sha256(b, "B/b.epub")
    c.save()
    c2 = HashCache(cache_path)
    c2.sha256(a, "B/a.epub")
    c2.save()
    assert set(json.loads(cache_path.read_text())) == {"B/a.epub"}


def test_missing_file_returns_none_with_a_warning(tmp_path):
    c = HashCache(None)
    assert c.sha256(tmp_path / "gone.epub", "B/gone.epub") is None
    assert any("gone.epub" in w for w in c.warnings)


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root can read unreadable files")
def test_unreadable_file_returns_none_with_a_warning(tmp_path):
    f = tmp_path / "locked.epub"
    f.write_bytes(b"x")
    f.chmod(0)
    try:
        c = HashCache(None)
        assert c.sha256(f, "B/locked.epub") is None
        assert any("locked.epub" in w for w in c.warnings)
    finally:
        f.chmod(0o644)


def test_in_memory_cache_never_writes(tmp_path):
    f = tmp_path / "book.epub"
    f.write_bytes(b"x")
    c = HashCache(None)
    c.sha256(f, "B/book.epub")
    c.save()
    assert list(tmp_path.iterdir()) == [f]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_hashes.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'ebook_indexer.hashes'`.

- [ ] **Step 3: Implement**

Create `indexer/src/ebook_indexer/hashes.py`:

```python
"""SHA-256 per library file, cached by relative path, size and modification time.

Hashing the whole library (about 95 GB) on every publish would be far too slow, so a
file is re-read only when it is new or its size or mtime changed. The cache lives at
metadata/hashes.json (gitignored) and is rebuilt if unreadable.
"""
import hashlib
from pathlib import Path

from .jsonio import read_json_or, write_json_atomic

_CHUNK = 1 << 20


class HashCache:
    def __init__(self, path: Path | None):
        self.path = path
        self.hashed = 0
        self.warnings: list[str] = []
        self._entries: dict[str, dict] = {}
        self._seen: set[str] = set()
        if path is not None and path.exists():
            data = read_json_or(path, None)
            if isinstance(data, dict):
                self._entries = {k: v for k, v in data.items() if isinstance(v, dict)}
            else:
                self.warnings.append(f"{path} is unreadable; rebuilding the hash cache")

    def sha256(self, file_path: Path, rel_path: str) -> str | None:
        try:
            st = file_path.stat()
        except OSError as e:
            self.warnings.append(f"cannot read {rel_path} ({e}); it contributes no file hash")
            return None
        self._seen.add(rel_path)
        entry = self._entries.get(rel_path)
        if (entry and entry.get("size") == st.st_size and entry.get("mtime") == st.st_mtime
                and isinstance(entry.get("sha256"), str)):
            return entry["sha256"]
        digest = hashlib.sha256()
        try:
            with file_path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(_CHUNK), b""):
                    digest.update(chunk)
        except OSError as e:
            self._seen.discard(rel_path)
            self.warnings.append(f"cannot read {rel_path} ({e}); it contributes no file hash")
            return None
        self.hashed += 1
        self._entries[rel_path] = {"size": st.st_size, "mtime": st.st_mtime, "sha256": digest.hexdigest()}
        return self._entries[rel_path]["sha256"]

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, {k: v for k, v in sorted(self._entries.items()) if k in self._seen})
```

Append to `.gitignore`, directly after `metadata/publish-state.json`:

```
metadata/hashes.json
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_hashes.py`
Expected: 7 passed (or 6 passed, 1 skipped when run as root). Then run the full indexer suite.

- [ ] **Step 5: Commit**

```bash
git add indexer/src/ebook_indexer/hashes.py indexer/tests/test_hashes.py .gitignore
git commit -m "feat(indexer): cached SHA-256 per library file

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---
### Task 5: Display edition and category settling

**Files:**
- Modify: `indexer/src/ebook_indexer/models.py` (the `Book` dataclass)
- Modify: `indexer/src/ebook_indexer/works.py`
- Test: `indexer/tests/test_works_categories.py`

**Interfaces:**
- Consumes: `valid_categories(overrides)` from `ebook_indexer.categorize`.
- Produces:
  - `Book` gains `edition_id: str = ""` and `work_id: str = ""` (appended as the last fields).
  - `display_edition(edition_ids: Iterable[str], canonical: dict[str, Book]) -> str` — `canonical` maps an edition id to its canonical copy.
  - `@dataclass(frozen=True) class CategoryChange: work_id: str; before: frozenset[str]; after: str`
  - `settle_categories(books: list[Book], overrides: dict) -> list[CategoryChange]` — mutates `category` on every copy of a work; requires `edition_id` and `work_id` set; returns changes sorted by `work_id`.

- [ ] **Step 1: Write the failing tests**

Create `indexer/tests/test_works_categories.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_works_categories.py`
Expected: FAIL — `Book` has no `edition_id`, and `display_edition` does not exist.

- [ ] **Step 3: Implement**

In `indexer/src/ebook_indexer/models.py`, append two fields to the end of `Book`:

```python
    added_at: str
    edition_id: str = ""   # set by works.group_copies via pipeline.build_books
    work_id: str = ""
```

(The first line above already exists; add the two lines after it.)

Append to `indexer/src/ebook_indexer/works.py`, adding `from .categorize import valid_categories` and `from .models import Book` to the imports:

```python
def display_edition(edition_ids: Iterable[str], canonical: dict[str, Book]) -> str:
    # Stable sorts, applied last-priority first: smallest id, then latest added, then highest year.
    ordered = sorted(set(edition_ids))
    ordered.sort(key=lambda e: canonical[e].added_at, reverse=True)
    ordered.sort(key=lambda e: canonical[e].year if canonical[e].year is not None else float("-inf"), reverse=True)
    return ordered[0]


@dataclass(frozen=True)
class CategoryChange:
    work_id: str
    before: frozenset[str]
    after: str


def settle_categories(books: list[Book], overrides: dict) -> list[CategoryChange]:
    """Give every copy of a work one category. Category is a shelf, which belongs to the work."""
    valid = valid_categories(overrides)
    by_work: dict[str, list[Book]] = defaultdict(list)
    for b in books:
        by_work[b.work_id].append(b)
    changes = []
    for work_id, members in by_work.items():
        before = frozenset(b.category for b in members)
        overridden = [b for b in members
                      if isinstance(overrides.get(b.id), dict) and overrides[b.id].get("category") in valid]
        if overridden:
            category = min(overridden, key=lambda b: (b.id != work_id, b.added_at, b.id)).category
        else:
            canonical = {b.edition_id: b for b in members if b.id == b.edition_id}
            category = canonical[display_edition(canonical, canonical)].category
        for b in members:
            b.category = category
        if len(before) > 1 or category not in before:
            changes.append(CategoryChange(work_id, before, category))
    return sorted(changes, key=lambda c: c.work_id)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_works_categories.py`
Expected: 5 passed. Then run the full indexer suite (the new `Book` fields have defaults, so existing tests must still pass).

- [ ] **Step 5: Commit**

```bash
git add indexer/src/ebook_indexer/models.py indexer/src/ebook_indexer/works.py indexer/tests/test_works_categories.py
git commit -m "feat(indexer): display edition and one category per work

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 6: Grouping in the indexing pipeline and catalog

**Files:**
- Modify: `indexer/src/ebook_indexer/pipeline.py`
- Modify: `indexer/src/ebook_indexer/catalog.py` (`write_outputs`)
- Modify: `indexer/src/ebook_indexer/cli.py` (the `index` command)
- Test: `indexer/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `HashCache` (Task 4); `CopyRecord`, `Grouping`, `group_copies` (Task 3); `CategoryChange`, `settle_categories` (Task 5).
- Produces:
  ```python
  def build_books(root: Path, overrides_path: Path, added_path: Path,
                  enricher: Enricher | None = None, limit: int | None = None,
                  hash_cache_path: Path | None = None, write_added: bool = True,
                  with_covers: bool = True,
                  on_grouped: Callable[[Grouping, list[CategoryChange]], None] | None = None,
                  ) -> tuple[list[Book], dict[str, bytes]]
  ```
  Every returned `Book` has `edition_id` and `work_id` set. `catalog.json` entries gain `"editionId"` and `"workId"` immediately after `"id"`.

- [ ] **Step 1: Write the failing tests**

Append to `indexer/tests/test_pipeline.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_pipeline.py`
Expected: FAIL — `build_books()` got an unexpected keyword argument `hash_cache_path`.

- [ ] **Step 3: Implement**

Replace `build_books` in `indexer/src/ebook_indexer/pipeline.py`, and add these imports to the top of the file:

```python
import sys
from collections.abc import Callable

from .hashes import HashCache
from .works import CategoryChange, CopyRecord, Grouping, group_copies, settle_categories
```

```python
def build_books(root: Path, overrides_path: Path,
                added_path: Path, enricher: Enricher | None = None,
                limit: int | None = None, hash_cache_path: Path | None = None,
                write_added: bool = True, with_covers: bool = True,
                on_grouped: Callable[[Grouping, list[CategoryChange]], None] | None = None,
                ) -> tuple[list[Book], dict[str, bytes]]:
    groups = group_files(scan_library(root))
    overrides = load_overrides(overrides_path)
    added = read_json_or(added_path, {})
    today = date.today().isoformat()
    hash_cache = HashCache(hash_cache_path)

    books: list[Book] = []
    covers: dict[str, bytes] = {}
    isbns: dict[str, str | None] = {}
    file_hashes: dict[str, frozenset[str]] = {}
    for bid, files in sorted(groups.items(), key=lambda kv: kv[1][0].rel_path):
        if limit is not None and len(books) >= limit:
            break
        primary = files[0]  # epub-first ordering from group_files
        meta = _extract(primary)
        stem = PurePosixPath(primary.rel_path).stem
        fallback_title = prettify(stem)
        if enricher is not None:
            enricher.enrich(meta, fallback_title)
        book = Book(
            id=bid,
            title=meta.title or fallback_title,
            authors=meta.authors,
            description=meta.description,
            category=derive_category(primary.bundle, meta.subjects,
                                     [f.format for f in files], meta.archive_kind),
            subjects=meta.subjects,
            publisher=meta.publisher or _publisher_from_bundle(primary.bundle),
            bundle=primary.bundle,
            year=meta.year,
            formats=[BookFormat(type=f.format, size=f.size,
                                s3_key=f"books/{f.rel_path}", rel_path=f.rel_path)
                     for f in files],
            cover_url=None,  # set by catalog.write_outputs when a cover exists
            added_at=added.get(bid, today),
        )
        apply_overrides(book, overrides)
        isbns[bid] = meta.isbn
        file_hashes[bid] = frozenset(
            h for f in files if (h := hash_cache.sha256(f.path, f.rel_path)) is not None
        )
        if with_covers and meta.cover:
            thumb = thumbnail_webp(meta.cover)
            if thumb:
                covers[bid] = thumb
        added.setdefault(bid, today)
        books.append(book)

    # Grouping reads titles and authors after overrides, so a corrected title groups correctly.
    work_overrides = {k: str(v["work"]) for k, v in overrides.items() if isinstance(v, dict) and v.get("work")}
    grouping = group_copies([
        CopyRecord(id=b.id, bundle=b.bundle, title=b.title, authors=tuple(b.authors),
                   formats=frozenset(f.type for f in b.formats), file_hashes=file_hashes[b.id],
                   isbn=isbns[b.id], added_at=b.added_at)
        for b in books
    ], work_overrides)
    for b in books:
        b.edition_id = grouping.edition_id[b.id]
        b.work_id = grouping.work_id[b.id]
    changes = settle_categories(books, overrides)

    for warning in [*hash_cache.warnings, *grouping.warnings]:
        print(f"warning: {warning}", file=sys.stderr)
    if hash_cache.hashed:
        print(f"hashed {hash_cache.hashed} new or changed file(s)")
    hash_cache.save()
    if on_grouped is not None:
        on_grouped(grouping, changes)
    if write_added:
        write_json_atomic(added_path, added)
    return books, covers
```

In `indexer/src/ebook_indexer/catalog.py`, inside `write_outputs`, add the two fields right after `"id": b.id,`:

```python
                "id": b.id,
                "editionId": b.edition_id or b.id,
                "workId": b.work_id or b.id,
```

In `indexer/src/ebook_indexer/cli.py`, in the `index` command's `build_books(...)` call, add:

```python
            hash_cache_path=cfg.metadata_dir / "hashes.json",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_pipeline.py`
Expected: all pass, including the 5 new tests. Then run the full indexer suite.

- [ ] **Step 5: Commit**

```bash
git add indexer/src/ebook_indexer/pipeline.py indexer/src/ebook_indexer/catalog.py indexer/src/ebook_indexer/cli.py indexer/tests/test_pipeline.py
git commit -m "feat(indexer): group copies during indexing; catalog gains editionId and workId

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 7: Cache-only enrichment and the grouping report

**Files:**
- Modify: `indexer/src/ebook_indexer/enrich.py` (`Enricher.__init__`, `Enricher._cached_lookup`)
- Create: `indexer/src/ebook_indexer/grouping_report.py`
- Modify: `indexer/src/ebook_indexer/cli.py`
- Test: `indexer/tests/test_grouping_report.py`, `indexer/tests/test_enrich.py`

**Interfaces:**
- Consumes: `build_books` (Task 6); `Grouping`, `CategoryChange`, `edition_title_key`, `author_keys` (Tasks 2, 3, 5).
- Produces:
  - `Enricher(..., offline: bool = False)` — on a cache miss in offline mode, returns not-found without fetching, sleeping or writing.
  - `render_report(books: list[Book], grouping: Grouping, changes: list[CategoryChange]) -> str`
  - CLI: `ebook_indexer grouping-report --config <path>` writing `<output_dir>/grouping-report.md`.

- [ ] **Step 1: Write the failing tests**

Append to `indexer/tests/test_enrich.py`:

```python
def test_offline_enricher_never_fetches_sleeps_or_writes_on_a_cache_miss(tmp_path):
    from ebook_indexer.enrich import Enricher
    from ebook_indexer.models import ExtractedMeta

    def boom(*_args, **_kwargs):
        raise AssertionError("offline enrichment touched the network")

    sleeps = []
    enricher = Enricher(tmp_path / "cache", fetch_json=boom, fetch_bytes=boom, sleep=sleeps.append, offline=True)
    meta = ExtractedMeta()
    enricher.enrich(meta, "Some Title")
    assert meta.title is None
    assert sleeps == []
    assert list((tmp_path / "cache").iterdir()) == []
```

Create `indexer/tests/test_grouping_report.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_enrich.py tests/test_grouping_report.py`
Expected: FAIL — `Enricher` has no `offline` parameter and `ebook_indexer.grouping_report` does not exist.

- [ ] **Step 3: Implement cache-only enrichment**

In `indexer/src/ebook_indexer/enrich.py`, change `Enricher.__init__` to accept and store `offline`:

```python
    def __init__(self, cache_dir: Path, fetch_json=None, fetch_bytes=None, sleep=None,
                 google_books_api_key: str | None = None, offline: bool = False):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.fetch_json = fetch_json or _default_fetch_json
        self.fetch_bytes = fetch_bytes or _default_fetch_bytes
        self.sleep = sleep if sleep is not None else time.sleep
        self.google_books_api_key = google_books_api_key
        # Cache-only: a miss is treated as not found and never fetched or written. Used by
        # the grouping report, which must not touch the network or the cache.
        self.offline = offline
```

In `_cached_lookup`, directly after the `if cached is not None: return cached` lines, add:

```python
        if self.offline:
            return {"found": False}
```

Also add `"offline: bool"` documentation to the class docstring's last paragraph: "`offline=True` reads the cache only."

- [ ] **Step 4: Implement the report**

Create `indexer/src/ebook_indexer/grouping_report.py`:

```python
"""Renders out/grouping-report.md: a read-only preview of how copies group into cards."""
from collections import defaultdict

from .models import Book
from .works import CategoryChange, Grouping, author_keys, edition_title_key


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render_report(books: list[Book], grouping: Grouping, changes: list[CategoryChange]) -> str:
    by_id = {b.id: b for b in books}
    works: dict[str, list[Book]] = defaultdict(list)
    for b in books:
        works[b.work_id].append(b)
    rules: dict[str, set[str]] = defaultdict(set)
    for link in grouping.links:
        rules[link.a].add(link.rule)
        rules[link.b].add(link.rule)

    multi = sorted((m for m in works.values() if len(m) > 1), key=lambda m: by_id[m[0].work_id].title.lower())
    lines = [
        "# Grouping report", "",
        f"- Copies: {len(books)}",
        f"- Editions: {len({b.edition_id for b in books})}",
        f"- Works (cards): {len(works)}",
        f"- Cards grouping more than one copy: {len(multi)}",
        "",
        "## Cards that group more than one copy", "",
    ]
    if not multi:
        lines += ["None.", ""]
    for members in multi:
        lines += [f"### {_cell(by_id[members[0].work_id].title)} ({len(members)} copies)", "",
                  "| Copy | Title | Bundle | Authors | Year | Edition | Linked by |",
                  "|---|---|---|---|---|---|---|"]
        for b in sorted(members, key=lambda b: (b.edition_id, b.added_at, b.id)):
            lines.append(f"| `{b.id}` | {_cell(b.title)} | {_cell(b.bundle)} | {_cell(', '.join(b.authors))} | "
                         f"{b.year or ''} | `{b.edition_id}` | {', '.join(sorted(rules[b.id])) or '—'} |")
        lines.append("")

    lines += ["## Categories that settle", ""]
    if not changes:
        lines.append("None.")
    for c in changes:
        lines.append(f"- **{_cell(by_id[c.work_id].title)}** (`{c.work_id}`): "
                     f"{', '.join(sorted(c.before))} → {c.after}")
    lines.append("")

    lines += ["## Same titles kept apart", ""]
    canonical = [b for b in books if b.id == b.edition_id]
    by_title: dict[str, list[Book]] = defaultdict(list)
    for b in canonical:
        by_title[edition_title_key(b.title)].append(b)
    kept = 0
    for _key, editions in sorted(by_title.items()):
        if len({b.work_id for b in editions}) < 2:
            continue
        kept += 1
        if any(b.edition_id in grouping.managed for b in editions):
            reason = "an admin correction keeps them apart"
        elif any(not author_keys(b.authors) for b in editions):
            reason = "no authors to compare"
        else:
            reason = "no author in common"
        lines.append(f"- **{_cell(editions[0].title)}** — {reason}:")
        for b in sorted(editions, key=lambda b: b.work_id):
            lines.append(f"  - `{b.work_id}` {_cell(', '.join(b.authors)) or '(no authors)'} — {_cell(b.bundle)}")
    if not kept:
        lines.append("None.")
    lines.append("")
    return "\n".join(lines)
```

- [ ] **Step 5: Add the CLI subcommand**

In `indexer/src/ebook_indexer/cli.py`, add `from .grouping_report import render_report` to the imports. After the `p_prune` parser definitions, add:

```python
    p_report = sub.add_parser(
        "grouping-report",
        help="preview how copies group into cards; read-only apart from the hash cache "
             "(writes <output_dir>/grouping-report.md)",
    )
    p_report.add_argument("--config", required=True, type=Path)
```

Before the final `return 1` in `main`, add:

```python
    if args.command == "grouping-report":
        captured: dict = {}
        books, _ = build_books(
            root=cfg.library_root,
            overrides_path=cfg.metadata_dir / "overrides.yaml",
            added_path=cfg.metadata_dir / "added.json",
            enricher=Enricher(cfg.metadata_dir / "cache", offline=True),
            hash_cache_path=cfg.metadata_dir / "hashes.json",
            write_added=False,
            with_covers=False,
            on_grouped=lambda grouping, changes: captured.update(grouping=grouping, changes=changes),
        )
        cfg.output_dir.mkdir(parents=True, exist_ok=True)
        path = cfg.output_dir / "grouping-report.md"
        path.write_text(render_report(books, captured["grouping"], captured["changes"]))
        editions = len({b.edition_id for b in books})
        works = len({b.work_id for b in books})
        print(f"{len(books)} copies -> {editions} editions -> {works} cards; wrote {path}")
        return 0
```

`Enricher(...)` creates the cache directory if it is missing; that is not a cache entry, and the test allows it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_enrich.py tests/test_grouping_report.py`
Expected: all pass. Then run the full indexer suite.

- [ ] **Step 7: Commit**

```bash
git add indexer/src/ebook_indexer/enrich.py indexer/src/ebook_indexer/grouping_report.py indexer/src/ebook_indexer/cli.py indexer/tests/test_enrich.py indexer/tests/test_grouping_report.py
git commit -m "feat(indexer): read-only grouping report with cache-only enrichment

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 8: pull-edits.py keeps comments and folds work corrections

**Files:**
- Modify: `scripts/pull-edits.py`
- Test: `indexer/tests/test_pull_edits.py`

**Interfaces:**
- Consumes: `WORKEDIT` rows (`pk`, `sk` = edition id, `workId`, `by`, `at`) as written by Task 10.
- Produces, in `scripts/pull-edits.py`:
  - `top_level_chunks(text: str) -> list[tuple[str | None, str]]`
  - `render_entry(key: str, value) -> str`
  - `rewrite(text: str, merged: dict) -> str` — changes only entries whose parsed value differs; removes deleted entries; appends new ones; everything else byte-for-byte.
  - `merge(overrides: dict, items: list[dict]) -> tuple[dict, list[str], dict[str, str], dict[str, str]]` — the fourth element maps edition id to work id for every `WORKEDIT` row.

- [ ] **Step 1: Write the failing tests**

In `indexer/tests/test_pull_edits.py`, **delete** `test_warns_about_and_drops_comments_below_the_header` (the behaviour it pinned is being removed) and append:

```python
def test_keeps_comments_order_and_untouched_entries(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    overrides.write_text(
        HEADER
        + "zzzz:\n  year: 1999\n"
        + "\n# --- A section note that must survive ---\n"
        + "aaaa:\n  title: Keep Me\n  category: Fiction\n"
        + "bbbb:\n  description: 'first line\n\n    after a blank line'\n  year: 1999\n"
    )
    run(cfg, scan_file)
    text = overrides.read_text()
    assert text.startswith(HEADER)
    assert "# --- A section note that must survive ---" in text
    assert text.index("zzzz:") < text.index("# --- A section note") < text.index("aaaa:") < text.index("bbbb:")
    assert "bbbb:\n  description: 'first line\n\n    after a blank line'\n  year: 1999\n" in text
    data = yaml.safe_load(text)
    assert data["aaaa"]["category"] == "Cookbooks"
    assert data["zzzz"]["category"] == "Fiction"


def test_folds_work_corrections_and_removes_stale_work_keys(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    overrides.write_text(HEADER + "aaaa:\n  title: Keep Me\n  work: old\nbbbb:\n  work: gone\n")
    items = json.loads(scan_file.read_text())["Items"] + [
        {"pk": s("WORKEDIT"), "sk": s("aaaa"), "workId": s("cccc"), "by": s("u@x"), "at": s("t")},
        {"pk": s("WORKEDIT"), "sk": s("dddd"), "workId": s("dddd"), "by": s("u@x"), "at": s("t")},
    ]
    scan_file.write_text(json.dumps(scan(items)))
    out = run(cfg, scan_file)
    data = yaml.safe_load(overrides.read_text())
    assert data["aaaa"]["work"] == "cccc"
    assert data["aaaa"]["title"] == "Keep Me"
    assert "bbbb" not in data
    assert data["dddd"] == {"work": "dddd"}
    assert "2 work corrections" in out


def test_unchanged_file_is_not_rewritten(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    run(cfg, scan_file)
    first = overrides.read_text()
    out = run(cfg, scan_file)
    assert overrides.read_text() == first
    assert "already up to date" in out
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_pull_edits.py`
Expected: FAIL — the section comment is dropped, `work` rows are ignored, and no "already up to date" message exists.

- [ ] **Step 3: Implement**

In `scripts/pull-edits.py`:

1. Update the module docstring's third sentence to: "It updates only the entries that changed, so comments, section notes and entry order in overrides.yaml survive. Admin work corrections become `work:` keys, and a `work:` key with no correction row is removed, so corrections belong in the app, not in the file." Add `import re` to the imports.

2. Delete `split_header` and `dropped_comments`, and add:

```python
_TOP_KEY = re.compile(r"""^(?P<q>['"]?)(?P<key>[^\s'"#:][^:]*?)(?P=q):(?:[ \t]|$)""")


def _is_continuation(line: str) -> bool:
    return line[:1] in (" ", "\t") or line.startswith("- ")


def top_level_chunks(text: str) -> list[tuple[str | None, str]]:
    """Split overrides.yaml into ordered chunks: (key, text) for one top-level entry with its
    indented lines and list items, or (None, text) for what lies between entries — the header,
    blank lines, section comments. Blank lines followed by more of an entry belong to the
    entry, because a multi-line quoted value can contain them."""
    chunks: list[list] = []
    blanks: list[str] = []

    def gap(lines: list[str]) -> None:
        if chunks and chunks[-1][0] is None:
            chunks[-1][1] += "".join(lines)
        else:
            chunks.append([None, "".join(lines)])

    for line in text.splitlines(keepends=True):
        match = _TOP_KEY.match(line)
        if match and not line.startswith(("#", " ", "\t", "- ")):
            if blanks:
                gap(blanks)
                blanks = []
            chunks.append([match.group("key"), line])
        elif not line.strip():
            blanks.append(line)
        elif _is_continuation(line) and chunks and chunks[-1][0] is not None:
            chunks[-1][1] += "".join(blanks) + line
            blanks = []
        else:
            if blanks:
                gap(blanks)
                blanks = []
            gap([line])
    if blanks:
        gap(blanks)
    return [(key, body) for key, body in chunks]


def render_entry(key: str, value) -> str:
    return yaml.safe_dump({key: value}, allow_unicode=True, sort_keys=True, width=100)


def rewrite(text: str, merged: dict) -> str:
    parsed = yaml.safe_load(text) or {}
    out: list[str] = []
    present: set[str] = set()
    for key, chunk in top_level_chunks(text):
        if key is None:
            out.append(chunk)
            continue
        present.add(key)
        if key not in merged:
            continue
        out.append(chunk if merged[key] == parsed.get(key) else render_entry(key, merged[key]))
    new_keys = [k for k in merged if k not in present]
    if new_keys:
        if out and not "".join(out).endswith("\n"):
            out.append("\n")
        out.extend(render_entry(k, merged[k]) for k in sorted(new_keys, key=str))
    return "".join(out)
```

3. Replace `merge` with:

```python
def merge(overrides: dict, items: list[dict]) -> tuple[dict, list[str], dict[str, str], dict[str, str]]:
    site_categories = sorted(
        i["sk"] for i in items if i.get("pk") == "CATEGORY" and i["sk"] not in BUILTIN_CATEGORIES
    )
    books = {}
    for i in items:
        if i.get("pk") != "BOOK":
            continue
        category = i.get("category")
        if category is None:
            print(f"warning: BOOK {i.get('sk')} has no category; skipped", file=sys.stderr)
            continue
        books[i["sk"]] = category
    work_rows = {i["sk"]: i["workId"] for i in items if i.get("pk") == "WORKEDIT" and i.get("workId")}

    merged = dict(overrides)
    if site_categories:
        merged["categories"] = site_categories
    else:
        merged.pop("categories", None)
    for book_id, category in books.items():
        entry = dict(merged.get(book_id) or {})
        entry["category"] = category
        merged[book_id] = entry
    # The app owns work keys: a key with no correction row was reset in the app.
    for key in list(merged):
        entry = merged[key]
        if isinstance(entry, dict) and "work" in entry and key not in work_rows:
            remaining = {k: v for k, v in entry.items() if k != "work"}
            if remaining:
                merged[key] = remaining
            else:
                del merged[key]
    for edition_id, work_id in work_rows.items():
        entry = dict(merged.get(edition_id) or {})
        entry["work"] = work_id
        merged[edition_id] = entry
    return merged, site_categories, books, work_rows
```

4. In `main`, replace everything from `overrides_path = cfg.metadata_dir / "overrides.yaml"` to the end of the function with:

```python
    overrides_path = cfg.metadata_dir / "overrides.yaml"
    text = overrides_path.read_text() if overrides_path.exists() else ""
    existing = yaml.safe_load(text) or {}
    merged, site_categories, books, work_rows = merge(existing, items)

    catalog_path = cfg.output_dir / "catalog.json"
    if catalog_path.exists():
        known = {b["id"] for b in json.loads(catalog_path.read_text())["books"]}
        for book_id, category in sorted(books.items()):
            if book_id not in known:
                print(f"orphan: {book_id} ({category})")
        for edition_id, work_id in sorted(work_rows.items()):
            if edition_id not in known:
                print(f"orphan: {edition_id} (work {work_id})")

    print(f"merged {len(books)} book categories, {len(site_categories)} site categories, "
          f"{len(work_rows)} work corrections")
    if args.dry_run:
        return 0
    new_text = rewrite(text, merged)
    if new_text == text:
        print(f"{overrides_path} already up to date")
        return 0
    overrides_path.write_text(new_text)
    print(f"wrote {overrides_path}")
    return 0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_pull_edits.py`
Expected: all pass. If an existing test asserted the old exact summary line, it still matches on its prefix ("merged N book categories, M site categories"); if one asserted `wrote` on a no-op run, update it to expect "already up to date" and say so in your report. Then run the full indexer suite.

- [ ] **Step 5: Commit**

```bash
git add scripts/pull-edits.py indexer/tests/test_pull_edits.py
git commit -m "feat(scripts): pull-edits keeps comments and folds work corrections

Rewrites only the entries that changed, so section notes in overrides.yaml
survive. Admin work corrections become work: keys, and a work: key with no
correction row is removed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 9: New-books notification counts new editions

**Files:**
- Modify: `scripts/notify-books-added.py`
- Test: `indexer/tests/test_notify_books_added.py`

**Interfaces:**
- Consumes: `catalog.json` entries with `id` and `editionId` (Task 6).
- Produces, in `scripts/notify-books-added.py`:
  - `new_edition_ids(new_ids: list[str], catalog_books: list | None) -> list[str]`
  - `load_catalog_books(path: str, explicit: bool) -> list | None`
  - CLI option `--catalog PATH` (default `<repo>/out/catalog.json`).

- [ ] **Step 1: Write the failing tests**

Append to `indexer/tests/test_notify_books_added.py`:

```python
def test_new_edition_ids_skip_copies_joining_existing_editions():
    m = load_module()
    books = [{"id": "old", "editionId": "old"}, {"id": "copy", "editionId": "old"}, {"id": "new", "editionId": "new"}]
    assert m.new_edition_ids(["copy", "new"], books) == ["new"]
    assert m.new_edition_ids(["copy", "new"], None) == ["copy", "new"]
    assert m.new_edition_ids(["unlisted"], books) == ["unlisted"]


def test_dry_run_counts_editions_from_the_catalog(tmp_path):
    cat = tmp_path / "catalog.json"
    cat.write_text(json.dumps({"books": [
        {"id": "old", "editionId": "old"}, {"id": "copy", "editionId": "old"}, {"id": "new", "editionId": "new"}]}))
    r = run(tmp_path, {"old": "x"}, {"old": "x", "copy": "y", "new": "y"}, "--dry-run", "--catalog", str(cat))
    assert r.returncode == 0
    payload = json.loads(r.stdout)
    assert payload["count"] == 1
    assert payload["bookIds"] == ["new"]


def test_only_joining_copies_means_nothing_to_notify(tmp_path):
    cat = tmp_path / "catalog.json"
    cat.write_text(json.dumps({"books": [{"id": "old", "editionId": "old"}, {"id": "copy", "editionId": "old"}]}))
    r = run(tmp_path, {"old": "x"}, {"old": "x", "copy": "y"}, "--dry-run", "--catalog", str(cat))
    assert r.returncode == 0
    assert "no new editions (1 new copy joined existing editions); nothing to notify" in r.stdout


def test_an_unreadable_catalog_counts_every_new_copy_with_a_warning(tmp_path):
    bad = tmp_path / "catalog.json"
    bad.write_text("{nope")
    r = run(tmp_path, {}, {"a": "y", "b": "y"}, "--dry-run", "--catalog", str(bad))
    assert r.returncode == 0
    assert json.loads(r.stdout)["count"] == 2
    assert "warning" in r.stderr
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_notify_books_added.py`
Expected: FAIL — `new_edition_ids` does not exist and `--catalog` is not an option.

- [ ] **Step 3: Implement**

In `scripts/notify-books-added.py`:

1. In the docstring, replace "Computes which book ids are new (added.json keys now vs. a snapshot taken before the run)" with "Computes which books are new: added.json keys now vs. a snapshot taken before the run, counting only copies that start a new edition (catalog.json editionId equals the id), since a copy joining an existing edition is not news". Add `[--catalog out/catalog.json]` to the usage line.

2. Add after `new_book_ids`:

```python
def new_edition_ids(new_ids: list[str], catalog_books: list | None) -> list[str]:
    """New copies that start a new edition. A copy that joined an existing edition carries
    that edition's older id. Without a catalog, every new copy counts."""
    if catalog_books is None:
        return new_ids
    edition_of = {b["id"]: b.get("editionId", b["id"]) for b in catalog_books if isinstance(b, dict) and "id" in b}
    return [i for i in new_ids if edition_of.get(i, i) == i]


def load_catalog_books(path: str, explicit: bool) -> list | None:
    p = Path(path)
    if not p.exists() and not explicit:
        return None
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        warn(f"could not read {path} ({e}); counting every new copy")
        return None
    books = data.get("books") if isinstance(data, dict) else None
    if not isinstance(books, list):
        warn(f"{path} has no books list; counting every new copy")
        return None
    return books
```

3. In `main`, add the argument after `--added`:

```python
    ap.add_argument("--catalog", help="catalog.json to tell new editions from new copies (default: out/catalog.json)")
```

and replace the block from `ids = new_book_ids(before, added)` through `payload = build_payload(ids)` with:

```python
    ids = new_book_ids(before, added)
    if not ids:
        print("no new books; nothing to notify")
        return 0
    catalog_books = load_catalog_books(args.catalog or str(ROOT / "out" / "catalog.json"), explicit=bool(args.catalog))
    editions = new_edition_ids(ids, catalog_books)
    if not editions:
        copies = "copy" if len(ids) == 1 else "copies"
        print(f"no new editions ({len(ids)} new {copies} joined existing editions); nothing to notify")
        return 0
    payload = build_payload(editions)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd indexer && /home/jay/projects/ebook-share/indexer/.venv/bin/python -m pytest -q tests/test_notify_books_added.py`
Expected: all pass, including the existing tests (which pass no `--catalog`). Then run the full indexer suite.

- [ ] **Step 5: Commit**

```bash
git add scripts/notify-books-added.py indexer/tests/test_notify_books_added.py
git commit -m "feat(scripts): books-added notification counts new editions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---
### Task 10: Correction routes on the library Lambda

**Files:**
- Modify: `infra/lambda/library/lib.ts`
- Modify: `infra/lambda/library/index.ts`
- Modify: `infra/lambda/library/store.ts`
- Modify: `infra/lib/library.ts`
- Test: `infra/test/library-handler.test.ts`, `infra/test/library-store.test.ts`, `infra/test/library.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - In `lib.ts`: `EDITION_ID_RE`, `MAX_WORK_EDITS = 100`, `parseWorkEdits(body): Record<string, string> | undefined`, `parseEditionIds(body): string[] | undefined`; `Route` gains `{ kind: "putWorkEdits" }` and `{ kind: "resetWorkEdits" }`, both in `ADMIN_ROUTES`.
  - In `index.ts`: `export interface WorkEdit { editionId: string; workId: string; by: string; at: string }`; `Store` gains `listWorkEdits(): Promise<WorkEdit[]>`, `putWorkEdits(edits: WorkEdit[]): Promise<void>`, `deleteWorkEdits(editionIds: string[]): Promise<void>`; the overlay response gains `workEdits: Record<string, string>`.
  - HTTP: `PUT /api/works/edits` and `POST /api/works/edits/reset`, each 204 on success.

- [ ] **Step 1: Write the failing handler tests**

In `infra/test/library-handler.test.ts`, add the three new methods to the `store()` helper's returned object (before `...over`):

```ts
    listWorkEdits: vi.fn().mockResolvedValue([{ editionId: "aaaaaaaaaaaaaaaa", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW }]),
    putWorkEdits: vi.fn().mockResolvedValue(undefined),
    deleteWorkEdits: vi.fn().mockResolvedValue(undefined),
```

Then append:

```ts
const ADMIN = { email: "admin@x", "cognito:groups": ["admins"] };
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("work corrections", () => {
  it("includes workEdits in the overlay", async () => {
    const res = await handle(event("GET", "/api/library"), deps());
    expect(JSON.parse((res as { body: string }).body).workEdits).toEqual({ [A]: B });
  });

  it("stores every edit in one call, stamped with the admin and time", async () => {
    const s = store();
    const res = await handle(event("PUT", "/api/works/edits", { edits: { [A]: B, [B]: B } }, ADMIN), deps(s));
    expect((res as { statusCode: number }).statusCode).toBe(204);
    expect(s.putWorkEdits).toHaveBeenCalledTimes(1);
    expect(s.putWorkEdits).toHaveBeenCalledWith([
      { editionId: A, workId: B, by: "admin@x", at: NOW },
      { editionId: B, workId: B, by: "admin@x", at: NOW },
    ]);
  });

  it("deletes the rows named in a reset", async () => {
    const s = store();
    const res = await handle(event("POST", "/api/works/edits/reset", { editionIds: [A, B] }, ADMIN), deps(s));
    expect((res as { statusCode: number }).statusCode).toBe(204);
    expect(s.deleteWorkEdits).toHaveBeenCalledWith([A, B]);
  });

  it.each([
    ["no body", undefined],
    ["edits not an object", { edits: [A] }],
    ["empty edits", { edits: {} }],
    ["bad edition id", { edits: { "not-hex": B } }],
    ["bad work id", { edits: { [A]: "ZZZZZZZZZZZZZZZZ" } }],
    ["too many", { edits: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i.toString(16).padStart(16, "0"), B])) }],
  ])("rejects an invalid edit request (%s)", async (_name, body) => {
    const s = store();
    const res = await handle(event("PUT", "/api/works/edits", body, ADMIN), deps(s));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(s.putWorkEdits).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["not an array", { editionIds: A }],
    ["empty", { editionIds: [] }],
    ["duplicate", { editionIds: [A, A] }],
    ["bad id", { editionIds: ["nope"] }],
  ])("rejects an invalid reset request (%s)", async (_name, body) => {
    const s = store();
    const res = await handle(event("POST", "/api/works/edits/reset", body, ADMIN), deps(s));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(s.deleteWorkEdits).not.toHaveBeenCalled();
  });

  it("refuses non-admins", async () => {
    const s = store();
    const put = await handle(event("PUT", "/api/works/edits", { edits: { [A]: B } }), deps(s));
    const reset = await handle(event("POST", "/api/works/edits/reset", { editionIds: [A] }), deps(s));
    expect((put as { statusCode: number }).statusCode).toBe(403);
    expect((reset as { statusCode: number }).statusCode).toBe(403);
    expect(s.putWorkEdits).not.toHaveBeenCalled();
    expect(s.deleteWorkEdits).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing store tests**

Append to `infra/test/library-store.test.ts`:

```ts
describe("DynamoStore work edits", () => {
  it("lists WORKEDIT rows", async () => {
    const { ddb, send } = client(() => ({ Items: [{ pk: "WORKEDIT", sk: "aaaaaaaaaaaaaaaa", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW }] }));
    const out = await new DynamoStore(ddb, "T").listWorkEdits();
    expect(out).toEqual([{ editionId: "aaaaaaaaaaaaaaaa", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW }]);
    expect((send.mock.calls[0][0] as QueryCommand).input.ExpressionAttributeValues).toEqual({ ":pk": "WORKEDIT" });
  });

  it("writes every edit in one transaction", async () => {
    const { ddb, send } = client(() => ({}));
    await new DynamoStore(ddb, "T").putWorkEdits([
      { editionId: "aaaaaaaaaaaaaaaa", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW },
      { editionId: "bbbbbbbbbbbbbbbb", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as TransactWriteCommand;
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    expect(cmd.input.TransactItems).toEqual([
      { Put: { TableName: "T", Item: { pk: "WORKEDIT", sk: "aaaaaaaaaaaaaaaa", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW } } },
      { Put: { TableName: "T", Item: { pk: "WORKEDIT", sk: "bbbbbbbbbbbbbbbb", workId: "bbbbbbbbbbbbbbbb", by: "a@x", at: NOW } } },
    ]);
  });

  it("deletes the named rows in one transaction", async () => {
    const { ddb, send } = client(() => ({}));
    await new DynamoStore(ddb, "T").deleteWorkEdits(["aaaaaaaaaaaaaaaa"]);
    const cmd = send.mock.calls[0][0] as TransactWriteCommand;
    expect(cmd.input.TransactItems).toEqual([{ Delete: { TableName: "T", Key: { pk: "WORKEDIT", sk: "aaaaaaaaaaaaaaaa" } } }]);
  });
});
```

If an existing overlay test in `library-handler.test.ts` compares the whole response body with `toEqual`, add `workEdits: { aaaaaaaaaaaaaaaa: "bbbbbbbbbbbbbbbb" }` to its expected object — the mock above now returns that edit. Say so in your report.

In `infra/test/library.test.ts`, change `t.resourceCountIs("AWS::ApiGatewayV2::Route", 10)` to `12`, and add `"PUT /api/works/edits"` and `"POST /api/works/edits/reset"` to the list of route keys that test iterates over (the loop around line 76).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd infra && npx vitest run test/library-handler.test.ts test/library-store.test.ts test/library.test.ts`
Expected: FAIL — the routes return 404, the store methods do not exist, and the construct has 10 routes.

- [ ] **Step 4: Implement `lib.ts`**

In `infra/lambda/library/lib.ts`, add to the `Route` union:

```ts
  | { kind: "putWorkEdits" }
  | { kind: "resetWorkEdits" }
```

Replace the `ADMIN_ROUTES` line with:

```ts
export const ADMIN_ROUTES: ReadonlySet<Route["kind"]> = new Set(["createCategory", "accept", "reject", "putWorkEdits", "resetWorkEdits"]);
```

Add to the `ROUTES` array:

```ts
  ["PUT", /^\/api\/works\/edits$/, () => ({ kind: "putWorkEdits" })],
  ["POST", /^\/api\/works\/edits\/reset$/, () => ({ kind: "resetWorkEdits" })],
```

Append:

```ts
// An edition id is a catalog copy id: the first 16 hex characters of a SHA-1.
export const EDITION_ID_RE = /^[0-9a-f]{16}$/;
export const MAX_WORK_EDITS = 100; // one DynamoDB transaction holds at most 100 items

export function parseWorkEdits(body: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const edits = body?.edits;
  if (typeof edits !== "object" || edits === null || Array.isArray(edits)) return undefined;
  const entries = Object.entries(edits);
  if (entries.length === 0 || entries.length > MAX_WORK_EDITS) return undefined;
  for (const [editionId, workId] of entries) {
    if (!EDITION_ID_RE.test(editionId) || typeof workId !== "string" || !EDITION_ID_RE.test(workId)) return undefined;
  }
  return edits as Record<string, string>;
}

export function parseEditionIds(body: Record<string, unknown> | undefined): string[] | undefined {
  const ids = body?.editionIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_WORK_EDITS) return undefined;
  if (!ids.every((id) => typeof id === "string" && EDITION_ID_RE.test(id))) return undefined;
  if (new Set(ids).size !== ids.length) return undefined;
  return ids as string[];
}
```

- [ ] **Step 5: Implement `index.ts`**

In `infra/lambda/library/index.ts`:

1. Extend the `lib` import to include `parseEditionIds, parseWorkEdits`.
2. After the `OpdsTokenStatus` interface, add:

```ts
// An admin correction assigning an edition to a work (docs/superpowers/specs/2026-09-14-works-and-editions-design.md).
export interface WorkEdit { editionId: string; workId: string; by: string; at: string }
```

3. Add to the `Store` interface:

```ts
  listWorkEdits(): Promise<WorkEdit[]>;
  /** One transaction: every row written, or none. */
  putWorkEdits(edits: WorkEdit[]): Promise<void>;
  /** One transaction; deleting a row that does not exist is not an error. */
  deleteWorkEdits(editionIds: string[]): Promise<void>;
```

4. In the `overlay` case, add `store.listWorkEdits()` as the last element of the `Promise.all` array, destructure it as `workEdits`, and add to the JSON body:

```ts
        workEdits: Object.fromEntries(workEdits.map((e) => [e.editionId, e.workId])),
```

5. Add two cases to `dispatch`:

```ts
    case "putWorkEdits": {
      const edits = parseWorkEdits(parseJsonBody(event.body));
      if (!edits) return json(400, { error: "Invalid work edits" });
      await store.putWorkEdits(Object.entries(edits).map(([editionId, workId]) => ({ editionId, workId, by: email, at })));
      logEvent("works.edited", { by: email, count: Object.keys(edits).length }, deps.now);
      return noContent();
    }
    case "resetWorkEdits": {
      const editionIds = parseEditionIds(parseJsonBody(event.body));
      if (!editionIds) return json(400, { error: "Invalid edition ids" });
      await store.deleteWorkEdits(editionIds);
      logEvent("works.reset", { by: email, count: editionIds.length }, deps.now);
      return noContent();
    }
```

- [ ] **Step 6: Implement `store.ts`**

In `infra/lambda/library/store.ts`, add `WorkEdit` to the type import from `./index`, add after `toSuggestion`:

```ts
function toWorkEdit(i: Item): WorkEdit {
  return { editionId: String(i.sk), workId: String(i.workId), by: String(i.by), at: String(i.at) };
}
```

and add these methods to `DynamoStore`:

```ts
  async listWorkEdits() { return (await this.queryAll("WORKEDIT")).map(toWorkEdit); }

  async putWorkEdits(edits: WorkEdit[]) {
    await this.ddb.send(new TransactWriteCommand({
      TransactItems: edits.map((e) => ({
        Put: { TableName: this.table, Item: { pk: "WORKEDIT", sk: e.editionId, workId: e.workId, by: e.by, at: e.at } },
      })),
    }));
  }

  async deleteWorkEdits(editionIds: string[]) {
    await this.ddb.send(new TransactWriteCommand({
      TransactItems: editionIds.map((id) => ({ Delete: { TableName: this.table, Key: { pk: "WORKEDIT", sk: id } } })),
    }));
  }
```

- [ ] **Step 7: Register the routes**

In `infra/lib/library.ts`, add to the `routes` array:

```ts
      ["/api/works/edits", apigw.HttpMethod.PUT],
      ["/api/works/edits/reset", apigw.HttpMethod.POST],
```

and change the comment above it from "One integration, ten routes" to "One integration, twelve routes".

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd infra && npx vitest run && npm run typecheck`
Expected: every test file passes, including `stack.test.ts`, whose authorizer check automatically covers the new `PUT` and `POST` routes; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add infra/lambda/library/lib.ts infra/lambda/library/index.ts infra/lambda/library/store.ts infra/lib/library.ts infra/test/library-handler.test.ts infra/test/library-store.test.ts infra/test/library.test.ts
git commit -m "feat(api): admin work corrections — write, reset, and overlay workEdits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 11: One OPDS publication per edition

**Files:**
- Modify: `infra/lambda/download/download.ts` (`CatalogBook`)
- Modify: `infra/lambda/download/opds-feed.ts`
- Test: `infra/test/opds-feed.test.ts`

**Interfaces:**
- Consumes: `editionId` and `addedAt` on catalog entries (Task 6).
- Produces: `CatalogBook` gains optional `editionId?: string` and `addedAt?: string`. `buildOpdsFeed(catalog, title, links)` keeps its signature and returns one publication per edition.

- [ ] **Step 1: Write the failing tests**

Append to `infra/test/opds-feed.test.ts`:

```ts
describe("buildOpdsFeed with editions", () => {
  it("lists one publication per edition, linking each format to its most recently added copy", () => {
    const catalog: Catalog = {
      books: [
        { id: "old", editionId: "old", addedAt: "2026-09-04", title: "The Works, Volume 1", authors: ["Edgar Allan Poe"],
          formats: [{ type: "epub", size: 1, s3Key: "k-old-epub" }, { type: "pdf", size: 2, s3Key: "k-old-pdf" }] },
        { id: "new", editionId: "old", addedAt: "2026-09-13", title: "The Works, Volume 1", authors: ["Edgar Allan Poe"],
          formats: [{ type: "epub", size: 1, s3Key: "k-new-epub" }] },
        { id: "solo", editionId: "solo", addedAt: "2026-09-13", title: "Eureka", formats: [{ type: "epub", size: 3, s3Key: "k" }] },
      ],
    };
    const feed = buildOpdsFeed(catalog, "Lit Library", links);
    expect(feed.publications).toHaveLength(2);
    expect(feed.publications[0].metadata.title).toBe("The Works, Volume 1");
    expect(feed.publications[0].links).toEqual([
      { rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/new/epub?token=tok", type: "application/epub+zip" },
      { rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/old/pdf?token=tok", type: "application/pdf" },
    ]);
    expect(feed.publications[1].metadata.title).toBe("Eureka");
  });

  it("breaks a copy tie on the smallest id", () => {
    const catalog: Catalog = {
      books: [
        { id: "b", editionId: "a", addedAt: "2026-09-13", title: "T", formats: [{ type: "epub", size: 1, s3Key: "kb" }] },
        { id: "a", editionId: "a", addedAt: "2026-09-13", title: "T", formats: [{ type: "epub", size: 1, s3Key: "ka" }] },
      ],
    };
    expect(buildOpdsFeed(catalog, "L", links).publications[0].links[0].href).toBe("/api/opds/download/a/epub?token=tok");
  });

  it("treats entries without editionId as editions of their own", () => {
    const catalog: Catalog = {
      books: [
        { id: "x", title: "Same", formats: [{ type: "epub", size: 1, s3Key: "kx" }] },
        { id: "y", title: "Same", formats: [{ type: "epub", size: 1, s3Key: "ky" }] },
      ],
    };
    expect(buildOpdsFeed(catalog, "L", links).publications).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd infra && npx vitest run test/opds-feed.test.ts`
Expected: FAIL — typecheck of `editionId`/`addedAt` on `CatalogBook`, and three publications instead of two.

- [ ] **Step 3: Implement**

In `infra/lambda/download/download.ts`, change `CatalogBook` to:

```ts
export interface CatalogBook { id: string; editionId?: string; addedAt?: string; title: string; authors?: string[]; formats: CatalogFormat[] }
```

In `infra/lambda/download/opds-feed.ts`, replace `toPublication` and `buildOpdsFeed` with:

```ts
const FORMAT_ORDER = ["epub", "pdf", "cbz", "zip"];
const formatRank = (type: string): number => {
  const i = FORMAT_ORDER.indexOf(type);
  return i === -1 ? FORMAT_ORDER.length : i;
};

// Copies of one edition are the same book, so the feed lists the edition once. Each format
// links to the most recently added copy that has it (ties: smallest id), matching the site.
function toPublication(copies: CatalogBook[], links: FeedLinks) {
  const editionId = copies[0].editionId ?? copies[0].id;
  const canonical = copies.find((b) => b.id === editionId) ?? copies[0];
  const newestFirst = [...copies].sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? "") || a.id.localeCompare(b.id));
  const chosen = new Map<string, CatalogBook>();
  for (const copy of newestFirst) {
    for (const f of copy.formats) if (!chosen.has(f.type)) chosen.set(f.type, copy);
  }
  const types = [...chosen.keys()].sort((a, b) => formatRank(a) - formatRank(b) || a.localeCompare(b));
  return {
    metadata: {
      "@type": "http://schema.org/Book",
      title: canonical.title,
      author: (canonical.authors ?? []).map((name) => ({ name })),
    },
    links: types.map((type) => ({
      rel: "http://opds-spec.org/acquisition",
      href: links.acquisitionOf(chosen.get(type)!.id, type),
      type: mediaTypeOf(type),
    })),
  };
}

// A single flat acquisition feed — one publication per edition, in catalogue order of each
// edition's first copy. No pagination or per-category feeds.
export function buildOpdsFeed(catalog: Catalog, title: string, links: FeedLinks) {
  const editions = new Map<string, CatalogBook[]>();
  for (const book of catalog.books) {
    const key = book.editionId ?? book.id;
    const copies = editions.get(key);
    if (copies) copies.push(book);
    else editions.set(key, [book]);
  }
  return {
    metadata: { title },
    links: [{ rel: "self", href: links.self, type: OPDS_MEDIA_TYPE }],
    publications: [...editions.values()].map((copies) => toPublication(copies, links)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd infra && npx vitest run && npm run typecheck`
Expected: all pass. The existing feed tests (single entries without `editionId`) must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/download/download.ts infra/lambda/download/opds-feed.ts infra/test/opds-feed.test.ts
git commit -m "feat(opds): one publication per edition

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---
### Task 12: Grouping copies into work cards on the site

**Files:**
- Modify: `web/src/catalog/types.ts`
- Create: `web/src/catalog/works.ts`
- Test: `web/src/catalog/works.test.ts`

**Interfaces:**
- Consumes: `Overlay` from `web/src/catalog/library.ts` (its `workEdits` field is added in Task 13; this task reads it as `overlay?.workEdits ?? {}` through a structural type, so it compiles before Task 13); `test-fixtures/work-corrections.json` (Task 1).
- Produces:
  - In `types.ts`: `EditionFormat`, `Edition` (below); `Book` gains optional `editionId`, `workId`, `bundles`, `editions`.
  - In `works.ts`:
    ```ts
    export interface CatalogEntryRef { id: string; editionId?: string; workId?: string }
    export function effectiveWorkIds(entries: CatalogEntryRef[], workEdits: Record<string, string>): Map<string, string>  // entry id -> work id
    export function displayOrder(editions: Edition[]): Edition[]
    export function editionMarker(title: string): string | null
    export function groupWorks(entries: Book[], overlay: WorkOverlay | null): Book[]
    export interface WorkOverlay {
      bookCategories: Record<string, string>;
      readingStatuses: Record<string, ReadingStatus>;
      downloaded: string[];
      workEdits?: Record<string, string>;
    }
    ```
  A work card is a `Book` whose `id`, `editionId` and `workId` are the work id, with `bundles` and `editions` (newest first) set.

- [ ] **Step 1: Add the types**

In `web/src/catalog/types.ts`, add after `BookFormat`:

```ts
// A format of one edition, served from a specific copy (the most recently added copy that has it).
export interface EditionFormat extends BookFormat { copyId: string }

// One edition of a work: copies that are the same book. Presentation fields come from the
// edition's canonical (earliest-added) copy. See docs/superpowers/specs/2026-09-14-works-and-editions-design.md.
export interface Edition {
  id: string;
  title: string;
  authors: string[];
  description: string | null;
  publisher: string | null;
  year: number | null;
  coverUrl: string | null;
  subjects: string[];
  category: string;
  formats: EditionFormat[];
  bundles: string[];
  copyIds: string[];
  addedAt: string;
  downloaded: boolean;
}
```

and add to the `Book` interface, after `addedAt: string;`:

```ts
  // From catalog.json; absent in catalogs from before works and editions, which means the
  // entry is its own edition and work. A work card sets both to its own id.
  editionId?: string;
  workId?: string;
  // Set only on work cards built by groupWorks: every bundle containing a copy, and the
  // editions, newest first.
  bundles?: string[];
  editions?: Edition[];
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/catalog/works.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "./types";
import { effectiveWorkIds, editionMarker, groupWorks, type WorkOverlay } from "./works";

interface FixtureStep { op: Record<string, string>; rows: Record<string, string>; cards: string[][] }
interface FixtureCase { editions: string[]; links: string[][]; catalogWorkId: Record<string, string>; steps: FixtureStep[] }
const fixture = JSON.parse(
  readFileSync(new URL("../../../test-fixtures/work-corrections.json", import.meta.url), "utf8"),
) as { cases: FixtureCase[] };

function cardsOf(workOf: Map<string, string>): string[][] {
  const by = new Map<string, string[]>();
  for (const [id, w] of workOf) by.set(w, [...(by.get(w) ?? []), id]);
  return [...by.values()].map((ids) => ids.sort()).sort((a, b) => a.join().localeCompare(b.join()));
}

const copy = (id: string, over: Partial<Book> = {}): Book => ({
  id, title: "The Works, Volume 1", authors: ["Edgar Allan Poe"], description: null, category: "Fiction",
  subjects: [], publisher: null, bundle: "B", year: 1903, formats: [{ type: "epub", size: 1, s3Key: `k-${id}` }],
  coverUrl: null, addedAt: "2026-09-04", editionId: id, workId: id, ...over,
});

const overlay = (over: Partial<WorkOverlay> = {}): WorkOverlay => ({
  bookCategories: {}, readingStatuses: {}, downloaded: [], ...over,
});

describe("effectiveWorkIds", () => {
  it("uses the catalog grouping when there are no edits, and an entry's own id when fields are missing", () => {
    const out = effectiveWorkIds([{ id: "a", editionId: "a", workId: "a" }, { id: "b", editionId: "b", workId: "a" }, { id: "c" }], {});
    expect(Object.fromEntries(out)).toEqual({ a: "a", b: "a", c: "c" });
  });

  it("follows chains through untouched ids", () => {
    const entries = [{ id: "x", editionId: "x", workId: "x" }, { id: "y", editionId: "y", workId: "x" }, { id: "z", editionId: "z", workId: "z" }];
    expect(effectiveWorkIds(entries, { x: "z" }).get("y")).toBe("z");
  });

  it("falls back to the catalog grouping on a cycle, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = effectiveWorkIds([{ id: "p", editionId: "p", workId: "p" }, { id: "q", editionId: "q", workId: "q" }], { p: "q", q: "p" });
    expect(out.get("p")).toBe("p");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resolves every step of the shared fixture to its recorded cards", () => {
    for (const [n, c] of fixture.cases.entries()) {
      const entries = c.editions.map((e) => ({ id: e, editionId: e, workId: c.catalogWorkId[e] }));
      for (const [s, step] of c.steps.entries()) {
        expect(cardsOf(effectiveWorkIds(entries, step.rows)), `case ${n} step ${s}`).toEqual(step.cards);
      }
    }
  });
});

describe("groupWorks", () => {
  const entries = [
    copy("a", { bundle: "Lovecraft Circle", addedAt: "2026-09-04",
      formats: [{ type: "epub", size: 1, s3Key: "a-epub" }, { type: "pdf", size: 2, s3Key: "a-pdf" }] }),
    copy("b", { editionId: "a", workId: "a", bundle: "Poe", addedAt: "2026-09-13",
      formats: [{ type: "epub", size: 1, s3Key: "b-epub" }] }),
    copy("c", { workId: "a", title: "The Works, Volume 1, Second Edition", year: 1910, bundle: "Other", addedAt: "2026-09-05" }),
  ];

  it("makes one card per work with editions newest first", () => {
    const [card, ...rest] = groupWorks(entries, null);
    expect(rest).toEqual([]);
    expect(card.id).toBe("a");
    expect(card.workId).toBe("a");
    expect(card.editions!.map((e) => e.id)).toEqual(["c", "a"]);
    expect(card.title).toBe("The Works, Volume 1, Second Edition");
    expect(card.year).toBe(1910);
    expect(card.bundles).toEqual(["Lovecraft Circle", "Other", "Poe"]);
    expect(card.formats.map((f) => f.type)).toEqual(["epub", "pdf"]);
    expect(card.addedAt).toBe("2026-09-05");
    expect(card.readingStatus).toBeUndefined();
  });

  it("serves each format of an edition from its most recently added copy", () => {
    const edition = groupWorks(entries, null)[0].editions!.find((e) => e.id === "a")!;
    expect(edition.formats).toEqual([
      { type: "epub", size: 1, s3Key: "b-epub", copyId: "b" },
      { type: "pdf", size: 2, s3Key: "a-pdf", copyId: "a" },
    ]);
    expect(edition.addedAt).toBe("2026-09-04");
    expect(edition.copyIds).toEqual(["a", "b"]);
  });

  it("reads status from the work id first, then the display edition's copies, then the rest", () => {
    expect(groupWorks(entries, overlay({ readingStatuses: { b: "reading", c: "finished" } }))[0].readingStatus).toBe("finished");
    expect(groupWorks(entries, overlay({ readingStatuses: { a: "want to read", c: "finished" } }))[0].readingStatus).toBe("want to read");
    expect(groupWorks(entries, overlay({ readingStatuses: { b: "reading" } }))[0].readingStatus).toBe("reading");
    expect(groupWorks(entries, overlay())[0].readingStatus).toBeNull();
  });

  it("reads category from an edit on the work id, then any copy, then the catalog", () => {
    expect(groupWorks(entries, overlay({ bookCategories: { b: "Comics" } }))[0].category).toBe("Comics");
    expect(groupWorks(entries, overlay({ bookCategories: { a: "TTRPG", b: "Comics" } }))[0].category).toBe("TTRPG");
    expect(groupWorks(entries, overlay())[0].category).toBe("Fiction");
  });

  it("marks a card and an edition downloaded when any of their copies is", () => {
    const card = groupWorks(entries, overlay({ downloaded: ["b"] }))[0];
    expect(card.downloaded).toBe(true);
    expect(card.editions!.map((e) => [e.id, e.downloaded])).toEqual([["c", false], ["a", true]]);
  });

  it("applies admin corrections before grouping", () => {
    const cards = groupWorks(entries, overlay({ workEdits: { c: "c" } }));
    expect(cards.map((w) => w.id).sort()).toEqual(["a", "c"]);
  });

  it("treats entries from an older catalog as their own cards", () => {
    const old = [copy("x", { editionId: undefined, workId: undefined }), copy("y", { editionId: undefined, workId: undefined })];
    expect(groupWorks(old, null).map((w) => w.id)).toEqual(["x", "y"]);
  });
});

describe("editionMarker", () => {
  it("finds explicit edition markers only", () => {
    expect(editionMarker("Clean Code in Python - Second Edition")).toBe("Second Edition");
    expect(editionMarker("Learning DevOps (2nd edition)")).toBe("2nd edition");
    expect(editionMarker("Dune: The Butlerian Jihad")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/catalog/works.test.ts`
Expected: FAIL — cannot resolve `./works`.

- [ ] **Step 4: Implement**

Create `web/src/catalog/works.ts`:

```ts
import type { Book, BookFormat, Edition, EditionFormat, ReadingStatus } from "./types";

// Groups catalog copies into work cards. See docs/superpowers/specs/2026-09-14-works-and-editions-design.md.

export interface CatalogEntryRef { id: string; editionId?: string; workId?: string }

// The overlay fields grouping needs. Structurally a subset of library.ts's Overlay.
export interface WorkOverlay {
  bookCategories: Record<string, string>;
  readingStatuses: Record<string, ReadingStatus>;
  downloaded: string[];
  workEdits?: Record<string, string>;
}

const editionOf = (e: CatalogEntryRef) => e.editionId ?? e.id;
const catalogWorkOf = (e: CatalogEntryRef) => e.workId ?? e.id;
const byAddedThenId = (a: { addedAt: string; id: string }, b: { addedAt: string; id: string }) =>
  a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id);

// Start from the edition's correction row, otherwise its catalog work; then keep moving to the
// current id's row, otherwise that id's catalog work, until the id stops changing. Mirrors the
// reference model in scripts/gen-work-corrections-fixture.py, which the tests replay.
export function effectiveWorkIds(entries: CatalogEntryRef[], workEdits: Record<string, string>): Map<string, string> {
  const catalogWork = new Map<string, string>();
  for (const e of entries) catalogWork.set(editionOf(e), catalogWorkOf(e));
  const out = new Map<string, string>();
  for (const e of entries) {
    const edition = editionOf(e);
    let w = workEdits[edition] ?? catalogWorkOf(e);
    const seen = new Set([edition]);
    let cycle = false;
    for (;;) {
      const next = workEdits[w] ?? catalogWork.get(w) ?? w;
      if (next === w) break;
      if (seen.has(next)) { cycle = true; break; }
      seen.add(w);
      w = next;
    }
    if (cycle) console.warn(`work corrections form a cycle at ${edition}; using its catalog grouping`);
    out.set(e.id, cycle ? catalogWorkOf(e) : w);
  }
  return out;
}

const ORDINAL = String.raw`\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth`;
const EDITION_MARKER = new RegExp(
  String.raw`\(([^)]*\bedition\b[^)]*)\)|\b(?:${ORDINAL}|revised|updated|expanded)\s+edition\b|\bedition\s+\d+\b|\b\d+(?:st|nd|rd|th)\s+ed\b\.?`,
  "i",
);

export function editionMarker(title: string): string | null {
  const m = title.match(EDITION_MARKER);
  if (!m) return null;
  return (m[1] ?? m[0]).trim();
}

const yearOf = (e: Edition) => e.year ?? Number.NEGATIVE_INFINITY;

export function displayOrder(editions: Edition[]): Edition[] {
  return [...editions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .sort((a, b) => (yearOf(a) === yearOf(b) ? 0 : yearOf(b) > yearOf(a) ? 1 : -1));
}

function toEdition(id: string, copies: Book[], downloaded: Set<string>): Edition {
  const byAdded = [...copies].sort(byAddedThenId);
  const canonical = copies.find((c) => c.id === id) ?? byAdded[0];
  const newestFirst = [...copies].sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
  const types = [...new Set([...canonical.formats.map((f) => f.type), ...copies.flatMap((c) => c.formats.map((f) => f.type))])];
  const formats: EditionFormat[] = types.map((type) => {
    const source = newestFirst.find((c) => c.formats.some((f) => f.type === type))!;
    return { ...source.formats.find((f) => f.type === type)!, copyId: source.id };
  });
  return {
    id, title: canonical.title, authors: canonical.authors, description: canonical.description,
    publisher: canonical.publisher, year: canonical.year, coverUrl: canonical.coverUrl, subjects: canonical.subjects,
    category: canonical.category, formats, bundles: [...new Set(copies.map((c) => c.bundle))].sort(),
    copyIds: byAdded.map((c) => c.id), addedAt: byAdded[0].addedAt, downloaded: copies.some((c) => downloaded.has(c.id)),
  };
}

function toWork(workId: string, byEdition: Map<string, Book[]>, overlay: WorkOverlay | null, downloaded: Set<string>): Book {
  const editions = displayOrder([...byEdition].map(([id, copies]) => toEdition(id, copies, downloaded)));
  const shown = editions[0];
  const shownCopies = [...byEdition.get(shown.id)!].sort(byAddedThenId);
  const otherCopies = editions.slice(1).flatMap((e) => byEdition.get(e.id)!).sort(byAddedThenId);
  const preference = [workId, ...shownCopies.map((c) => c.id), ...otherCopies.map((c) => c.id)];
  function firstIn<T>(map: Record<string, T> | undefined): T | undefined {
    if (!map) return undefined;
    for (const id of preference) if (map[id] !== undefined) return map[id];
    return undefined;
  }
  const formats: BookFormat[] = [];
  const seen = new Set<string>();
  for (const e of editions) {
    for (const { copyId: _copyId, ...f } of e.formats) {
      if (!seen.has(f.type)) { seen.add(f.type); formats.push(f); }
    }
  }
  const bundles = [...new Set(editions.flatMap((e) => e.bundles))].sort();
  return {
    id: workId, editionId: workId, workId,
    title: shown.title, authors: shown.authors, description: shown.description,
    category: firstIn(overlay?.bookCategories) ?? shown.category,
    subjects: shown.subjects, publisher: shown.publisher, bundle: bundles[0] ?? "", year: shown.year, formats,
    coverUrl: shown.coverUrl, addedAt: editions.map((e) => e.addedAt).sort().at(-1)!,
    bundles, editions,
    ...(overlay ? { readingStatus: firstIn(overlay.readingStatuses) ?? null, downloaded: editions.some((e) => e.downloaded) } : {}),
  };
}

export function groupWorks(entries: Book[], overlay: WorkOverlay | null): Book[] {
  const workOf = effectiveWorkIds(entries, overlay?.workEdits ?? {});
  const downloaded = new Set(overlay?.downloaded ?? []);
  const works = new Map<string, Map<string, Book[]>>();
  for (const entry of entries) {
    const w = workOf.get(entry.id)!;
    const byEdition = works.get(w) ?? new Map<string, Book[]>();
    works.set(w, byEdition);
    const edition = editionOf(entry);
    byEdition.set(edition, [...(byEdition.get(edition) ?? []), entry]);
  }
  return [...works].map(([workId, byEdition]) => toWork(workId, byEdition, overlay, downloaded));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/catalog/works.test.ts && npm run typecheck`
Expected: all pass; typecheck clean. If the fixture test fails, the resolution is wrong — never edit the fixture. Then run the full web suite.

- [ ] **Step 6: Commit**

```bash
git add web/src/catalog/types.ts web/src/catalog/works.ts web/src/catalog/works.test.ts
git commit -m "feat(web): group catalog copies into work cards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 13: Correction row builders and the corrections API client

**Files:**
- Modify: `web/src/catalog/works.ts`
- Modify: `web/src/catalog/library.ts`
- Test: `web/src/catalog/works.test.ts`, `web/src/catalog/library.test.ts`

**Interfaces:**
- Consumes: `effectiveWorkIds`, `CatalogEntryRef` (Task 12); the API from Task 10.
- Produces:
  - In `works.ts`:
    ```ts
    export interface EditionRef { id: string; addedAt: string }
    export function mergeEdits(fromEditionIds: string[], intoWorkId: string): Record<string, string>
    export function splitEdits(cardId: string, cardEditions: EditionRef[], editionId: string): Record<string, string>
    export function resetEditionIds(entries: CatalogEntryRef[], cardEditionIds: string[], workEdits: Record<string, string>): string[]
    ```
  - In `library.ts`: `Overlay` gains `workEdits?: Record<string, string>` (always present after `fetchOverlay`, defaulting to `{}`); `putWorkEdits(apiUrl, idToken, edits, fetchFn?)`; `resetWorkEdits(apiUrl, idToken, editionIds, fetchFn?)`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/catalog/works.test.ts` (and extend its `./works` import with `mergeEdits, resetEditionIds, splitEdits`):

```ts
describe("correction row builders", () => {
  it("merge assigns every edition of the source card to the target", () => {
    expect(mergeEdits(["x", "y"], "w")).toEqual({ x: "w", y: "w" });
  });

  it("split of a later edition writes only that edition", () => {
    const eds = [{ id: "a", addedAt: "1" }, { id: "b", addedAt: "2" }, { id: "c", addedAt: "3" }];
    expect(splitEdits("a", eds, "b")).toEqual({ b: "b", c: "a" });
  });

  it("split of the card's earliest edition moves the remainder to the next-earliest", () => {
    const eds = [{ id: "a", addedAt: "1" }, { id: "b", addedAt: "2" }, { id: "c", addedAt: "3" }];
    expect(splitEdits("a", eds, "a")).toEqual({ a: "a", b: "b", c: "b" });
  });

  it("split of a card's only edition writes nothing", () => {
    expect(splitEdits("a", [{ id: "a", addedAt: "1" }], "a")).toEqual({});
  });

  it("reset returns the rows of the card's editions and of their automatic groups", () => {
    const entries = [{ id: "a", editionId: "a", workId: "a" }, { id: "b", editionId: "b", workId: "a" }, { id: "z", editionId: "z", workId: "z" }];
    expect(resetEditionIds(entries, ["b"], { a: "a", b: "b", z: "z" })).toEqual(["a", "b"]);
  });

  it("replays every operation in the shared fixture to the recorded rows", () => {
    for (const [n, c] of fixture.cases.entries()) {
      const entries = c.editions.map((e) => ({ id: e, editionId: e, workId: c.catalogWorkId[e] }));
      const added = (e: string) => String(c.editions.indexOf(e)).padStart(4, "0");
      let rows: Record<string, string> = {};
      for (const [s, step] of c.steps.entries()) {
        const work = effectiveWorkIds(entries, rows);
        const cardEditions = (card: string) => c.editions.filter((e) => work.get(e) === card);
        const op = step.op;
        if (op.kind === "merge") {
          rows = { ...rows, ...mergeEdits(cardEditions(op.from), op.into) };
        } else if (op.kind === "split") {
          const card = work.get(op.edition)!;
          rows = { ...rows, ...splitEdits(card, cardEditions(card).map((id) => ({ id, addedAt: added(id) })), op.edition) };
        } else {
          const drop = new Set(resetEditionIds(entries, cardEditions(op.card), rows));
          rows = Object.fromEntries(Object.entries(rows).filter(([e]) => !drop.has(e)));
        }
        expect(rows, `case ${n} step ${s}`).toEqual(step.rows);
      }
    }
  });
});
```

Append to `web/src/catalog/library.test.ts` (extending its `./library` import with `putWorkEdits, resetWorkEdits`):

```ts
describe("work corrections API", () => {
  const ok204 = () => vi.fn(async () => ({ ok: true, status: 204, headers: new Headers() })) as unknown as typeof fetch;

  it("PUTs edits", async () => {
    const f = ok204();
    await putWorkEdits("https://api", "tok", { aaaaaaaaaaaaaaaa: "bbbbbbbbbbbbbbbb" }, f);
    expect(f).toHaveBeenCalledWith("https://api/works/edits", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ edits: { aaaaaaaaaaaaaaaa: "bbbbbbbbbbbbbbbb" } }),
    }));
  });

  it("POSTs a reset", async () => {
    const f = ok204();
    await resetWorkEdits("https://api", "tok", ["aaaaaaaaaaaaaaaa"], f);
    expect(f).toHaveBeenCalledWith("https://api/works/edits/reset", expect.objectContaining({
      method: "POST", body: JSON.stringify({ editionIds: ["aaaaaaaaaaaaaaaa"] }),
    }));
  });

  const overlayRes = (body: object) => vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body,
  })) as unknown as typeof fetch;
  const base = { categories: [], bookCategories: {}, suggestions: [], readingStatuses: {}, downloaded: [] };

  it("defaults workEdits to empty when an older API omits it", async () => {
    expect((await fetchOverlay("https://api", "tok", overlayRes(base))).workEdits).toEqual({});
  });

  it("rejects a malformed workEdits", async () => {
    await expect(fetchOverlay("https://api", "tok", overlayRes({ ...base, workEdits: ["x"] }))).rejects.toThrow("malformed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/catalog/works.test.ts src/catalog/library.test.ts`
Expected: FAIL — the builders and API functions do not exist.

- [ ] **Step 3: Implement the builders**

Append to `web/src/catalog/works.ts`:

```ts
export interface EditionRef { id: string; addedAt: string }

// Merge card X into card W: every edition of X is assigned to W.
export function mergeEdits(fromEditionIds: string[], intoWorkId: string): Record<string, string> {
  return Object.fromEntries(fromEditionIds.map((id) => [id, intoWorkId]));
}

// Split edition S out of card C. The remainder gets explicit rows too: without them, a split of
// the card's earliest edition would do nothing (the rest still resolve to it through their
// catalog workId), and a split of an edition that was the only automatic link between two
// others would come apart differently at the next publish.
export function splitEdits(cardId: string, cardEditions: EditionRef[], editionId: string): Record<string, string> {
  const rest = cardEditions.filter((e) => e.id !== editionId);
  if (rest.length === 0) return {};
  const remainderId = editionId !== cardId ? cardId : [...rest].sort(byAddedThenId)[0].id;
  const rows: Record<string, string> = { [editionId]: editionId };
  if (editionId === cardId) rows[remainderId] = remainderId;
  for (const e of rest) if (e.id !== remainderId) rows[e.id] = remainderId;
  return rows;
}

// Reset card C: the rows of C's editions and of every edition sharing an automatic work with
// one of them. Clearing whole automatic groups keeps the site and the folded overrides in step.
export function resetEditionIds(entries: CatalogEntryRef[], cardEditionIds: string[], workEdits: Record<string, string>): string[] {
  const catalogWork = new Map(entries.map((e) => [editionOf(e), catalogWorkOf(e)]));
  const autos = new Set(cardEditionIds.map((id) => catalogWork.get(id) ?? id));
  const drop = new Set(cardEditionIds);
  for (const [edition, work] of catalogWork) if (autos.has(work)) drop.add(edition);
  return [...drop].filter((id) => id in workEdits).sort();
}
```

- [ ] **Step 4: Implement the API client**

In `web/src/catalog/library.ts`, add to the `Overlay` interface:

```ts
  /** Admin work corrections, editionId -> workId. Present after fetchOverlay (empty if the API predates it). */
  workEdits?: Record<string, string>;
```

In `fetchOverlay`, replace the final `return body as Overlay;` with:

```ts
  if (body.workEdits !== undefined && (typeof body.workEdits !== "object" || body.workEdits === null || Array.isArray(body.workEdits))) {
    throw new Error("Library overlay is malformed");
  }
  return { ...(body as Overlay), workEdits: body.workEdits ?? {} };
```

Append:

```ts
export async function putWorkEdits(apiUrl: string, idToken: string, edits: Record<string, string>, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/works/edits", { method: "PUT", body: JSON.stringify({ edits }) }, 204, fetchFn);
}

export async function resetWorkEdits(apiUrl: string, idToken: string, editionIds: string[], fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/works/edits/reset", { method: "POST", body: JSON.stringify({ editionIds }) }, 204, fetchFn);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all pass. If an existing `fetchOverlay` test compares the whole result with `toEqual`, add `workEdits: {}` to its expectation and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add web/src/catalog/works.ts web/src/catalog/works.test.ts web/src/catalog/library.ts web/src/catalog/library.test.ts
git commit -m "feat(web): correction row builders and work corrections API client

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---
### Task 14: Search, facets and the library view over work cards

**Files:**
- Modify: `web/src/catalog/search.ts`
- Modify: `web/src/components/Library.tsx`
- Modify: `web/src/catalog/library.ts`, `web/src/catalog/library.test.ts` (remove `applyOverlay`)
- Test: `web/src/catalog/search.test.ts`, `web/src/components/Library.test.tsx`

**Interfaces:**
- Consumes: `groupWorks` (Task 12).
- Produces: `facetValues(book, "bundle")` returns `book.bundles ?? [book.bundle]`; the search index also matches `editions.title` and `editions.authors`; `Library` renders `groupWorks(books, overlay)`. `applyOverlay` is removed (its job is now done by `groupWorks`). Download and Kindle still send `book.id` in this task; Task 15 switches them to copy ids.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/catalog/search.test.ts` (import `Book` from `./types` if it is not already imported):

```ts
describe("search and facets over work cards", () => {
  const edition = (id: string, title: string) => ({
    id, title, authors: ["Mikael Krief"], description: null, publisher: null, year: null, coverUrl: null, subjects: [],
    category: "Tech & Programming", formats: [], bundles: [], copyIds: [id], addedAt: "2026-01-01", downloaded: false,
  });
  const work: Book = {
    id: "w", title: "Learning DevOps", authors: ["Mikael Krief"], description: null, category: "Tech & Programming",
    subjects: [], publisher: null, bundle: "A", year: 2022, formats: [], coverUrl: null, addedAt: "2026-01-01",
    bundles: ["A", "B"], editions: [edition("w", "Learning DevOps"), edition("o", "Learning DevOps - Second Edition")],
  };

  it("lists a work under every bundle it appears in", () => {
    expect(facetValues(work, "bundle")).toEqual(["A", "B"]);
  });

  it("finds a work by the title of an edition it is not showing", () => {
    expect(searchBooks([work], "second edition").map((b) => b.id)).toEqual(["w"]);
  });
});
```

Append to `web/src/components/Library.test.tsx`:

```ts
describe("work cards", () => {
  it("shows copies of one edition as a single card and counts cards", async () => {
    const dup: Catalog = {
      generatedAt: "t",
      books: [
        { ...catalog.books[0], id: "1", editionId: "1", workId: "1", bundle: "Hacking" },
        { ...catalog.books[0], id: "9", editionId: "1", workId: "1", bundle: "Security Bundle", addedAt: "2026-09-13" },
        catalog.books[1],
      ],
    };
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(dup) });
    expect(await screen.findByText("2 books")).toBeInTheDocument();
    expect(screen.getAllByText("Attacking Network Protocols")).toHaveLength(1);
    expect(screen.getByText("Security Bundle")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/catalog/search.test.ts src/components/Library.test.tsx`
Expected: FAIL — the bundle facet returns `["A"]`, search misses the edition title, and the library shows 3 books.

- [ ] **Step 3: Implement**

In `web/src/catalog/search.ts`, change the bundle case to:

```ts
    case "bundle": return book.bundles ?? [book.bundle];
```

and the index keys in `buildSearchIndex` to:

```ts
    keys: [
      { name: "title", weight: 2 }, { name: "editions.title", weight: 2 },
      { name: "authors", weight: 1 }, { name: "editions.authors", weight: 1 },
      { name: "description", weight: 1 },
    ],
```

In `web/src/components/Library.tsx`, remove `applyOverlay` from the `../catalog/library` import, add `import { groupWorks } from "../catalog/works";`, and replace the `merged` line with:

```tsx
  // One card per work: copies grouped into editions and works, with the overlay's per-reader
  // state and admin corrections applied (see catalog/works.ts).
  const merged = useMemo(() => (books ? groupWorks(books, overlay) : null), [books, overlay]);
```

Then run `grep -rn "applyOverlay" web/src`. If only `library.ts` and `library.test.ts` still mention it, delete the `applyOverlay` function and its explanatory comment from `library.ts` and its `describe("applyOverlay", ...)` block (and import) from `library.test.ts`. If anything else imports it, leave it and say so in your report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/catalog/search.ts web/src/catalog/search.test.ts web/src/catalog/library.ts web/src/catalog/library.test.ts web/src/components/Library.tsx web/src/components/Library.test.tsx
git commit -m "feat(web): library shows one card per work; search and facets span editions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 15: Editions chip and edition picker

**Files:**
- Modify: `web/src/components/BookCard.tsx`, `web/src/styles.css`
- Modify: `web/src/components/BookDetail.tsx`
- Modify: `web/src/components/Library.tsx` (download and Kindle call sites)
- Test: `web/src/components/BookCard.test.tsx`, `web/src/components/BookDetail.test.tsx`

**Interfaces:**
- Consumes: `Edition`, `EditionFormat` (Task 12); `editionMarker` (Task 12).
- Produces: `BookDetail` props change to `onDownload: (copyId: string, format: string) => Promise<void>` and `kindle.onSend(copyId: string, format?: "epub" | "pdf", deviceId?: string)`. For a book without `editions`, the copy id is `book.id`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/BookCard.test.tsx` (import `Edition` from `../catalog/types`):

```tsx
describe("editions chip", () => {
  const edition = (id: string): Edition => ({
    id, title: "T", authors: [], description: null, publisher: null, year: null, coverUrl: null, subjects: [],
    category: "Fiction", formats: [], bundles: ["B"], copyIds: [id], addedAt: "2026-01-01", downloaded: false,
  });

  it("appears on the cover only for works with more than one edition", () => {
    const { container, rerender } = render(<BookCard book={{ ...book, editions: [edition("1"), edition("2")] }} onOpen={() => {}} />);
    expect(container.querySelector(".cover .editions-chip")).toHaveTextContent("2 editions");
    expect(container.querySelector(".meta .editions-chip, .badges .editions-chip")).toBeNull();
    rerender(<BookCard book={{ ...book, editions: [edition("1")] }} onOpen={() => {}} />);
    expect(container.querySelector(".editions-chip")).toBeNull();
  });
});
```

Append to `web/src/components/BookDetail.test.tsx` (import `Edition` from `../catalog/types`):

```tsx
describe("editions", () => {
  const edition = (id: string, over: Partial<Edition> = {}): Edition => ({
    id, title: "Learning DevOps", authors: ["Mikael Krief"], description: `About ${id}`, publisher: "Packt", year: 2019,
    coverUrl: null, subjects: [], category: "Tech & Programming", bundles: ["B"], copyIds: [id], addedAt: "2026-01-01",
    downloaded: false, formats: [{ type: "epub", size: 1024 * 1024, s3Key: `k-${id}`, copyId: id }], ...over,
  });
  const work: Book = {
    ...book, id: "old", title: "Learning DevOps - Second Edition", year: 2022, bundles: ["CICD Mastery", "Devops Bundle"],
    editions: [
      edition("new", { title: "Learning DevOps - Second Edition", year: 2022, description: "About new",
        formats: [{ type: "epub", size: 2 * 1024 * 1024, s3Key: "k-new", copyId: "copy-new" }] }),
      edition("old", { downloaded: true }),
    ],
  };
  const renderWork = (b: Book, onDownload = vi.fn(async () => {})) => render(
    <BookDetail book={b} onClose={() => {}} onDownload={onDownload} categories={[]}
      onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />,
  );

  it("lists editions newest first and switches details and downloads to the chosen edition", async () => {
    const onDownload = vi.fn(async () => {});
    renderWork(work, onDownload);
    const picker = screen.getByRole("combobox", { name: "Edition" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "2022 · Second Edition · EPUB", "2019 · EPUB · downloaded",
    ]);
    expect(screen.getByText("About new")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (2.0 MB)" }));
    expect(onDownload).toHaveBeenCalledWith("copy-new", "epub");
    await userEvent.selectOptions(picker, "old");
    expect(screen.getByRole("heading", { name: "Learning DevOps" })).toBeInTheDocument();
    expect(screen.getByText("About old")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (1.0 MB)" }));
    expect(onDownload).toHaveBeenLastCalledWith("old", "epub");
  });

  it("lists every bundle the work appears in", () => {
    renderWork(work);
    expect(screen.getByText("In: CICD Mastery, Devops Bundle")).toBeInTheDocument();
  });

  it("keeps the chosen edition when the same work re-renders as a new object", async () => {
    const { rerender } = renderWork(work);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Edition" }), "old");
    rerender(<BookDetail book={{ ...work }} onClose={() => {}} onDownload={async () => {}} categories={[]}
      onChangeCategory={async () => {}} onSuggest={async () => {}} onChangeStatus={async () => {}} />);
    expect(screen.getByRole("combobox", { name: "Edition" })).toHaveValue("old");
  });

  it("shows no edition picker for a book with one edition, and downloads by its own id", async () => {
    const onDownload = vi.fn(async () => {});
    renderWork(book, onDownload);
    expect(screen.queryByRole("combobox", { name: "Edition" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
    expect(onDownload).toHaveBeenCalledWith("1", "epub");
  });
});
```

In the existing `BookDetail.test.tsx` tests, change assertions that `onDownload` was called with `(book, "epub")` to `("1", "epub")`, and any Kindle `onSend` expectation whose first argument is the book object to `"1"`. Any existing assertion on the category row's `· <bundle>` text moves to the new `In: <bundles>` line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/components/BookCard.test.tsx src/components/BookDetail.test.tsx`
Expected: FAIL — no chip, no picker, and `onDownload` still receives the book.

- [ ] **Step 3: Implement the chip**

In `web/src/components/BookCard.tsx`, inside `<span className="cover">`, after the downloaded chip line, add:

```tsx
        {book.editions && book.editions.length > 1 && (
          <span className="editions-chip">{book.editions.length} editions</span>
        )}
```

In `web/src/styles.css`, after the `.downloaded-chip` rule, add:

```css
.editions-chip { position: absolute; bottom: 0.35rem; left: 0.35rem; font-size: 0.65rem; line-height: 1; padding: 0.25rem 0.45rem; border-radius: 999px; pointer-events: none; background: color-mix(in srgb, var(--panel) 88%, transparent); color: var(--muted); border: 1px solid var(--border); }
```

- [ ] **Step 4: Implement the picker**

In `web/src/components/BookDetail.tsx`:

1. Change the types import to `import { READING_STATUSES, type Book, type Edition, type EditionFormat, type ReadingStatus } from "../catalog/types";` and add `import { editionMarker } from "../catalog/works";`.

2. In `KindleDialogProps`, change `onSend` to:

```ts
  onSend(copyId: string, format?: "epub" | "pdf", deviceId?: string): Promise<void>;
```

3. In `Props`, change `onDownload` to:

```ts
  onDownload: (copyId: string, format: string) => Promise<void>;
```

4. Above the component, add:

```ts
function editionLabel(e: Edition): string {
  return [
    e.year ? String(e.year) : "Undated",
    editionMarker(e.title),
    e.formats.map((f) => f.type.toUpperCase()).join("/"),
    e.downloaded ? "downloaded" : null,
  ].filter(Boolean).join(" · ");
}
```

5. Add `const [editionId, setEditionId] = useState<string | null>(null);` beside the other state, and replace the existing reset effect with:

```tsx
  // Keyed on the id, not the object: work cards are rebuilt whenever the overlay changes (a
  // status set anywhere in the library), and that must not reset this dialog's edition choice
  // or close a half-filled Kindle form.
  useEffect(() => {
    setBusy(false);
    setSuggesting(false);
    setKindleState({ kind: "idle" });
    setEditionId(book?.editions?.[0]?.id ?? null);
    const el = ref.current;
    if (!el) return;
    if (book && !el.open) el.showModal();
    if (!book && el.open) el.close();
  }, [book?.id]); // eslint-disable-line react-hooks/exhaustive-deps
```

6. Replace the `const meta = ...` line with:

```tsx
  const editions = book.editions ?? [];
  const edition = editions.find((e) => e.id === editionId) ?? editions[0];
  const view = edition
    ? { title: edition.title, authors: edition.authors, publisher: edition.publisher, year: edition.year,
        description: edition.description, coverUrl: edition.coverUrl, formats: edition.formats }
    : { title: book.title, authors: book.authors, publisher: book.publisher, year: book.year,
        description: book.description, coverUrl: book.coverUrl,
        formats: book.formats.map((f): EditionFormat => ({ ...f, copyId: book.id })) };
  const meta = [view.publisher, view.year ? String(view.year) : null].filter(Boolean).join(" · ");
  const bundles = book.bundles ?? [book.bundle];
  const copyIdFor = (format: string) => view.formats.find((f) => f.type === format)?.copyId ?? book.id;
```

7. In `download`, call `await onDownload(copyIdFor(format), format);`. In `sendToKindle`, call `await kindle.onSend(copyIdFor(format), format, deviceId);`. In the `KindleDeviceForm` `onSubmit`, call `await kindle.onSend(copyIdFor(format), format, undefined);`.

8. In the JSX: use `view.coverUrl` for the cover image, `view.title` for the heading, `view.authors` for the authors line, and `view.description` for the description. In the category row, remove `· {book.bundle}` from both branches (the no-categories branch becomes `<p className="meta">{book.category}</p>`). Directly after the `{suggesting && (...)}` block, add:

```tsx
          <p className="meta">In: {bundles.join(", ")}</p>
          {editions.length > 1 && edition && (
            <p className="meta edition-row">
              <select aria-label="Edition" value={edition.id} disabled={busy}
                onChange={(e) => setEditionId(e.target.value)}>
                {editions.map((e) => <option key={e.id} value={e.id}>{editionLabel(e)}</option>)}
              </select>
            </p>
          )}
```

Change the downloads block to iterate `view.formats`. In the Kindle block, replace `kindleFormat(book)` with `kindleFormat(kindleBook)` and `kindleFormat(book, "pdf")` with `kindleFormat(kindleBook, "pdf")`, declaring `const kindleBook = { ...book, formats: view.formats };` as the first line inside that block's arrow function.

- [ ] **Step 5: Update the library call sites**

In `web/src/components/Library.tsx`, change `download` to take a copy id:

```tsx
  const download = useCallback(async (copyId: string, format: string) => {
    try {
      const token = await getIdToken();
      const ticket = await requestDownload(apiUrl, token, copyId, format, fetchFn);
      startDownload(ticket.url, navigate);
    } catch (e) {
      fail((e as Error).message);
    }
  }, [apiUrl, getIdToken, fetchFn, navigate, fail]);
```

and in `kindleForDialog`, change `onSend` to:

```tsx
    onSend: async (copyId: string, format?: "epub" | "pdf", deviceId?: string) => {
      try {
        const r = await kindle.send(copyId, format, deviceId);
```

(keeping the rest of that function as it is).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/BookCard.tsx web/src/components/BookCard.test.tsx web/src/styles.css web/src/components/BookDetail.tsx web/src/components/BookDetail.test.tsx web/src/components/Library.tsx
git commit -m "feat(web): editions chip and edition picker; downloads name the copy served

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 16: Admin merge, split and reset in the app

**Files:**
- Create: `web/src/components/WorkAdminControls.tsx`
- Modify: `web/src/components/BookDetail.tsx`, `web/src/components/Library.tsx`, `web/src/styles.css`
- Test: `web/src/components/WorkAdminControls.test.tsx`, `web/src/components/Library.test.tsx`

**Interfaces:**
- Consumes: `mergeEdits`, `splitEdits`, `resetEditionIds` (Task 13); `putWorkEdits`, `resetWorkEdits` (Task 13); `searchBooks` (`web/src/catalog/search.ts`).
- Produces:
  - `WorkAdminControls` with props `{ card: Book; works: Book[]; selectedEditionId: string | null; canReset: boolean; busy: boolean; onMerge(target: Book): Promise<void>; onSplit(editionId: string): Promise<void>; onReset(): Promise<void> }`.
  - `BookDetail` gains `admin?: { works: Book[]; canReset: boolean; onMerge(card: Book, target: Book): Promise<void>; onSplit(card: Book, editionId: string): Promise<void>; onReset(card: Book): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/WorkAdminControls.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Book, Edition } from "../catalog/types";
import WorkAdminControls from "./WorkAdminControls";

const edition = (id: string): Edition => ({
  id, title: "T", authors: [], description: null, publisher: null, year: null, coverUrl: null, subjects: [],
  category: "Fiction", formats: [], bundles: ["B"], copyIds: [id], addedAt: "2026-01-01", downloaded: false,
});
const work = (id: string, title: string, editions = [edition(id)]): Book => ({
  id, title, authors: ["Someone"], description: null, category: "Fiction", subjects: [], publisher: null, bundle: "B",
  year: 2020, formats: [], coverUrl: null, addedAt: "2026-01-01", editions,
});

const noop = async () => {};

describe("WorkAdminControls", () => {
  it("merges into a card found by search, never offering the card itself", async () => {
    const onMerge = vi.fn(noop);
    const card = work("a", "Learning DevOps");
    render(<WorkAdminControls card={card} works={[card, work("b", "Learning DevOps Second"), work("c", "Dune")]}
      selectedEditionId="a" canReset={false} busy={false} onMerge={onMerge} onSplit={noop} onReset={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Merge into…" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find the card to merge into" }), "Learning");
    expect(screen.queryByRole("button", { name: /^Learning DevOps — / })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Learning DevOps Second/ }));
    expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("offers split only for a card with several editions, acting on the selected edition", async () => {
    const onSplit = vi.fn(noop);
    const { rerender } = render(<WorkAdminControls card={work("a", "T")} works={[]} selectedEditionId="a"
      canReset={false} busy={false} onMerge={noop} onSplit={onSplit} onReset={noop} />);
    expect(screen.queryByRole("button", { name: "Split this edition into its own card" })).toBeNull();
    rerender(<WorkAdminControls card={work("a", "T", [edition("a"), edition("b")])} works={[]} selectedEditionId="b"
      canReset={false} busy={false} onMerge={noop} onSplit={onSplit} onReset={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Split this edition into its own card" }));
    expect(onSplit).toHaveBeenCalledWith("b");
  });

  it("offers reset only when the card has corrections", async () => {
    const onReset = vi.fn(noop);
    const { rerender } = render(<WorkAdminControls card={work("a", "T")} works={[]} selectedEditionId="a"
      canReset={false} busy={false} onMerge={noop} onSplit={noop} onReset={onReset} />);
    expect(screen.queryByRole("button", { name: "Reset to automatic grouping" })).toBeNull();
    rerender(<WorkAdminControls card={work("a", "T")} works={[]} selectedEditionId="a"
      canReset busy={false} onMerge={noop} onSplit={noop} onReset={onReset} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset to automatic grouping" }));
    expect(onReset).toHaveBeenCalled();
  });
});
```

Append to `web/src/components/Library.test.tsx`:

```tsx
describe("admin work corrections", () => {
  it("lets an admin merge one card into another", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /works/edits$": () => ({ ok: true, status: 204, headers: new Headers() }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn, isAdmin: true });
    await userEvent.click(await screen.findByText("Attacking Network Protocols"));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge into…" }));
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "Find the card to merge into" }), "Black");
    await userEvent.click(within(dialog).getByRole("button", { name: /The Black Company/ }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith("https://api/works/edits", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ edits: { "1": "2" } }),
    })));
  });

  it("shows no correction controls to readers who are not admins", async () => {
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog) });
    await userEvent.click(await screen.findByText("Attacking Network Protocols"));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Merge into…" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/components/WorkAdminControls.test.tsx src/components/Library.test.tsx`
Expected: FAIL — `./WorkAdminControls` does not exist and no merge button renders.

- [ ] **Step 3: Implement the controls**

Create `web/src/components/WorkAdminControls.tsx`:

```tsx
import { useMemo, useState } from "react";
import { searchBooks } from "../catalog/search";
import type { Book } from "../catalog/types";

interface Props {
  card: Book;
  works: Book[];
  selectedEditionId: string | null;
  canReset: boolean;
  busy: boolean;
  onMerge(target: Book): Promise<void>;
  onSplit(editionId: string): Promise<void>;
  onReset(): Promise<void>;
}

// Admin-only corrections to automatic grouping. The operations themselves are computed in
// catalog/works.ts; this component only chooses what to act on.
export default function WorkAdminControls({ card, works, selectedEditionId, canReset, busy, onMerge, onSplit, onReset }: Props) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () => (query.trim().length < 2 ? [] : searchBooks(works.filter((w) => w.id !== card.id), query).slice(0, 8)),
    [works, card.id, query],
  );
  const editions = card.editions ?? [];

  return (
    <div className="work-admin">
      {!picking && <button className="btn" disabled={busy} onClick={() => setPicking(true)}>Merge into…</button>}
      {editions.length > 1 && selectedEditionId && (
        <button className="btn" disabled={busy} onClick={() => void onSplit(selectedEditionId)}>
          Split this edition into its own card
        </button>
      )}
      {canReset && <button className="btn" disabled={busy} onClick={() => void onReset()}>Reset to automatic grouping</button>}
      {picking && (
        <div className="merge-picker">
          <input type="search" aria-label="Find the card to merge into" placeholder="Search titles or authors…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul>
            {candidates.map((w) => (
              <li key={w.id}>
                <button className="btn" disabled={busy}
                  onClick={() => void onMerge(w).then(() => { setPicking(false); setQuery(""); })}>
                  {w.title}{w.authors[0] ? ` — ${w.authors[0]}` : ""}{w.year ? ` (${w.year})` : ""}
                </button>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => { setPicking(false); setQuery(""); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
```

In `web/src/styles.css`, after the `.editions-chip` rule, add:

```css
.work-admin { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
.merge-picker { flex-basis: 100%; display: grid; gap: 0.4rem; }
.merge-picker ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
```

- [ ] **Step 4: Wire it into the dialog**

In `web/src/components/BookDetail.tsx`, add `import WorkAdminControls from "./WorkAdminControls";`, and add to `Props`:

```ts
  admin?: {
    works: Book[];
    canReset: boolean;
    onMerge(card: Book, target: Book): Promise<void>;
    onSplit(card: Book, editionId: string): Promise<void>;
    onReset(card: Book): Promise<void>;
  };
```

Destructure `admin` in the component signature, and at the end of the right-hand column (after the Kindle block, inside the same `<div>`), add:

```tsx
          {admin && (
            <WorkAdminControls card={book} works={admin.works} selectedEditionId={edition?.id ?? null}
              canReset={admin.canReset} busy={busy}
              onMerge={(target) => admin.onMerge(book!, target)}
              onSplit={(id) => admin.onSplit(book!, id)}
              onReset={() => admin.onReset(book!)} />
          )}
```

- [ ] **Step 5: Wire it into the library**

In `web/src/components/Library.tsx`, change the two imports to:

```tsx
import { createCategory, putWorkEdits, resetWorkEdits, resolveSuggestion, setBookCategory, suggestCategory } from "../catalog/library";
import { groupWorks, mergeEdits, resetEditionIds, splitEdits } from "../catalog/works";
```

After the `resolve` callback, add:

```tsx
  const mergeInto = useCallback(async (card: Book, target: Book) => {
    await mutate((t) => putWorkEdits(apiUrl, t, mergeEdits((card.editions ?? []).map((e) => e.id), target.id), fetchFn),
      `Merged into ${target.title}`);
    setSelectedId(target.id);
  }, [mutate, apiUrl, fetchFn]);
  const splitEdition = useCallback(async (card: Book, editionId: string) => {
    const rows = splitEdits(card.id, (card.editions ?? []).map((e) => ({ id: e.id, addedAt: e.addedAt })), editionId);
    if (Object.keys(rows).length === 0) return;
    await mutate((t) => putWorkEdits(apiUrl, t, rows, fetchFn), "Split into its own card");
  }, [mutate, apiUrl, fetchFn]);
  const resetCard = useCallback(async (card: Book) => {
    const ids = resetEditionIds(books ?? [], (card.editions ?? []).map((e) => e.id), overlay?.workEdits ?? {});
    if (ids.length === 0) return;
    await mutate((t) => resetWorkEdits(apiUrl, t, ids, fetchFn), "Reset to automatic grouping");
  }, [mutate, apiUrl, fetchFn, books, overlay]);
  const canReset = useMemo(
    () => Boolean(selected && books)
      && resetEditionIds(books!, (selected!.editions ?? []).map((e) => e.id), overlay?.workEdits ?? {}).length > 0,
    [selected, books, overlay],
  );
  const adminForDialog = useMemo(
    () => (isAdmin && merged ? { works: merged, canReset, onMerge: mergeInto, onSplit: splitEdition, onReset: resetCard } : undefined),
    [isAdmin, merged, canReset, mergeInto, splitEdition, resetCard],
  );
```

and pass `admin={adminForDialog}` to `<BookDetail ... />`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/WorkAdminControls.tsx web/src/components/WorkAdminControls.test.tsx web/src/components/BookDetail.tsx web/src/components/Library.tsx web/src/components/Library.test.tsx web/src/styles.css
git commit -m "feat(web): admin merge, split and reset for work cards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 17: Documentation and backlog

**Files:**
- Modify: `infra/README.md`
- Modify: `README.md`
- Modify: `BACKLOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: operator documentation; epic 30 closed in the backlog.

- [ ] **Step 1: Document works and editions for operators**

In `infra/README.md`, add a `## Works and editions` section (place it after the `## Adding books` section). It must cover, in the README's plain explanatory voice:

- What a card is now: one work; editions inside; the grouping rules in one short list (identical file, shared ISBN, one bundle's formats; then same title ignoring edition markers plus a shared author; subtitles never stripped; a copy with no authors joins only through files or ISBN).
- That every catalog entry keeps its id and gains `editionId`/`workId`, so reading statuses, downloads and category edits need no migration.
- The grouping report: `cd indexer && .venv/bin/python -m ebook_indexer grouping-report --config ../config.yaml`, that it is read-only apart from `metadata/hashes.json`, and what `out/grouping-report.md` lists.
- That the first publish after this change hashes the whole library once (`metadata/hashes.json`, gitignored), and later publishes hash only new or changed files.
- Admin corrections: merge, split and reset in the book dialog (admins only); stored as `WORKEDIT` rows; applied live; `scripts/pull-edits.py` folds them into `work:` keys and removes a `work:` key with no row — so corrections are made in the app, never by editing `overrides.yaml`. Note that `pull-edits.py` now keeps comments.
- That a managed (corrected) edition does not attract newly published matching books through title and author; reset the card to make it automatic again.
- The API routes `PUT /api/works/edits` and `POST /api/works/edits/reset`, admin-only.
- The known limitation: deleting a work's earliest copy moves its `workId`, and state stored against the old id stops attaching.

- [ ] **Step 2: Mention it in the main README**

In `README.md`, in the features list, add one bullet: "**One card per book.** Copies bought in several bundles, a book's EPUB and PDF, and different editions of a title share a card with an edition picker; admins can merge and split cards."

- [ ] **Step 3: Close epic 30**

In `BACKLOG.md`, under `### 30. Group duplicate editions`, replace the four task lines with:

```markdown
- [x] Pick a match key and count false merges on the real catalog — identical files or ISBN for editions; edition-insensitive title plus a shared author for works (subtitles kept: stripping them merged six Dune novels)
- [x] Group matches in the catalog builder — `editionId` and `workId` on every entry, with a read-only grouping report
- [x] One card per work in the UI, with an edition picker; each download names the copy it serves
- [x] No migration needed — every copy keeps its id, and per-reader state resolves at card level
- [x] Admin merge, split and reset in the app, folded back into `overrides.yaml` by `pull-edits.py`
```

and add below the list: `**Closed by:** spec and plan \`2026-09-14-works-and-editions\`.`

- [ ] **Step 4: Verify nothing else changed**

Run: `git status --short` and confirm only the three documentation files are modified. Run the three test suites once more (indexer, infra, web) and include their summary lines in your report.

- [ ] **Step 5: Commit**

```bash
git add infra/README.md README.md BACKLOG.md
git commit -m "docs: works and editions, admin corrections, and epic 30 closed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

## Notes for the reviewer

- **The shared fixture is the backbone.** Tasks 1, 3, 12 and 13 all assert against `test-fixtures/work-corrections.json`. A failure there means an implementation disagrees with the verified model; the fixture must never be edited to make a test pass. Regenerating it (`python3 scripts/gen-work-corrections-fixture.py`) must reproduce the committed file byte-for-byte.
- **Nothing here touches live AWS.** Rollout (grouping report against the real library, deploy, publish, web deploy, corrections) follows the spec's Rollout section and is run by the user after merge.
- **Deliberate intermediate state:** after Task 14 and before Task 15, downloads send the work's id, which is always a real copy id (the work's earliest copy), so the site keeps working between tasks.
