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

const FORMAT_ORDER = ["epub", "pdf", "cbz", "zip"];
const formatRank = (type: string): number => {
  const i = FORMAT_ORDER.indexOf(type);
  return i === -1 ? FORMAT_ORDER.length : i;
};

// Copies of one edition are the same book, so the feed lists the edition once. Each format
// links to the most recently added copy that has it (ties: smallest id), matching the site.
function toPublication(copies: CatalogBook[], links: FeedLinks) {
  const editionId = copies[0].editionId ?? copies[0].id;
  const canonical = copies.find((b) => b.id === editionId) ?? copies[0];
  const newestFirst = [...copies].sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? "") || a.id.localeCompare(b.id));
  const chosen = new Map<string, CatalogBook>();
  for (const copy of newestFirst) {
    for (const f of copy.formats) if (!chosen.has(f.type)) chosen.set(f.type, copy);
  }
  const types = [...chosen.keys()].sort((a, b) => formatRank(a) - formatRank(b) || a.localeCompare(b));
  return {
    metadata: {
      "@type": "http://schema.org/Book",
      title: canonical.title,
      author: (canonical.authors ?? []).map((name) => ({ name })),
    },
    links: types.map((type) => ({
      rel: "http://opds-spec.org/acquisition",
      href: links.acquisitionOf(chosen.get(type)!.id, type),
      type: mediaTypeOf(type),
    })),
  };
}

// A single flat acquisition feed — one publication per edition, in catalogue order of each
// edition's first copy. No pagination or per-category feeds.
export function buildOpdsFeed(catalog: Catalog, title: string, links: FeedLinks) {
  const editions = new Map<string, CatalogBook[]>();
  for (const book of catalog.books) {
    const key = book.editionId ?? book.id;
    const copies = editions.get(key);
    if (copies) copies.push(book);
    else editions.set(key, [book]);
  }
  return {
    metadata: { title },
    links: [{ rel: "self", href: links.self, type: OPDS_MEDIA_TYPE }],
    publications: [...editions.values()].map((copies) => toPublication(copies, links)),
  };
}
