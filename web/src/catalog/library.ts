import type { Book } from "./types";

export interface Suggestion { id: string; name: string; bookId?: string; suggestedBy: string; createdAt: string }
export interface Overlay {
  categories: Array<{ name: string; source: string }>;
  bookCategories: Record<string, string>;
  suggestions: Suggestion[];
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // non-JSON error body — keep the fallback
  }
  return fallback;
}

// Same-origin call to the library API. The SPA fallback answers unknown paths with
// 200 HTML, so callers state the exact status they expect.
async function apiCall(
  apiUrl: string, idToken: string, path: string, init: RequestInit, expectStatus: number, fetchFn: typeof fetch,
): Promise<Response> {
  const res = await fetchFn(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status !== expectStatus) throw new Error(await errorMessage(res, `Request failed: expected ${expectStatus}, got ${res.status}`));
  return res;
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
