import Fuse from "fuse.js";
import { FACET_KEYS, type Book, type FacetKey, type Filters, type SortKey } from "./types";

export function facetValues(book: Book, key: FacetKey): string[] {
  switch (key) {
    case "category": return [book.category];
    case "format": return book.formats.map((f) => f.type);
    case "publisher": return book.publisher ? [book.publisher] : [];
    case "bundle": return [book.bundle];
    case "author": return book.authors;
    case "year": return book.year ? [String(book.year)] : [];
  }
}

export function applyFilters(books: Book[], filters: Filters): Book[] {
  const active = FACET_KEYS.filter((k) => filters[k].size > 0);
  if (active.length === 0) return books;
  return books.filter((b) => active.every((k) => facetValues(b, k).some((v) => filters[k].has(v))));
}

export function searchBooks(books: Book[], query: string): Book[] {
  const q = query.trim();
  if (!q) return books;
  const fuse = new Fuse(books, {
    keys: [{ name: "title", weight: 2 }, { name: "authors", weight: 1 }, { name: "description", weight: 1 }],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return fuse.search(q).map((r) => r.item);
}

const byTitle = (a: Book, b: Book) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

export function sortBooks(books: Book[], key: SortKey): Book[] {
  const out = [...books];
  switch (key) {
    case "title": return out.sort(byTitle);
    case "author": return out.sort((a, b) =>
      (a.authors[0] ?? "￿").localeCompare(b.authors[0] ?? "￿", undefined, { sensitivity: "base" }) || byTitle(a, b));
    case "year": return out.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || byTitle(a, b));
    case "added": return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || byTitle(a, b));
  }
}

export function facetCounts(books: Book[], key: FacetKey): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const b of books) for (const v of facetValues(b, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
