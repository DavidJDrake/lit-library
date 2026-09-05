import { apiCall } from "./apiCall";
import type { Book } from "./types";

export interface Suggestion { id: string; name: string; bookId?: string; suggestedBy: string; createdAt: string }
export interface Overlay {
  categories: Array<{ name: string; source: string }>;
  bookCategories: Record<string, string>;
  suggestions: Suggestion[];
}

export async function fetchOverlay(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<Overlay> {
  const res = await apiCall(apiUrl, idToken, "/library", { method: "GET" }, 200, fetchFn);
  if (!(res.headers?.get?.("content-type") ?? "").includes("application/json")) throw new Error("Library request returned non-JSON");
  const body = (await res.json()) as Partial<Overlay>;
  if (!Array.isArray(body?.categories) || typeof body.bookCategories !== "object" || body.bookCategories === null || !Array.isArray(body.suggestions)) {
    throw new Error("Library overlay is malformed");
  }
  return body as Overlay;
}

export function applyOverlay(books: Book[], overlay: Overlay): Book[] {
  return books.map((b) => {
    const category = overlay.bookCategories[b.id];
    return category && category !== b.category ? { ...b, category } : b;
  });
}

export async function setBookCategory(apiUrl: string, idToken: string, bookId: string, category: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, `/books/${encodeURIComponent(bookId)}/category`,
    { method: "PUT", body: JSON.stringify({ category }) }, 204, fetchFn);
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
