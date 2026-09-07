import { apiCall } from "./apiCall";
import type { Book, ReadingStatus } from "./types";

export interface Suggestion { id: string; name: string; bookId?: string; suggestedBy: string; createdAt: string }
export interface Overlay {
  categories: Array<{ name: string; source: string }>;
  bookCategories: Record<string, string>;
  suggestions: Suggestion[];
  readingStatuses: Record<string, ReadingStatus>;
  /** Book ids the reader has downloaded — derived, never written through this overlay. */
  downloaded: string[];
}

export async function fetchOverlay(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<Overlay> {
  const res = await apiCall(apiUrl, idToken, "/library", { method: "GET" }, 200, fetchFn);
  if (!(res.headers?.get?.("content-type") ?? "").includes("application/json")) throw new Error("Library request returned non-JSON");
  const body = (await res.json()) as Partial<Overlay>;
  if (
    !Array.isArray(body?.categories) || typeof body.bookCategories !== "object" || body.bookCategories === null
    || !Array.isArray(body.suggestions) || typeof body.readingStatuses !== "object" || body.readingStatuses === null
    || !Array.isArray(body.downloaded)
  ) {
    throw new Error("Library overlay is malformed");
  }
  return body as Overlay;
}

// Merges every per-reader field the overlay carries onto the catalog's books, the one
// place that happens — filtering, the card and the dialog all read the merged result
// rather than combining catalog and overlay data themselves. Preserves reference identity
// for a book nothing changed about, matching the existing category behaviour.
export function applyOverlay(books: Book[], overlay: Overlay): Book[] {
  const downloadedIds = new Set(overlay.downloaded);
  return books.map((b) => {
    const category = overlay.bookCategories[b.id];
    const categoryChanged = Boolean(category) && category !== b.category;
    const readingStatus = overlay.readingStatuses[b.id] ?? null;
    const statusChanged = readingStatus !== (b.readingStatus ?? null);
    const downloaded = downloadedIds.has(b.id);
    const downloadedChanged = downloaded !== Boolean(b.downloaded);
    if (!categoryChanged && !statusChanged && !downloadedChanged) return b;
    return { ...b, ...(categoryChanged ? { category } : {}), readingStatus, downloaded };
  });
}

export async function setBookCategory(apiUrl: string, idToken: string, bookId: string, category: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, `/books/${encodeURIComponent(bookId)}/category`,
    { method: "PUT", body: JSON.stringify({ category }) }, 204, fetchFn);
}

// status is null to clear (deletes the stored row server-side rather than storing an
// empty value); otherwise one of the three settable ReadingStatus values.
export async function setBookReadingStatus(
  apiUrl: string, idToken: string, bookId: string, status: ReadingStatus | null, fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiCall(apiUrl, idToken, `/books/${encodeURIComponent(bookId)}/status`,
    { method: "PUT", body: JSON.stringify({ status }) }, 204, fetchFn);
}

export async function suggestCategory(apiUrl: string, idToken: string, name: string, bookId: string | undefined, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/suggestions",
    { method: "POST", body: JSON.stringify(bookId ? { name, bookId } : { name }) }, 201, fetchFn);
}

export async function createCategory(apiUrl: string, idToken: string, name: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/categories", { method: "POST", body: JSON.stringify({ name }) }, 201, fetchFn);
}

export async function resolveSuggestion(apiUrl: string, idToken: string, id: string, action: "accept" | "reject", fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, `/suggestions/${encodeURIComponent(id)}/${action}`, { method: "POST" }, 204, fetchFn);
}

export function suggesterLabel(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
