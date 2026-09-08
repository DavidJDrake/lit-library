import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import type { NotificationType, NotifyFn } from "./fanout";
import { callerEmail } from "../shared/caller";

export interface NotificationRecord { id: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationStore {
  list(email: string, limit: number, before?: string): Promise<{ items: NotificationRecord[]; next?: string }>;
  countUnread(email: string): Promise<number>;
  markRead(email: string, ids: string[]): Promise<void>;
  markAllRead(email: string): Promise<void>;
}
export interface SuggestionLookup { getSuggestion(id: string): Promise<{ status: string; resolvedBy?: string } | undefined> }
export interface Deps { store: NotificationStore; suggestions: SuggestionLookup; notify: NotifyFn; now: () => Date }
export interface IndexerEvent { source: "indexer"; type: "books_added"; count: number; bookIds: string[] }
export type InvokeResult = { ok: true; recipients: number } | { ok: false; error: string };

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_READ_IDS = 100;
export const MAX_BOOK_IDS = 20;
// "<ISO timestamp>#<id>" — what the store hands out as `id`/`next` (the id part is a uuid in production).
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[A-Za-z0-9-]{1,64}$/;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function parseIndexerEvent(ev: Record<string, unknown>): IndexerEvent | string {
  if (ev.source !== "indexer") return "source must be 'indexer'";
  if (ev.type !== "books_added") return "type must be 'books_added'";
  if (!Number.isInteger(ev.count) || (ev.count as number) < 1) return "count must be an integer >= 1";
  const ids = ev.bookIds;
  if (!Array.isArray(ids) || ids.length > MAX_BOOK_IDS || !ids.every((x) => typeof x === "string" && x.length > 0)) {
    return `bookIds must be up to ${MAX_BOOK_IDS} non-empty strings`;
  }
  return { source: "indexer", type: "books_added", count: ev.count as number, bookIds: ids as string[] };
}

async function handleInvoke(ev: Record<string, unknown>, deps: Deps): Promise<InvokeResult> {
  const parsed = parseIndexerEvent(ev);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  try {
    const recipients = await deps.notify("books_added", { count: parsed.count, bookIds: parsed.bookIds }, "everyone");
    return { ok: true, recipients };
  } catch (e) {
    console.error("books_added fan-out failed:", e);
    return { ok: false, error: (e as Error).message };
  }
}

async function withSuggestionStatus(items: NotificationRecord[], lookup: SuggestionLookup): Promise<NotificationRecord[]> {
  const ids = [...new Set(items.filter((n) => n.type === "suggestion_pending").map((n) => String(n.payload.suggestionId)))];
  const statuses = new Map(await Promise.all(ids.map(async (id) => [id, await lookup.getSuggestion(id)] as const)));
  return items.map((n) => {
    if (n.type !== "suggestion_pending") return n;
    const s = statuses.get(String(n.payload.suggestionId));
    return { ...n, payload: { ...n.payload, status: s?.status ?? "unknown", ...(s?.resolvedBy ? { resolvedBy: s.resolvedBy } : {}) } };
  });
}

async function handleHttp(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = callerEmail(claims);
  if (!email) return json(401, { error: "Token has no email claim (send the ID token)" });

  if (method === "GET" && path === "/api/notifications") {
    const q = event.queryStringParameters ?? {};
    const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit))) : DEFAULT_LIMIT;
    const before = q.before;
    if (before !== undefined && !ID_RE.test(before)) return json(400, { error: "Malformed cursor" });
    const [page, unread] = await Promise.all([deps.store.list(email, limit, before), deps.store.countUnread(email)]);
    const items = await withSuggestionStatus(page.items, deps.suggestions);
    return json(200, { items, unread, ...(page.next ? { next: page.next } : {}) });
  }

  if (method === "POST" && path === "/api/notifications/read") {
    let body: unknown;
    try { body = event.body ? JSON.parse(event.body) : undefined; } catch { body = undefined; }
    const b = (typeof body === "object" && body !== null ? body : {}) as { ids?: unknown; all?: unknown };
    if (b.all === true) { await deps.store.markAllRead(email); return { statusCode: 204 }; }
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READ_IDS || !ids.every((x) => typeof x === "string" && ID_RE.test(x))) {
      return json(400, { error: `Body must be {ids: [1..${MAX_READ_IDS} notification ids]} or {all: true}` });
    }
    await deps.store.markRead(email, ids as string[]);
    return { statusCode: 204 };
  }

  return json(404, { error: "Not found" });
}

export async function handle(
  event: APIGatewayProxyEventV2WithJWTAuthorizer | Record<string, unknown>, deps: Deps,
): Promise<APIGatewayProxyResultV2 | InvokeResult> {
  // A direct `lambda invoke` (from scripts/notify-books-added.py) has no API Gateway context.
  if (!("requestContext" in event)) return handleInvoke(event as Record<string, unknown>, deps);
  try {
    return await handleHttp(event as APIGatewayProxyEventV2WithJWTAuthorizer, deps);
  } catch (e) {
    console.error("notifications handler failed:", e);
    return json(500, { error: "Internal error" });
  }
}

// ---- production wiring (never exercised by tests) ----
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { DynamoStore } from "../library/store";
import { CognitoDirectory, DynamoNotificationWriter, notify } from "./fanout";
import { DynamoNotificationStore } from "./store";

let productionDeps: Deps | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer | Record<string, unknown>) => {
  if (!productionDeps) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const notifyDeps = {
      directory: new CognitoDirectory(new CognitoIdentityProviderClient({ maxAttempts: 2 }), process.env.USER_POOL_ID ?? ""),
      writer: new DynamoNotificationWriter(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      now: () => new Date(), newId: () => randomUUID(),
    };
    productionDeps = {
      store: new DynamoNotificationStore(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      suggestions: new DynamoStore(ddb, process.env.LIBRARY_TABLE ?? ""),
      notify: (type, payload, recipients, opts) => notify(type, payload, recipients, notifyDeps, opts),
      now: () => new Date(),
    };
  }
  return handle(event, productionDeps);
};
