#!/usr/bin/env python3
"""Generate test-fixtures/work-corrections.json: the reference behaviour of admin work
corrections, shared by the indexer's tests and the site's tests.

The site and a publish group works with one model (see "Applying corrections on the
site" in docs/superpowers/specs/2026-09-14-works-and-editions-design.md):
  * map each correction row's key and target through copy id -> edition id; a row whose
    key is unknown is ignored, and a row whose target is unknown leaves its edition
    managed but joined to nothing; when several rows map to one edition, the row keyed
    by the edition id wins, otherwise the smallest key;
  * managed editions are those with a row;
  * union along every automatic title-and-author link whose ends are both unmanaged;
  * union each managed edition with its target;
  * a card's id is its earliest-added edition.
The indexer implements this in group_copies (rows folded into `work` overrides); the
site implements it in groupWorks over the catalog's `workLinks` and the overlay's
`workEdits`.

Each case is a small library of editions in added order, some with a second
(non-canonical) copy, and automatic links between some editions, including editions
that have not arrived yet. Its steps interleave publishes, which may add editions, with
merge, split and reset operations made on the site and occasional stale rows (keyed by
or naming a copy id, or an id no longer in the library). A publish records the catalog
`workId` of every entry, which carries the rows of that moment. Every step records the
rows and the cards, with their ids. The script refuses to write a fixture in which an
operation does not do what it was asked, or in which resetting every corrected card
fails to restore automatic grouping.

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
UNKNOWN = "z"


class Library:
    """The editions present after some publish: `editions` in added order, `copies` mapping a
    non-canonical copy id to its edition, and the automatic links between present editions."""

    def __init__(self, editions, copies, links):
        self.editions = list(editions)
        present = set(self.editions)
        self.copies = {c: e for c, e in copies.items() if e in present}
        self.links = [tuple(link) for link in links if link[0] in present and link[1] in present]
        self.edition_of = {e: e for e in self.editions} | self.copies

    def added(self, edition):
        return self.editions.index(edition)


def _union_find(items):
    parent = {i: i for i in items}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        parent[find(a)] = find(b)

    return find, union


def managed_targets(lib, rows):
    """edition -> target edition (None when the target is unknown), for every managed edition."""
    chosen = {}
    for key in sorted(rows):
        edition = lib.edition_of.get(key)
        if edition is None:
            continue
        if edition not in chosen or key == edition:
            chosen[edition] = key
    return {e: lib.edition_of.get(rows[k]) for e, k in chosen.items()}


def cards(lib, rows):
    """card id -> sorted edition ids."""
    managed = managed_targets(lib, rows)
    find, union = _union_find(lib.editions)
    for a, b in lib.links:
        if a not in managed and b not in managed:
            union(a, b)
    for e, target in managed.items():
        if target is not None:
            union(e, target)
    groups = {}
    for e in lib.editions:
        groups.setdefault(find(e), []).append(e)
    return {min(g, key=lib.added): sorted(g) for g in groups.values()}


def card_of(lib, rows):
    return {e: cid for cid, members in cards(lib, rows).items() for e in members}


def automatic_scope(lib, editions):
    """Every edition in the automatic components (links only, ignoring rows) of `editions`."""
    auto = card_of(lib, {})
    wanted = {auto[e] for e in editions}
    return {e for e in lib.editions if auto[e] in wanted}


def reset_keys(lib, rows, card_editions):
    scope = automatic_scope(lib, card_editions)
    return sorted(k for k in rows if lib.edition_of.get(k) in scope)


def op_merge(lib, rows, source, target):
    new = dict(rows)
    for e in cards(lib, rows)[source]:
        new[e] = target
    return new


def op_split(lib, rows, edition):
    card = card_of(lib, rows)[edition]
    rest = [e for e in cards(lib, rows)[card] if e != edition]
    if not rest:
        return dict(rows)
    remainder = card if edition != card else min(rest, key=lib.added)
    new = dict(rows)
    new[edition] = edition
    for e in rest:
        new[e] = remainder
    return new


def op_reset(lib, rows, card):
    drop = set(reset_keys(lib, rows, cards(lib, rows)[card]))
    return {k: w for k, w in rows.items() if k not in drop}


def catalog_work_ids(lib, rows):
    of = card_of(lib, rows)
    return {entry: of[e] for entry, e in sorted(lib.edition_of.items())}


def _membership(groups):
    return sorted(tuple(sorted(g)) for g in groups)


def check_intent(lib, before_rows, after_rows, op):
    """Raise when an operation did not produce the cards the admin asked for."""
    before, after = cards(lib, before_rows), cards(lib, after_rows)
    after_of = card_of(lib, after_rows)
    kind = op["kind"]
    if kind == "merge":
        joined = sorted(before[op["from"]] + before[op["into"]])
        others = [m for cid, m in before.items() if cid not in (op["from"], op["into"])]
        ok = after[after_of[op["into"]]] == joined and _membership(after.values()) == _membership(others + [joined])
    elif kind == "split":
        s = op["edition"]
        card = card_of(lib, before_rows)[s]
        rest = [e for e in before[card] if e != s]
        others = [m for cid, m in before.items() if cid != card]
        ok = (after_rows == before_rows if not rest
              else after[after_of[s]] == [s] and _membership(after.values()) == _membership(others + [[s], rest]))
    elif kind == "reset":
        members = before[op["card"]]
        scope = automatic_scope(lib, members)
        auto, auto_of = cards(lib, {}), card_of(lib, {})
        ok = (not any(lib.edition_of.get(k) in scope for k in after_rows)
              and all(set(auto[auto_of[e]]) <= set(after[after_of[e]]) for e in members))
    else:
        ok = True
    if not ok:
        raise SystemExit(f"{kind} did not do what was asked: {lib.editions} {lib.links} {lib.copies} "
                         f"{op} rows {before_rows} -> {after_rows}: {before} -> {after}")


def restores_automatic_grouping(lib, rows):
    rows = dict(rows)
    for _ in range(50):
        pending = sorted(k for k in rows if k in lib.edition_of)
        if not pending:
            break
        rows = op_reset(lib, rows, card_of(lib, rows)[lib.edition_of[pending[0]]])
    return cards(lib, rows) == cards(lib, {})


def make_case(rng):
    total = rng.randint(2, len(LETTERS))
    everything = list(LETTERS[:total])
    links = [[a, b] for i, a in enumerate(everything) for b in everything[i + 1:] if rng.random() < 0.3]
    copies = {e.upper(): e for e in everything if rng.random() < 0.25}
    present = rng.randint(2, total)
    lib = Library(everything[:present], copies, links)
    rows = {}
    steps = [{"op": {"kind": "publish"}, "library": present, "catalogWorkId": catalog_work_ids(lib, rows),
              "rows": {}, "cards": cards(lib, rows)}]
    for _ in range(rng.randint(2, 8)):
        roll = rng.random()
        current = sorted(cards(lib, rows), key=lib.added)
        if roll < 0.2:
            present = min(total, present + rng.choice([0, 1, 1, 2]))
            lib = Library(everything[:present], copies, links)
            op = {"kind": "publish"}
        elif roll < 0.45 and len(current) > 1:
            source, target = rng.sample(current, 2)
            op = {"kind": "merge", "from": source, "into": target}
        elif roll < 0.7:
            op = {"kind": "split", "edition": rng.choice(lib.editions)}
        elif roll < 0.92:
            op = {"kind": "reset", "card": rng.choice(current)}
        else:
            ids = sorted(lib.edition_of) + [UNKNOWN]
            op = {"kind": "stale", "key": rng.choice(ids), "target": rng.choice(ids)}
        before = rows
        if op["kind"] == "merge":
            rows = op_merge(lib, rows, op["from"], op["into"])
        elif op["kind"] == "split":
            rows = op_split(lib, rows, op["edition"])
        elif op["kind"] == "reset":
            rows = op_reset(lib, rows, op["card"])
        elif op["kind"] == "stale":
            rows = {**rows, op["key"]: op["target"]}
        check_intent(lib, before, rows, op)
        step = {"op": op, "library": present, "rows": dict(sorted(rows.items())), "cards": cards(lib, rows)}
        if op["kind"] == "publish":
            step["catalogWorkId"] = catalog_work_ids(lib, rows)
        steps.append(step)
    if not restores_automatic_grouping(lib, rows):
        raise SystemExit(f"reset did not restore automatic grouping: {lib.editions} {lib.links} {rows}")
    return {"editions": everything, "copies": dict(sorted(copies.items())), "links": links, "steps": steps}


def _arrives_linked_to_managed(case, prev, step):
    if step["op"]["kind"] != "publish" or step["library"] == prev["library"]:
        return False
    lib = Library(case["editions"][:step["library"]], case["copies"], case["links"])
    arrived = set(case["editions"][prev["library"]:step["library"]])
    managed = set(managed_targets(lib, step["rows"]))
    return any({a, b} & arrived and {a, b} & managed for a, b in lib.links)


def generate(cases, seed):
    rng = random.Random(seed)
    made = [make_case(rng) for _ in range(cases)]
    kinds = {s["op"]["kind"] for c in made for s in c["steps"]}
    if kinds != {"publish", "merge", "split", "reset", "stale"}:
        raise SystemExit(f"fixture does not exercise every operation: {sorted(kinds)}")
    if not any(_arrives_linked_to_managed(c, prev, step) for c in made for prev, step in zip(c["steps"], c["steps"][1:])):
        raise SystemExit("fixture has no publish adding an edition linked to a managed edition")
    return {"version": 2, "cases": made}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "test-fixtures" / "work-corrections.json"))
    ap.add_argument("--cases", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20260914)
    ap.add_argument("--explain-bridge", action="store_true")
    args = ap.parse_args(argv[1:])

    if args.explain_bridge:
        lib = Library(["a", "b", "c"], {}, [["a", "b"], ["b", "c"]])
        rows = op_split(lib, {}, "b")
        print(json.dumps({"rows": dict(sorted(rows.items())), "cards": cards(lib, rows)}, sort_keys=True))
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(generate(args.cases, args.seed), indent=1, sort_keys=True) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
