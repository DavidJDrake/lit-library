import { describe, expect, it } from "vitest";
import { applyFilters, buildSearchIndex, facetCounts, filtersFromSearch, formatSize, searchBooks, sortBooks } from "./search";
import { emptyFilters, type Book } from "./types";

function book(over: Partial<Book> & { id: string; title: string }): Book {
  return {
    authors: [], description: null, category: "Fiction", subjects: [], publisher: null,
    bundle: "B", year: null, formats: [{ type: "epub", size: 1, s3Key: "k" }], coverUrl: null,
    addedAt: "2026-01-01", ...over,
  };
}

const books: Book[] = [
  book({ id: "1", title: "Attacking Network Protocols", authors: ["James Forshaw"], category: "Security & Hacking", publisher: "No Starch Press", year: 2018, formats: [{ type: "epub", size: 1, s3Key: "a" }, { type: "pdf", size: 2, s3Key: "b" }], addedAt: "2026-02-01" }),
  book({ id: "2", title: "The Black Company", authors: ["Glen Cook"], category: "Fiction", publisher: "Tor", year: 1984, formats: [], addedAt: "2026-03-01" }),
  book({ id: "3", title: "Zero to Production", authors: ["Luca Palmieri"], category: "Tech & Programming", publisher: "No Starch Press", year: 2022, formats: [{ type: "pdf", size: 3, s3Key: "c" }], addedAt: "2026-01-15", description: "Backend development in Rust." }),
];

describe("applyFilters", () => {
  it("returns everything with empty filters", () => {
    expect(applyFilters(books, emptyFilters())).toHaveLength(3);
  });
  it("ORs within a facet and ANDs across facets", () => {
    const f = emptyFilters();
    f.publisher.add("No Starch Press");
    expect(applyFilters(books, f).map((b) => b.id)).toEqual(["1", "3"]);
    f.format.add("epub");
    expect(applyFilters(books, f).map((b) => b.id)).toEqual(["1"]);
    f.category.add("Fiction"); f.category.add("Security & Hacking");
    expect(applyFilters(books, f).map((b) => b.id)).toEqual(["1"]);
  });
  it("filters by year as a string and by author", () => {
    const f = emptyFilters();
    f.year.add("1984");
    expect(applyFilters(books, f).map((b) => b.id)).toEqual(["2"]);
    const g = emptyFilters();
    g.author.add("Luca Palmieri");
    expect(applyFilters(books, g).map((b) => b.id)).toEqual(["3"]);
  });
});

describe("searchBooks", () => {
  it("returns input unchanged for an empty query", () => {
    expect(searchBooks(books, "  ")).toBe(books);
  });
  it("fuzzy-matches titles, authors, and descriptions", () => {
    expect(searchBooks(books, "netwrok protocol").map(b => b.id)).toContain("1");
    expect(searchBooks(books, "rust backend").map(b => b.id)).toContain("3");
  });
  it("handles reordered query terms (word-order independent)", () => {
    expect(searchBooks(books, "cook glen").map(b => b.id)).toContain("2");
    expect(searchBooks(books, "protocol network").map(b => b.id)).toContain("1");
  });
  it("drops non-matches", () => {
    expect(searchBooks(books, "quantum chromodynamics")).toHaveLength(0);
  });
  it("returns the same results with a prebuilt index as without one", () => {
    const index = buildSearchIndex(books);
    expect(searchBooks(books, "netwrok protocol", index)).toEqual(searchBooks(books, "netwrok protocol"));
    expect(searchBooks(books, "cook glen", index)).toEqual(searchBooks(books, "cook glen"));
  });
});

describe("sortBooks", () => {
  it("sorts by title case-insensitively without mutating", () => {
    const out = sortBooks(books, "title");
    expect(out.map((b) => b.id)).toEqual(["1", "2", "3"]);
    expect(books[0].id).toBe("1");
  });
  it("sorts by year newest first with unknown last", () => {
    const withUnknown = [...books, book({ id: "4", title: "Undated" })];
    expect(sortBooks(withUnknown, "year").map((b) => b.id)).toEqual(["3", "1", "2", "4"]);
  });
  it("sorts by recently added", () => {
    expect(sortBooks(books, "added").map((b) => b.id)).toEqual(["2", "1", "3"]);
  });
  it("sorts by first author", () => {
    expect(sortBooks(books, "author").map((b) => b.id)).toEqual(["2", "1", "3"]);
  });
});

describe("facetCounts", () => {
  it("counts values, most common first then alphabetical", () => {
    expect(facetCounts(books, "publisher")).toEqual([
      { value: "No Starch Press", count: 2 }, { value: "Tor", count: 1 },
    ]);
    expect(facetCounts(books, "format")).toEqual([
      { value: "pdf", count: 2 }, { value: "epub", count: 1 },
    ]);
  });
});

describe("formatSize", () => {
  it("formats KB and MB", () => {
    expect(formatSize(850 * 1024)).toBe("850 KB");
    expect(formatSize(12.34 * 1024 * 1024)).toBe("12.3 MB");
  });
});

describe("filtersFromSearch", () => {
  it("seeds the category facet from ?category= (repeatable) and ignores other keys", () => {
    const f = filtersFromSearch("?category=Fiction&category=Comics&sort=title");
    expect([...f.category]).toEqual(["Fiction", "Comics"]);
    expect(f.author.size).toBe(0);
    expect(filtersFromSearch("").category.size).toBe(0);
  });
});
