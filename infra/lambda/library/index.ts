import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { ADMIN_ROUTES, isAdmin, matchRoute, normalizeName, parseJsonBody, type Route } from "./lib";

export interface Category { name: string; nameLower: string; createdBy: string; createdAt: string; source: "seed" | "admin" | "suggestion" }
export interface BookCategory { bookId: string; category: string; changedBy: string; changedAt: string }
export interface Suggestion {
  id: string; name: string; nameLower: string; bookId?: string; suggestedBy: string; createdAt: string;
  status: "pending" | "accepted" | "rejected"; resolvedBy?: string; resolvedAt?: string;
}

export interface Store {
  listCategories(): Promise<Category[]>;
  listBookCategories(): Promise<BookCategory[]>;
  listPendingSuggestions(): Promise<Suggestion[]>;
  getSuggestion(id: string): Promise<Suggestion | undefined>;
  /** false when a category with this name already exists (conditional put). */
  putCategory(c: Category): Promise<boolean>;
  putBookCategory(b: BookCategory): Promise<void>;
  putSuggestion(s: Suggestion): Promise<void>;
  /** One transaction: create category, move book (if any), mark accepted. false when a condition fails. */
  acceptSuggestion(id: string, category: Category, book: BookCategory | undefined, resolvedBy: string, resolvedAt: string): Promise<boolean>;
  /** false when the suggestion is no longer pending. */
  rejectSuggestion(id: string, resolvedBy: string, resolvedAt: string): Promise<boolean>;
}

export interface Deps { store: Store; now: () => Date; newId: () => string }

const BOOK_ID_MAX = 64;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
const noContent = (): APIGatewayProxyResultV2 => ({ statusCode: 204 });

async function nameTaken(store: Store, nameLower: string): Promise<boolean> {
  const [categories, pending] = await Promise.all([store.listCategories(), store.listPendingSuggestions()]);
  return categories.some((c) => c.nameLower === nameLower) || pending.some((s) => s.nameLower === nameLower);
}

async function dispatch(route: Route, event: APIGatewayProxyEventV2WithJWTAuthorizer, email: string, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const { store } = deps;
  const at = deps.now().toISOString();
  switch (route.kind) {
    case "overlay": {
      const [categories, books, pending] = await Promise.all([
        store.listCategories(), store.listBookCategories(), store.listPendingSuggestions(),
      ]);
      return json(200, {
        categories: [...categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, source: c.source })),
        bookCategories: Object.fromEntries(books.map((b) => [b.bookId, b.category])),
        suggestions: [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((s) => ({
          id: s.id, name: s.name, ...(s.bookId ? { bookId: s.bookId } : {}), suggestedBy: s.suggestedBy, createdAt: s.createdAt,
        })),
      });
    }
    case "setBookCategory": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.category);
      if (!n) return json(400, { error: "Body must be JSON {category}" });
      const categories = await store.listCategories();
      const match = categories.find((c) => c.name === n.name);
      if (!match) return json(400, { error: "Unknown category" });
      await store.putBookCategory({ bookId: route.bookId, category: match.name, changedBy: email, changedAt: at });
      return noContent();
    }
    case "suggest": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.name);
      if (!n) return json(400, { error: "Body must be JSON {name, bookId?}" });
      const bookId = body?.bookId;
      if (bookId !== undefined && (typeof bookId !== "string" || bookId.length === 0 || bookId.length > BOOK_ID_MAX)) {
        return json(400, { error: "bookId must be a non-empty string" });
      }
      if (await nameTaken(store, n.nameLower)) return json(409, { error: "That category already exists or has been suggested" });
      const id = deps.newId();
      await store.putSuggestion({
        id, name: n.name, nameLower: n.nameLower, ...(bookId ? { bookId } : {}), suggestedBy: email, createdAt: at, status: "pending",
      });
      return json(201, { id });
    }
    case "createCategory": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.name);
      if (!n) return json(400, { error: "Body must be JSON {name}" });
      if (await nameTaken(store, n.nameLower)) return json(409, { error: "That category already exists or has been suggested" });
      const created = await store.putCategory({ name: n.name, nameLower: n.nameLower, createdBy: email, createdAt: at, source: "admin" });
      if (!created) return json(409, { error: "That category already exists" });
      return json(201, { name: n.name });
    }
    case "accept": {
      const s = await store.getSuggestion(route.id);
      if (!s) return json(404, { error: "Unknown suggestion" });
      if (s.status !== "pending") return json(409, { error: `Suggestion already ${s.status}` });
      const categories = await store.listCategories();
      if (categories.some((c) => c.nameLower === s.nameLower)) return json(409, { error: "That category already exists" });
      const category: Category = { name: s.name, nameLower: s.nameLower, createdBy: email, createdAt: at, source: "suggestion" };
      const book = s.bookId ? { bookId: s.bookId, category: s.name, changedBy: email, changedAt: at } : undefined;
      const ok = await store.acceptSuggestion(s.id, category, book, email, at);
      if (!ok) return json(409, { error: "Suggestion changed underneath you; reload and try again" });
      return noContent();
    }
    case "reject": {
      const s = await store.getSuggestion(route.id);
      if (!s) return json(404, { error: "Unknown suggestion" });
      const ok = await store.rejectSuggestion(s.id, email, at);
      if (!ok) return json(409, { error: "Suggestion already resolved" });
      return noContent();
    }
  }
}

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const route = matchRoute(event.requestContext.http.method, event.rawPath);
  if (!route) return json(404, { error: "Not found" });
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = String(claims.email ?? "");
  if (!email) return json(401, { error: "Token has no email claim (send the ID token)" });
  if (ADMIN_ROUTES.has(route.kind) && !isAdmin(claims)) return json(403, { error: "Admin only" });
  try {
    return await dispatch(route, event, email, deps);
  } catch (e) {
    console.error("library handler failed:", e);
    return json(500, { error: "Internal error" });
  }
}
