export interface CatalogFormat { type: string; size: number; s3Key: string }
// authors is optional here even though the real catalog.json always includes it (see
// indexer/src/ebook_indexer/catalog.py): callers that only need id/title/formats — the
// existing download flow — should not have to fabricate it.
export interface CatalogBook { id: string; title: string; authors?: string[]; formats: CatalogFormat[] }
export interface Catalog { books: CatalogBook[] }
export interface DownloadRequest { bookId: string; format: string }

export function parseRequest(body: string | undefined): DownloadRequest | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { bookId?: unknown; format?: unknown };
    if (typeof parsed.bookId === "string" && parsed.bookId && typeof parsed.format === "string" && parsed.format) {
      return { bookId: parsed.bookId, format: parsed.format.toLowerCase() };
    }
  } catch {
    // malformed JSON → undefined
  }
  return undefined;
}

export function findFormat(catalog: Catalog, req: DownloadRequest): { book: CatalogBook; format: CatalogFormat } | undefined {
  const book = catalog.books.find((b) => b.id === req.bookId);
  const format = book?.formats.find((f) => f.type === req.format);
  return book && format ? { book, format } : undefined;
}

export function downloadFilename(title: string, type: string, bookId: string): string {
  const safe = title
    .replace(/[^A-Za-z0-9 ._-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${safe || `book-${bookId}`}.${type}`;
}
