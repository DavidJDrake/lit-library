export interface BookFormat { type: string; size: number; s3Key: string }

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
}

export interface Catalog { generatedAt: string; books: Book[] }

export const FACET_KEYS = ["category", "format", "publisher", "bundle", "author", "year"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];
export type Filters = Record<FacetKey, Set<string>>;
export type SortKey = "title" | "author" | "year" | "added";

export function emptyFilters(): Filters {
  return { category: new Set(), format: new Set(), publisher: new Set(), bundle: new Set(), author: new Set(), year: new Set() };
}
