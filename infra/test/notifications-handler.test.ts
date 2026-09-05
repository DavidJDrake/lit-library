import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { handle, MAX_LIMIT, type Deps, type NotificationRecord, type NotificationStore } from "../lambda/notifications/index";

const NOW = "2026-09-05T10:00:00.000Z";
const rec = (id: string, type: NotificationRecord["type"], payload: Record<string, unknown>, read = false): NotificationRecord =>
  ({ id: `2026-09-05T09:00:00.000Z#${id}`, type, payload, read, createdAt: "2026-09-05T09:00:00.000Z" });

function store(over: Partial<NotificationStore> = {}): NotificationStore {
  return {
    list: vi.fn().mockResolvedValue({ items: [
      rec("n1", "suggestion_pending", { suggestionId: "s1", name: "Cookbooks", suggestedBy: "b@example.com" }),
      rec("n2", "books_added", { count: 3, bookIds: ["a", "b", "c"] }, true),
    ] }),
    countUnread: vi.fn().mockResolvedValue(1),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}
function deps(s: NotificationStore = store(), over: Partial<Deps> = {}): Deps {
  return {
    store: s,
    suggestions: { getSuggestion: vi.fn().mockResolvedValue({ status: "accepted", resolvedBy: "a@example.com" }) },
    notify: vi.fn().mockResolvedValue(4),
    now: () => new Date(NOW),
    ...over,
  };
}
function http(method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; claims?: Record<string, unknown> } = {}) {
  return {
    rawPath: path,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    queryStringParameters: opts.query,
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: opts.claims ?? { email: "a@example.com" }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
function parse(res: Awaited<ReturnType<typeof handle>>) {
  const r = res as { statusCode: number; body?: string };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined };
}

describe("GET /api/notifications", () => {
  it("lists items with unread count, joining suggestion status into pending rows", async () => {
    const d = deps();
    const { status, json } = parse(await handle(http("GET", "/api/notifications"), d));
    expect(status).toBe(200);
    expect(json.unread).toBe(1);
    expect(json.items[0].payload).toEqual({ suggestionId: "s1", name: "Cookbooks", suggestedBy: "b@example.com", status: "accepted", resolvedBy: "a@example.com" });
    expect(json.items[1].payload).toEqual({ count: 3, bookIds: ["a", "b", "c"] });
    expect(json).not.toHaveProperty("next");
    expect(d.store.list).toHaveBeenCalledWith("a@example.com", 50, undefined);
  });
  it("marks a pending row whose suggestion vanished as status 'unknown'", async () => {
    const d = deps(store(), { suggestions: { getSuggestion: vi.fn().mockResolvedValue(undefined) } });
    const { json } = parse(await handle(http("GET", "/api/notifications"), d));
    expect(json.items[0].payload.status).toBe("unknown");
  });
  it("clamps limit, passes the cursor, and echoes next", async () => {
    const s = store({ list: vi.fn().mockResolvedValue({ items: [], next: "2026-01-01T00:00:00.000Z#x" }) });
    const { json } = parse(await handle(http("GET", "/api/notifications", { query: { limit: "500", before: "2026-02-02T00:00:00.000Z#y" } }), deps(s)));
    expect(s.list).toHaveBeenCalledWith("a@example.com", MAX_LIMIT, "2026-02-02T00:00:00.000Z#y");
    expect(json.next).toBe("2026-01-01T00:00:00.000Z#x");
    await handle(http("GET", "/api/notifications", { query: { limit: "0" } }), deps(s));
    expect(s.list).toHaveBeenLastCalledWith("a@example.com", 1, undefined);
  });
  it("400s a malformed cursor and 401s a token without email", async () => {
    expect(parse(await handle(http("GET", "/api/notifications", { query: { before: "nope" } }), deps())).status).toBe(400);
    expect(parse(await handle(http("GET", "/api/notifications", { claims: {} }), deps())).status).toBe(401);
  });
});

describe("POST /api/notifications/read", () => {
  it("marks the given ids read for the caller", async () => {
    const d = deps();
    expect(parse(await handle(http("POST", "/api/notifications/read", { body: { ids: ["2026-09-05T09:00:00.000Z#n1"] } }), d)).status).toBe(204);
    expect(d.store.markRead).toHaveBeenCalledWith("a@example.com", ["2026-09-05T09:00:00.000Z#n1"]);
  });
  it("marks all read", async () => {
    const d = deps();
    expect(parse(await handle(http("POST", "/api/notifications/read", { body: { all: true } }), d)).status).toBe(204);
    expect(d.store.markAllRead).toHaveBeenCalledWith("a@example.com");
  });
  it("400s bad bodies: missing, too many ids, non-string ids, empty ids", async () => {
    for (const body of [undefined, { ids: Array.from({ length: 101 }, (_, i) => `2026-09-05T09:00:00.000Z#${i}`) }, { ids: [1] }, { ids: [] }, { all: false }]) {
      expect(parse(await handle(http("POST", "/api/notifications/read", { body }), deps())).status).toBe(400);
    }
  });
  it("404s unknown routes", async () => {
    expect(parse(await handle(http("DELETE", "/api/notifications"), deps())).status).toBe(404);
  });
});

describe("direct invoke from the indexer", () => {
  it("fans out books_added to everyone", async () => {
    const d = deps();
    const out = await handle({ source: "indexer", type: "books_added", count: 3, bookIds: ["a", "b", "c"] }, d);
    expect(out).toEqual({ ok: true, recipients: 4 });
    expect(d.notify).toHaveBeenCalledWith("books_added", { count: 3, bookIds: ["a", "b", "c"] }, "everyone");
  });
  it("rejects malformed events without writing", async () => {
    const d = deps();
    for (const ev of [
      { source: "cron", type: "books_added", count: 1, bookIds: ["a"] },
      { source: "indexer", type: "category_created", count: 1, bookIds: ["a"] },
      { source: "indexer", type: "books_added", count: 0, bookIds: [] },
      { source: "indexer", type: "books_added", count: 1.5, bookIds: ["a"] },
      { source: "indexer", type: "books_added", count: 1, bookIds: Array.from({ length: 21 }, (_, i) => `b${i}`) },
      { source: "indexer", type: "books_added", count: 1, bookIds: [7] },
    ]) {
      const out = await handle(ev, d);
      expect(out).toMatchObject({ ok: false });
    }
    expect(d.notify).not.toHaveBeenCalled();
  });
  it("reports a fan-out failure", async () => {
    const d = deps(store(), { notify: vi.fn().mockRejectedValue(new Error("cognito down")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handle({ source: "indexer", type: "books_added", count: 1, bookIds: ["a"] }, d)).toEqual({ ok: false, error: "cognito down" });
    spy.mockRestore();
  });
});

describe("failures", () => {
  it("500s with JSON when the store throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, json } = parse(await handle(http("GET", "/api/notifications"), deps(store({ list: vi.fn().mockRejectedValue(new Error("boom")) }))));
    expect(status).toBe(500);
    expect(json).toEqual({ error: "Internal error" });
    spy.mockRestore();
  });
});
