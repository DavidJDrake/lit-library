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
