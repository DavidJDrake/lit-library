import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "./types";
import { effectiveWorkIds, editionMarker, groupWorks, mergeEdits, orphanEditionIds, resetEditionIds, splitEdits, type WorkOverlay } from "./works";

interface FixtureStep {
  op: Record<string, string>;
  library: number;
  rows: Record<string, string>;
  cards: Record<string, string[]>;
  catalogWorkId?: Record<string, string>;
}
interface FixtureCase { editions: string[]; copies: Record<string, string>; links: string[][]; steps: FixtureStep[] }
// Indirected through a variable so Vite's dev-server asset-URL transform (which statically
// rewrites the `new URL(literal, import.meta.url)` pattern to an http:// dev-server URL) does
// not match, and this resolves to a real file:// URL as it does under plain Node.
const testFileUrl = import.meta.url;
const fixture = JSON.parse(
  readFileSync(new URL("../../../test-fixtures/work-corrections.json", testFileUrl), "utf8"),
) as { cases: FixtureCase[] };

function cardsOf(workOf: Map<string, string>): Record<string, string[]> {
  const by: Record<string, string[]> = {};
  for (const [id, w] of workOf) (by[w] ??= []).push(id);
  for (const ids of Object.values(by)) ids.sort();
  return by;
}

const copy = (id: string, over: Partial<Book> = {}): Book => ({
  id, title: "The Works, Volume 1", authors: ["Edgar Allan Poe"], description: null, category: "Fiction",
  subjects: [], publisher: null, bundle: "B", year: 1903, formats: [{ type: "epub", size: 1, s3Key: `k-${id}` }],
  coverUrl: null, addedAt: "2026-09-04", editionId: id, workId: id, ...over,
});

const overlay = (over: Partial<WorkOverlay> = {}): WorkOverlay => ({
  bookCategories: {}, readingStatuses: {}, downloaded: [], ...over,
});

// The catalog a site sees after a fixture publish: the editions present, their copies, every
// edition's automatic links (on its canonical entry), and the workId that publish computed.
function fixtureCatalog(c: FixtureCase, library: number, catalogWorkId: Record<string, string>): Book[] {
  const present = c.editions.slice(0, library);
  const books: Book[] = [];
  for (const [i, e] of present.entries()) {
    const links = c.links.filter((l) => l.includes(e)).map((l) => (l[0] === e ? l[1] : l[0]))
      .filter((o) => present.includes(o)).sort();
    const at = String(i).padStart(2, "0");
    books.push(copy(e, { editionId: e, workId: catalogWorkId[e], addedAt: `2026-01-01T00:00:${at}`, ...(links.length ? { workLinks: links } : {}) }));
    for (const [copyId, of] of Object.entries(c.copies)) {
      if (of === e) books.push(copy(copyId, { editionId: e, workId: catalogWorkId[copyId], addedAt: `2026-01-01T00:01:${at}` }));
    }
  }
  return books;
}

const cardsWithIds = (cards: Book[]) =>
  Object.fromEntries(cards.map((w) => [w.id, w.editions!.map((e) => e.id).sort()]));

describe("effectiveWorkIds", () => {
  const entry = (id: string, over: Partial<Book> = {}) => ({ id, editionId: id, workId: id, addedAt: "2026-01-01", ...over });

  it("uses the catalog workId until the overlay has loaded, and an entry's own id when fields are missing", () => {
    const out = effectiveWorkIds([entry("a"), entry("b", { workId: "a" }), { id: "c", addedAt: "2026-01-01" }], null);
    expect(Object.fromEntries(out)).toEqual({ a: "a", b: "a", c: "c" });
  });

  it("groups over automatic links, not the catalog workId, once the overlay has loaded", () => {
    const entries = [entry("a", { workLinks: ["b"] }), entry("b", { workId: "a", workLinks: ["a"] }), entry("c", { workId: "a" })];
    expect(Object.fromEntries(effectiveWorkIds(entries, {}))).toEqual({ a: "a", b: "a", c: "c" });
  });

  it("skips links that touch a managed edition and joins managed editions to their targets", () => {
    const entries = [
      entry("a", { addedAt: "1", workLinks: ["b"] }), entry("b", { addedAt: "2", workLinks: ["a", "c"] }),
      entry("c", { addedAt: "3", workLinks: ["b"] }), entry("d", { addedAt: "4" }),
    ];
    expect(cardsOf(effectiveWorkIds(entries, { b: "b" }))).toEqual({ a: ["a"], b: ["b"], c: ["c"], d: ["d"] });
    expect(cardsOf(effectiveWorkIds(entries, { d: "c" }))).toEqual({ a: ["a", "b", "c", "d"] });
  });

  it("names a card after its earliest-added edition, ties on the smallest id", () => {
    const entries = [entry("b", { addedAt: "2026-01-01" }), entry("a", { addedAt: "2026-01-01" }), entry("0", { addedAt: "2026-02-01" })];
    expect(cardsOf(effectiveWorkIds(entries, { "0": "b", b: "a" }))).toEqual({ a: ["0", "a", "b"] });
  });

  it("applies rows keyed by or naming a non-canonical copy to its edition, the edition's own row winning", () => {
    const entries = [
      entry("a", { addedAt: "1" }), entry("b", { addedAt: "2" }), entry("c", { addedAt: "3" }),
      entry("c2", { editionId: "c", workId: "c", addedAt: "4" }), entry("c3", { editionId: "c", workId: "c", addedAt: "5" }),
    ];
    expect(effectiveWorkIds(entries, { c2: "a" }).get("c3")).toBe("a");
    expect(effectiveWorkIds(entries, { b: "c3" }).get("c")).toBe("b");
    expect(effectiveWorkIds(entries, { c2: "b", c: "a" }).get("c")).toBe("a");
    expect(effectiveWorkIds(entries, { c3: "b", c2: "a" }).get("c")).toBe("a");
  });

  it("ignores a row keyed by an unknown id and leaves an edition naming an unknown target on its own card, warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = [entry("a", { workLinks: ["b"] }), entry("b", { workLinks: ["a"] })];
    expect(cardsOf(effectiveWorkIds(entries, { zz: "a" }))).toEqual({ a: ["a", "b"] });
    expect(cardsOf(effectiveWorkIds(entries, { b: "yy" }))).toEqual({ a: ["a"], b: ["b"] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("gives every step of the shared fixture its recorded cards and ids, with and without the overlay", () => {
    for (const [n, c] of fixture.cases.entries()) {
      let catalog: Book[] = [];
      for (const [s, step] of c.steps.entries()) {
        if (step.catalogWorkId) {
          catalog = fixtureCatalog(c, step.library, step.catalogWorkId);
          expect(cardsWithIds(groupWorks(catalog, null)), `case ${n} step ${s}: catalog workId`).toEqual(step.cards);
        }
        expect(cardsWithIds(groupWorks(catalog, overlay({ workEdits: step.rows }))), `case ${n} step ${s}`).toEqual(step.cards);
      }
    }
  });
});

describe("groupWorks", () => {
  const entries = [
    copy("a", { bundle: "Lovecraft Circle", addedAt: "2026-09-04", workLinks: ["c"],
      formats: [{ type: "epub", size: 1, s3Key: "a-epub" }, { type: "pdf", size: 2, s3Key: "a-pdf" }] }),
    copy("b", { editionId: "a", workId: "a", bundle: "Poe", addedAt: "2026-09-13",
      formats: [{ type: "epub", size: 1, s3Key: "b-epub" }] }),
    copy("c", { workId: "a", workLinks: ["a"], title: "The Works, Volume 1, Second Edition", year: 1910, bundle: "Other", addedAt: "2026-09-05" }),
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
    expect(groupWorks(entries, overlay()).map((w) => w.id)).toEqual(["a"]);
    const cards = groupWorks(entries, overlay({ workEdits: { c: "c" } }));
    expect(cards.map((w) => w.id).sort()).toEqual(["a", "c"]);
  });

  it("treats entries from an older catalog as their own cards", () => {
    const old = [copy("x", { editionId: undefined, workId: undefined }), copy("y", { editionId: undefined, workId: undefined })];
    expect(groupWorks(old, null).map((w) => w.id)).toEqual(["x", "y"]);
    expect(groupWorks(old, overlay()).map((w) => w.id)).toEqual(["x", "y"]);
    expect(groupWorks(old, overlay({ workEdits: { y: "x" } })).map((w) => w.id)).toEqual(["x"]);
  });
});

describe("correction row builders", () => {
  it("merge assigns every edition of the source card to the target", () => {
    expect(mergeEdits(["x", "y"], "w")).toEqual({ x: "w", y: "w" });
  });

  it("split of a later edition writes it alone and pins the rest to the card, leaving the remainder itself unmanaged", () => {
    const eds = [{ id: "a", addedAt: "1" }, { id: "b", addedAt: "2" }, { id: "c", addedAt: "3" }];
    expect(splitEdits("a", eds, "b", {})).toEqual({ b: "b", c: "a" });
  });

  it("split of the card's earliest edition moves the remainder to the next-earliest, still unmanaged", () => {
    const eds = [{ id: "a", addedAt: "1" }, { id: "b", addedAt: "2" }, { id: "c", addedAt: "3" }];
    expect(splitEdits("a", eds, "a", {})).toEqual({ a: "a", c: "b" });
  });

  it("split of a card's only edition writes nothing", () => {
    expect(splitEdits("a", [{ id: "a", addedAt: "1" }], "a", {})).toEqual({});
  });

  it("writes the remainder's own row only when it already had one, clearing a stale target", () => {
    const eds = [{ id: "r", addedAt: "1" }, { id: "s", addedAt: "2" }];
    // r already pointed at s (the edition about to be split off); left alone that row
    // would still say so afterwards, so it must be overwritten, not just left out.
    expect(splitEdits("r", eds, "s", { r: "s" })).toEqual({ s: "s", r: "r" });
  });

  it("resolves the remainder's existing row through its non-canonical copies too", () => {
    const eds = [{ id: "r", addedAt: "1", copyIds: ["r", "r2"] }, { id: "s", addedAt: "2", copyIds: ["s"] }];
    expect(splitEdits("r", eds, "s", { r2: "z" })).toEqual({ s: "s", r: "r" });
  });

  it("reset returns every row whose edition shares an automatic work with the card, copy-keyed rows included", () => {
    const entries = [
      { id: "a", editionId: "a", addedAt: "1", workLinks: ["b"] }, { id: "b", editionId: "b", addedAt: "2", workLinks: ["a"] },
      { id: "b2", editionId: "b", addedAt: "3" }, { id: "z", editionId: "z", addedAt: "4" },
    ];
    expect(resetEditionIds(entries, ["a"], { a: "a", b2: "z", z: "z", gone: "a" })).toEqual(["a", "b2"]);
    expect(resetEditionIds(entries, ["z"], { a: "a", b: "b" })).toEqual([]);
  });

  it("orphan rows are those keyed by neither an edition nor a copy in the catalog, sorted", () => {
    const entries = [
      { id: "a", editionId: "a", addedAt: "1" },
      { id: "b2", editionId: "b", addedAt: "2" },
    ];
    expect(orphanEditionIds(entries, { a: "a", b2: "z", gone: "a", z: "gone" })).toEqual(["gone", "z"]);
    expect(orphanEditionIds(entries, {})).toEqual([]);
  });

  it("replays every operation in the shared fixture to the recorded rows", () => {
    for (const [n, c] of fixture.cases.entries()) {
      let catalog: Book[] = [];
      let rows: Record<string, string> = {};
      for (const [s, step] of c.steps.entries()) {
        const cards = groupWorks(catalog, overlay({ workEdits: rows }));
        const card = (id: string) => cards.find((w) => w.id === id)!;
        const holding = (edition: string) => cards.find((w) => w.editions!.some((e) => e.id === edition))!;
        const op = step.op;
        if (op.kind === "publish") {
          catalog = fixtureCatalog(c, step.library, step.catalogWorkId!);
        } else if (op.kind === "merge") {
          rows = { ...rows, ...mergeEdits(card(op.from).editions!.map((e) => e.id), op.into) };
        } else if (op.kind === "split") {
          const w = holding(op.edition);
          rows = {
            ...rows,
            ...splitEdits(w.id, w.editions!.map((e) => ({ id: e.id, addedAt: e.addedAt, copyIds: e.copyIds })), op.edition, rows),
          };
        } else if (op.kind === "reset") {
          const drop = new Set(resetEditionIds(catalog, card(op.card).editions!.map((e) => e.id), rows));
          rows = Object.fromEntries(Object.entries(rows).filter(([e]) => !drop.has(e)));
        } else {
          rows = { ...rows, [op.key]: op.target };
        }
        expect(rows, `case ${n} step ${s}`).toEqual(step.rows);
      }
    }
  });
});

describe("editionMarker", () => {
  it("finds explicit edition markers only", () => {
    expect(editionMarker("Clean Code in Python - Second Edition")).toBe("Second Edition");
    expect(editionMarker("Learning DevOps (2nd edition)")).toBe("2nd edition");
    expect(editionMarker("Dune: The Butlerian Jihad")).toBeNull();
  });
});
