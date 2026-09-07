import { describe, expect, it } from "vitest";
import {
  applyFilters, buildSearchIndex, facetCounts, facetValues, filtersFromSearch, formatSize, queryFromSearch,
  searchBooks, searchFromView, sortBooks, sortFromSearch, viewFromSearch, type ViewState,
} from "./search";
import { emptyFilters, FACET_KEYS, type Book, type SortKey } from "./types";

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
  it("filters on the reading-status facet across all four values, ORing within it", () => {
    const withStatus = [
      { ...books[0], readingStatus: "reading" as const, downloaded: false },
      { ...books[1], readingStatus: null, downloaded: true },
      { ...books[2], readingStatus: "finished" as const, downloaded: true },
    ];
    const wantReading = emptyFilters();
    wantReading.status.add("reading");
    expect(applyFilters(withStatus, wantReading).map((b) => b.id)).toEqual(["1"]);

    const wantDownloaded = emptyFilters();
    wantDownloaded.status.add("downloaded");
    expect(applyFilters(withStatus, wantDownloaded).map((b) => b.id)).toEqual(["2", "3"]);

    // Checking two status values ORs them (matches either), like any other facet.
    const wantEither = emptyFilters();
    wantEither.status.add("reading"); wantEither.status.add("finished");
    expect(applyFilters(withStatus, wantEither).map((b) => b.id)).toEqual(["1", "3"]);

    const wantWantToRead = emptyFilters();
    wantWantToRead.status.add("want to read");
    expect(applyFilters(withStatus, wantWantToRead)).toHaveLength(0);
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

describe("facetValues for status", () => {
  it("is empty when neither a status nor downloaded is set", () => {
    expect(facetValues(book({ id: "1", title: "x" }), "status")).toEqual([]);
  });
  it("carries just the status, just downloaded, or both, as independent facts", () => {
    expect(facetValues(book({ id: "1", title: "x", readingStatus: "reading" }), "status")).toEqual(["reading"]);
    expect(facetValues(book({ id: "1", title: "x", downloaded: true }), "status")).toEqual(["downloaded"]);
    expect(facetValues(book({ id: "1", title: "x", readingStatus: "finished", downloaded: true }), "status")).toEqual(["finished", "downloaded"]);
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

  it("seeds every facet, each repeatable for multiple values", () => {
    const f = filtersFromSearch(
      "?category=Fiction&format=epub&format=pdf&publisher=Tor&bundle=B1&author=Glen+Cook&year=1984",
    );
    expect([...f.category]).toEqual(["Fiction"]);
    expect([...f.format]).toEqual(["epub", "pdf"]);
    expect([...f.publisher]).toEqual(["Tor"]);
    expect([...f.bundle]).toEqual(["B1"]);
    expect([...f.author]).toEqual(["Glen Cook"]);
    expect([...f.year]).toEqual(["1984"]);
  });

  it("ignores unknown keys and unrecognised query strings without throwing", () => {
    const f = filtersFromSearch("?nonsense=1&category=&q=hi&sort=bogus");
    for (const key of FACET_KEYS) expect(f[key].size).toBe(0);
  });
});

describe("queryFromSearch", () => {
  it("reads the q parameter, defaulting to empty", () => {
    expect(queryFromSearch("?q=rust+backend")).toBe("rust backend");
    expect(queryFromSearch("")).toBe("");
    expect(queryFromSearch("?category=Fiction")).toBe("");
  });
});

describe("sortFromSearch", () => {
  it.each(["title", "author", "year", "added"] as const)("reads a known sort value %s", (key) => {
    expect(sortFromSearch(`?sort=${key}`)).toBe(key);
  });
  it("falls back to added for a missing or unrecognised sort", () => {
    expect(sortFromSearch("")).toBe("added");
    expect(sortFromSearch("?sort=relevance")).toBe("added");
    expect(sortFromSearch("?sort=bogus")).toBe("added");
  });
});

describe("searchFromView", () => {
  const view = (over: Partial<ViewState> = {}): ViewState => ({ query: "", filters: emptyFilters(), sort: "added", ...over });

  it("omits everything at its default for an unfiltered, unsorted, unsearched view", () => {
    expect(searchFromView(view())).toBe("");
  });

  it("includes q only for non-blank search text, trimmed", () => {
    expect(searchFromView(view({ query: "  " }))).toBe("");
    expect(searchFromView(view({ query: "  rust backend  " }))).toBe("?q=rust+backend");
  });

  it("escapes search text that needs it", () => {
    const s = searchFromView(view({ query: "C++ & friends?" }));
    expect(s).toBe("?q=C%2B%2B+%26+friends%3F");
    expect(queryFromSearch(s)).toBe("C++ & friends?");
  });

  it.each(["title", "author", "year"] as const)("includes a non-default sort (%s)", (sort: SortKey) => {
    expect(searchFromView(view({ sort }))).toBe(`?sort=${sort}`);
  });

  it("omits the default sort (added)", () => {
    expect(searchFromView(view({ sort: "added" }))).toBe("");
  });

  it("repeats a facet key for multiple values, sorted for a stable URL", () => {
    const filters = emptyFilters();
    filters.format.add("pdf");
    filters.format.add("epub");
    expect(searchFromView(view({ filters }))).toBe("?format=epub&format=pdf");
  });

  it("combines search text, sort and several facets in one query string", () => {
    const filters = emptyFilters();
    filters.category.add("Fiction");
    filters.author.add("Glen Cook");
    const s = searchFromView(view({ query: "cook", sort: "title", filters }));
    expect(s).toBe("?q=cook&sort=title&category=Fiction&author=Glen+Cook");
  });
});

describe("view round trip", () => {
  it("comes back unchanged after state → string → state, for every facet, search text and sort", () => {
    const filters = emptyFilters();
    filters.category.add("Fiction");
    filters.category.add("Comics");
    filters.format.add("epub");
    filters.publisher.add("Tor");
    filters.bundle.add("B1");
    filters.author.add("Glen Cook");
    filters.year.add("1984");
    const original: ViewState = { query: "netwrok protocol", sort: "year", filters };

    const roundTripped = viewFromSearch(searchFromView(original));

    expect(roundTripped.query).toBe(original.query);
    expect(roundTripped.sort).toBe(original.sort);
    for (const key of FACET_KEYS) expect([...roundTripped.filters[key]]).toEqual([...original.filters[key]].sort());
  });

  it("round-trips the all-default view to and from a bare path", () => {
    const original: ViewState = { query: "", sort: "added", filters: emptyFilters() };
    expect(searchFromView(original)).toBe("");
    expect(viewFromSearch(searchFromView(original))).toEqual(original);
  });
});
