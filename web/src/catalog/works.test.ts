import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "./types";
import { effectiveWorkIds, editionMarker, groupWorks, mergeEdits, resetEditionIds, splitEdits, type WorkOverlay } from "./works";

interface FixtureStep { op: Record<string, string>; rows: Record<string, string>; cards: string[][] }
interface FixtureCase { editions: string[]; links: string[][]; catalogWorkId: Record<string, string>; steps: FixtureStep[] }
// Indirected through a variable so Vite's dev-server asset-URL transform (which statically
// rewrites the `new URL(literal, import.meta.url)` pattern to an http:// dev-server URL) does
// not match, and this resolves to a real file:// URL as it does under plain Node.
const testFileUrl = import.meta.url;
const fixture = JSON.parse(
  readFileSync(new URL("../../../test-fixtures/work-corrections.json", testFileUrl), "utf8"),
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

describe("editionMarker", () => {
  it("finds explicit edition markers only", () => {
    expect(editionMarker("Clean Code in Python - Second Edition")).toBe("Second Edition");
    expect(editionMarker("Learning DevOps (2nd edition)")).toBe("2nd edition");
    expect(editionMarker("Dune: The Butlerian Jihad")).toBeNull();
  });
});
