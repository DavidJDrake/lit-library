export interface BookFormat { type: string; size: number; s3Key: string }

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
  // merged in by applyOverlay. readingStatus is null when the reader has no status set;
  // downloaded is independent of it — a book can be downloaded and also want-to-read,
  // reading, finished, or none of those.
  readingStatus?: ReadingStatus | null;
  downloaded?: boolean;
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
