export interface CatalogFormat { type: string; size: number; s3Key: string }
export interface CatalogBook { id: string; title: string; formats: CatalogFormat[] }
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

export function downloadFilename(title: string, type: string): string {
  const safe = title.replace(/[^A-Za-z0-9 ._-]+/g, "").trim().slice(0, 100);
  return `${safe || "book"}.${type}`;
}
