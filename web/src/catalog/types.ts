export interface BookFormat { type: string; size: number; s3Key: string }

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

// The three states a reader sets deliberately. "downloaded" (see Book.downloaded below) is
// a fourth, derived state shown alongside these but never settable through this type.
export type ReadingStatus = "want to read" | "reading" | "finished";
export const READING_STATUSES: readonly ReadingStatus[] = ["want to read", "reading", "finished"];

export interface Book {
  id: string;
  title: string;
  authors: string[];
  description: string | null;
  category: string;
  subjects: string[];
  publisher: string | null;
  bundle: string;
  year: number | null;
  formats: BookFormat[];
  coverUrl: string | null;
  addedAt: string;
  // Overlay-only, like `category`: absent (undefined) until the overlay has loaded, then
  // merged in by groupWorks. readingStatus is null when the reader has no status set;
  // downloaded is independent of it — a book can be downloaded and also want-to-read,
  // reading, finished, or none of those.
  readingStatus?: ReadingStatus | null;
  downloaded?: boolean;
  // From catalog.json; absent in catalogs from before works and editions, which means the
  // entry is its own edition and work. A work card sets both to its own id.
  editionId?: string;
  workId?: string;
  // From catalog.json, on an edition's canonical entry only: the other editions linked to it by
  // title and author, ignoring corrections. Absent when there are none, or in older catalogs.
  workLinks?: string[];
  // Set only on work cards built by groupWorks: every bundle containing a copy, and the
  // editions, newest first.
  bundles?: string[];
  editions?: Edition[];
}

export interface Catalog { generatedAt: string; books: Book[] }

export const FACET_KEYS = ["category", "format", "publisher", "bundle", "author", "year", "status"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];
export type Filters = Record<FacetKey, Set<string>>;
export type SortKey = "title" | "author" | "year" | "added";

export function emptyFilters(): Filters {
  return {
    category: new Set(), format: new Set(), publisher: new Set(), bundle: new Set(), author: new Set(), year: new Set(),
    status: new Set(),
  };
}
