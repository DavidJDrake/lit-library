import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import type { NotifyFn } from "../notifications/fanout";
import { logEvent } from "../shared/log";
import { hashOpdsToken } from "../shared/opds-token";
import type { DownloadsStore } from "./downloads";
import { ADMIN_ROUTES, isAdmin, matchRoute, normalizeName, parseJsonBody, type Route } from "./lib";
import { callerEmail } from "../shared/caller";

export interface Category { name: string; nameLower: string; createdBy: string; createdAt: string; source: "seed" | "admin" | "suggestion" }
export interface BookCategory { bookId: string; category: string; changedBy: string; changedAt: string }
export interface Suggestion {
  id: string; name: string; nameLower: string; bookId?: string; suggestedBy: string; createdAt: string;
  status: "pending" | "accepted" | "rejected"; resolvedBy?: string; resolvedAt?: string;
}

// The three states a reader sets deliberately. "downloaded" is a fourth, derived state
// (see DownloadsStore) that is never accepted here as a settable value.
export type ReadingStatus = "want to read" | "reading" | "finished";
export const READING_STATUSES: readonly ReadingStatus[] = ["want to read", "reading", "finished"];
export interface ReadingStatusRow { bookId: string; status: ReadingStatus; updatedAt: string }

// Existence and creation time only — never the token or its hash. That is all the
// interface needs to say "a feed link exists, made on <date>" without being able to
// reveal or reconstruct it.
export interface OpdsTokenStatus { createdAt: string }

export interface Store {
  listCategories(): Promise<Category[]>;
  listBookCategories(): Promise<BookCategory[]>;
  listPendingSuggestions(): Promise<Suggestion[]>;
  getSuggestion(id: string): Promise<Suggestion | undefined>;
  /** false when a category with this name already exists (conditional put). */
  putCategory(c: Category): Promise<boolean>;
  putBookCategory(b: BookCategory): Promise<void>;
  /** One transaction: create the suggestion and reserve its lowercased name. false when the name is already reserved. */
  putSuggestion(s: Suggestion): Promise<boolean>;
  /** One transaction: create category, move book (if any), mark accepted, release the name reservation. false when a condition fails. */
  acceptSuggestion(id: string, category: Category, book: BookCategory | undefined, resolvedBy: string, resolvedAt: string): Promise<boolean>;
  /** One transaction: mark rejected and release the name reservation. false when the suggestion is no longer pending. */
  rejectSuggestion(id: string, nameLower: string, resolvedBy: string, resolvedAt: string): Promise<boolean>;
  /** The caller's own reading-status rows only. */
  listReadingStatuses(email: string): Promise<ReadingStatusRow[]>;
  putReadingStatus(email: string, bookId: string, status: ReadingStatus, updatedAt: string): Promise<void>;
  /** Clears a status by deleting its row rather than storing an empty value. */
  deleteReadingStatus(email: string, bookId: string): Promise<void>;
  /** The caller's own OPDS token descriptor; undefined when none has been generated. */
  getOpdsTokenStatus(email: string): Promise<OpdsTokenStatus | undefined>;
  /**
   * One transaction: records the new hash on the caller's descriptor, creates the new
   * lookup row, and deletes the previous lookup row (if any) — so the old token stops
   * resolving the instant the new one starts working, never both at once.
   */
  setOpdsTokenHash(email: string, tokenHash: string, createdAt: string): Promise<void>;
  /** One transaction: deletes the descriptor and its lookup row. A no-op when there is none. */
  clearOpdsToken(email: string): Promise<void>;
}

export interface Deps {
  store: Store; downloads: DownloadsStore; now: () => Date; newId: () => string; notify: NotifyFn;
  /** A fresh, cryptographically random OPDS token. Only its hash (via hashOpdsToken) is ever stored. */
  newOpdsToken: () => string;
}

const BOOK_ID_MAX = 64;
const BOOK_ID_RE = /^[A-Za-z0-9._-]+$/;

function isValidBookId(id: string): boolean {
  return id.length > 0 && id.length <= BOOK_ID_MAX && BOOK_ID_RE.test(id);
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
const noContent = (): APIGatewayProxyResultV2 => ({ statusCode: 204 });

async function nameTaken(store: Store, nameLower: string): Promise<boolean> {
  const [categories, pending] = await Promise.all([store.listCategories(), store.listPendingSuggestions()]);
  return categories.some((c) => c.nameLower === nameLower) || pending.some((s) => s.nameLower === nameLower);
}

// Best-effort: the primary write has already succeeded; a fan-out failure is logged, never surfaced.
async function safeNotify(deps: Deps, ...args: Parameters<NotifyFn>): Promise<void> {
  try {
    await deps.notify(...args);
  } catch (e) {
    console.error("notify failed:", args[0], e);
  }
}

async function dispatch(route: Route, event: APIGatewayProxyEventV2WithJWTAuthorizer, email: string, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const { store } = deps;
  const at = deps.now().toISOString();
  switch (route.kind) {
    case "overlay": {
      const [categories, books, pending, statuses, downloaded] = await Promise.all([
        store.listCategories(), store.listBookCategories(), store.listPendingSuggestions(),
        store.listReadingStatuses(email), deps.downloads.listDownloadedBookIds(email),
      ]);
      return json(200, {
        categories: [...categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, source: c.source })),
        bookCategories: Object.fromEntries(books.map((b) => [b.bookId, b.category])),
        suggestions: [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((s) => ({
          id: s.id, name: s.name, ...(s.bookId ? { bookId: s.bookId } : {}), suggestedBy: s.suggestedBy, createdAt: s.createdAt,
        })),
        readingStatuses: Object.fromEntries(statuses.map((s) => [s.bookId, s.status])),
        downloaded,
      });
    }
    case "setBookCategory": {
      if (!isValidBookId(route.bookId)) return json(400, { error: "Invalid book id" });
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.category);
      if (!n) return json(400, { error: "Body must be JSON {category}" });
      const categories = await store.listCategories();
      const match = categories.find((c) => c.nameLower === n.nameLower);
      if (!match) return json(400, { error: "Unknown category" });
      await store.putBookCategory({ bookId: route.bookId, category: match.name, changedBy: email, changedAt: at });
      return noContent();
    }
    case "setReadingStatus": {
      if (!isValidBookId(route.bookId)) return json(400, { error: "Invalid book id" });
      const body = parseJsonBody(event.body);
      if (!body || !("status" in body)) return json(400, { error: "Body must be JSON {status}" });
      const { status } = body;
      // null clears: the row is deleted rather than storing an empty value.
      if (status === null) {
        await store.deleteReadingStatus(email, route.bookId);
        return noContent();
      }
      if (typeof status !== "string" || !READING_STATUSES.includes(status as ReadingStatus)) {
        return json(400, { error: `status must be one of ${READING_STATUSES.join(", ")}, or null to clear` });
      }
      await store.putReadingStatus(email, route.bookId, status as ReadingStatus, at);
      return noContent();
    }
    case "suggest": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.name);
      if (!n) return json(400, { error: "Body must be JSON {name, bookId?}" });
      const bookId = body?.bookId;
      if (bookId !== undefined && (typeof bookId !== "string" || !isValidBookId(bookId))) {
        return json(400, { error: "bookId must be a non-empty string" });
      }
      if (await nameTaken(store, n.nameLower)) return json(409, { error: "That category already exists or has been suggested" });
      const id = deps.newId();
      const reserved = await store.putSuggestion({
        id, name: n.name, nameLower: n.nameLower, ...(bookId ? { bookId } : {}), suggestedBy: email, createdAt: at, status: "pending",
      });
      if (!reserved) return json(409, { error: "That category already exists or has been suggested" });
      logEvent("suggestion.created", { suggestionId: id, by: email, name: n.name }, deps.now);
      await safeNotify(deps, "suggestion_pending", { suggestionId: id, name: n.name, ...(bookId ? { bookId } : {}), suggestedBy: email }, "admins", { excludeEmail: email });
      return json(201, { id });
    }
    case "createCategory": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.name);
      if (!n) return json(400, { error: "Body must be JSON {name}" });
      if (await nameTaken(store, n.nameLower)) return json(409, { error: "That category already exists or has been suggested" });
      const created = await store.putCategory({ name: n.name, nameLower: n.nameLower, createdBy: email, createdAt: at, source: "admin" });
      if (!created) return json(409, { error: "That category already exists" });
      logEvent("category.created", { name: n.name, source: "admin", by: email }, deps.now);
      await safeNotify(deps, "category_created", { name: n.name, createdBy: email, source: "admin" }, "everyone", { excludeEmail: email });
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
      logEvent("suggestion.accepted", { suggestionId: s.id, by: email }, deps.now);
      logEvent("category.created", { name: s.name, source: "suggestion", by: email }, deps.now);
      await safeNotify(deps, "suggestion_resolved", { suggestionId: s.id, name: s.name, status: "accepted", resolvedBy: email, ...(s.bookId ? { bookId: s.bookId } : {}) }, [s.suggestedBy]);
      await safeNotify(deps, "category_created", { name: s.name, createdBy: email, source: "suggestion" }, "everyone", { excludeEmail: email });
      return noContent();
    }
    case "reject": {
      const s = await store.getSuggestion(route.id);
      if (!s) return json(404, { error: "Unknown suggestion" });
      const ok = await store.rejectSuggestion(s.id, s.nameLower, email, at);
      if (!ok) return json(409, { error: "Suggestion already resolved" });
      logEvent("suggestion.rejected", { suggestionId: s.id, by: email }, deps.now);
      await safeNotify(deps, "suggestion_resolved", { suggestionId: s.id, name: s.name, status: "rejected", resolvedBy: email, ...(s.bookId ? { bookId: s.bookId } : {}) }, [s.suggestedBy]);
      return noContent();
    }
    case "opdsTokenStatus": {
      const status = await store.getOpdsTokenStatus(email);
      return json(200, { exists: !!status, createdAt: status?.createdAt ?? null });
    }
    case "opdsTokenGenerate": {
      // The plaintext token exists only for the lifetime of this request: it is handed
      // back once in the response body and never logged, stored, or held in memory
      // longer than it takes to hash it.
      const token = deps.newOpdsToken();
      await store.setOpdsTokenHash(email, hashOpdsToken(token), at);
      logEvent("opds.token_generated", { email }, deps.now);
      return json(201, { token, createdAt: at });
    }
    case "opdsTokenRevoke": {
      await store.clearOpdsToken(email);
      logEvent("opds.token_revoked", { email }, deps.now);
      return noContent();
    }
  }
}

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const route = matchRoute(event.requestContext.http.method, event.rawPath);
  if (!route) return json(404, { error: "Not found" });
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = callerEmail(claims);
  if (!email) return json(401, { error: "Token has no email claim (send the ID token)" });
  if (ADMIN_ROUTES.has(route.kind) && !isAdmin(claims)) return json(403, { error: "Admin only" });
  try {
    return await dispatch(route, event, email, deps);
  } catch (e) {
    console.error("library handler failed:", e);
    return json(500, { error: "Internal error" });
  }
}

// ---- production wiring (never exercised by tests) ----
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { CognitoDirectory, DynamoNotificationWriter, notify } from "../notifications/fanout";
import { generateOpdsToken } from "../shared/opds-token";
import { DynamoDownloadsStore } from "./downloads";
import { DynamoStore } from "./store";

let productionDeps: Deps | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  if (!productionDeps) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const notifyDeps = {
      directory: new CognitoDirectory(new CognitoIdentityProviderClient({ maxAttempts: 2 }), process.env.USER_POOL_ID ?? ""),
      writer: new DynamoNotificationWriter(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      now: () => new Date(), newId: () => randomUUID(),
    };
    productionDeps = {
      store: new DynamoStore(ddb, process.env.LIBRARY_TABLE ?? ""),
      downloads: new DynamoDownloadsStore(ddb, process.env.DOWNLOADS_TABLE ?? ""),
      now: () => new Date(),
      newId: () => randomUUID(),
      newOpdsToken: () => generateOpdsToken(),
      notify: (type, payload, recipients, opts) => notify(type, payload, recipients, notifyDeps, opts),
    };
  }
  return handle(event, productionDeps);
};
