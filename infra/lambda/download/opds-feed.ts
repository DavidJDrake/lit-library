import type { Catalog, CatalogBook } from "./download";

// OPDS 2.0, JSON flavour only (no Atom/XML) — see docs brief backlog #16.
export const OPDS_MEDIA_TYPE = "application/opds+json";

const FORMAT_MEDIA_TYPES: Record<string, string> = { epub: "application/epub+zip", pdf: "application/pdf" };
const mediaTypeOf = (format: string): string => FORMAT_MEDIA_TYPES[format] ?? "application/octet-stream";

export interface FeedLinks {
  /** The feed's own URL, including the caller's token — used as the "self" link. */
  self: string;
  /** Builds the acquisition URL for one book/format pair, including the caller's token. */
  acquisitionOf(bookId: string, format: string): string;
}

function toPublication(book: CatalogBook, links: FeedLinks) {
  return {
    metadata: {
      "@type": "http://schema.org/Book",
      title: book.title,
      author: (book.authors ?? []).map((name) => ({ name })),
    },
    links: book.formats.map((f) => ({
      rel: "http://opds-spec.org/acquisition",
      href: links.acquisitionOf(book.id, f.type),
      type: mediaTypeOf(f.type),
    })),
  };
}

// A single flat acquisition feed listing every book in the catalogue — no pagination or
// per-category feeds, matching the brief's "single acquisition feed" requirement.
export function buildOpdsFeed(catalog: Catalog, title: string, links: FeedLinks) {
  return {
    metadata: { title },
    links: [{ rel: "self", href: links.self, type: OPDS_MEDIA_TYPE }],
    publications: catalog.books.map((book) => toPublication(book, links)),
  };
}
