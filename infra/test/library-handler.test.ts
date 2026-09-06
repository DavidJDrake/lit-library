import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Category, Deps, Store, Suggestion } from "../lambda/library/index";
import { handle } from "../lambda/library/index";

const NOW = "2026-09-04T12:00:00.000Z";
const fiction: Category = { name: "Fiction", nameLower: "fiction", createdBy: "seed", createdAt: NOW, source: "seed" };
const pending: Suggestion = { id: "s1", name: "Cookbooks", nameLower: "cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW, status: "pending" };

function store(over: Partial<Store> = {}): Store {
  return {
    listCategories: vi.fn().mockResolvedValue([fiction]),
    listBookCategories: vi.fn().mockResolvedValue([{ bookId: "b9", category: "Fiction", changedBy: "u@x", changedAt: NOW }]),
    listPendingSuggestions: vi.fn().mockResolvedValue([pending]),
    getSuggestion: vi.fn().mockResolvedValue(pending),
    putCategory: vi.fn().mockResolvedValue(true),
    putBookCategory: vi.fn().mockResolvedValue(undefined),
    putSuggestion: vi.fn().mockResolvedValue(undefined),
    acceptSuggestion: vi.fn().mockResolvedValue(true),
    rejectSuggestion: vi.fn().mockResolvedValue(true),
    ...over,
  };
}
function deps(s: Store = store(), over: Partial<Deps> = {}): Deps {
  return { store: s, now: () => new Date(NOW), newId: () => "id-1", notify: vi.fn().mockResolvedValue(1), ...over };
}
function event(method: string, path: string, body?: unknown, claims: Record<string, unknown> = { email: "u@x" }) {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, path }, authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const admin = { email: "a@x", "cognito:groups": "[admins]" };
function parse(res: Awaited<ReturnType<typeof handle>>) {
  const r = res as { statusCode: number; body?: string };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined };
}

describe("GET /api/library", () => {
  it("returns sorted categories, the book map, and pending suggestions", async () => {
    const s = store({ listCategories: vi.fn().mockResolvedValue([fiction, { ...fiction, name: "Comics", nameLower: "comics" }]) });
    const { status, json } = parse(await handle(event("GET", "/api/library"), deps(s)));
    expect(status).toBe(200);
    expect(json).toEqual({
      categories: [{ name: "Comics", source: "seed" }, { name: "Fiction", source: "seed" }],
      bookCategories: { b9: "Fiction" },
      suggestions: [{ id: "s1", name: "Cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW }],
    });
  });
  it("404s unknown routes and 401s tokens without an email", async () => {
    expect(parse(await handle(event("GET", "/api/nope"), deps())).status).toBe(404);
    expect(parse(await handle(event("GET", "/api/library", undefined, {}), deps())).status).toBe(401);
  });
});

describe("PUT /api/books/{id}/category", () => {
  it("writes the BOOK item for an existing category", async () => {
    const s = store();
    const { status } = parse(await handle(event("PUT", "/api/books/b1/category", { category: "Fiction" }), deps(s)));
    expect(status).toBe(204);
    expect(s.putBookCategory).toHaveBeenCalledWith({ bookId: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW });
  });
  it("400s an unknown or malformed category", async () => {
    expect(parse(await handle(event("PUT", "/api/books/b1/category", { category: "Nope" }), deps())).status).toBe(400);
    expect(parse(await handle(event("PUT", "/api/books/b1/category", { category: "" }), deps())).status).toBe(400);
    expect(parse(await handle(event("PUT", "/api/books/b1/category"), deps())).status).toBe(400);
  });
  it("400s an invalid book id (too long or containing disallowed characters)", async () => {
    const long = "x".repeat(65);
    expect(parse(await handle(event("PUT", `/api/books/${long}/category`, { category: "Fiction" }), deps())).status).toBe(400);
    expect(parse(await handle(event("PUT", "/api/books/a b/category", { category: "Fiction" }), deps())).status).toBe(400);
  });
});

describe("POST /api/suggestions", () => {
  it("stores a pending suggestion with the optional book", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const s = store();
    const { status, json } = parse(await handle(event("POST", "/api/suggestions", { name: " Cookery ", bookId: "b1" }), deps(s)));
    expect(status).toBe(201);
    expect(json).toEqual({ id: "id-1" });
    expect(s.putSuggestion).toHaveBeenCalledWith({
      id: "id-1", name: "Cookery", nameLower: "cookery", bookId: "b1", suggestedBy: "u@x", createdAt: NOW, status: "pending",
    });
    expect(events()).toContainEqual(expect.objectContaining({ event: "suggestion.created", suggestionId: "id-1", by: "u@x" }));
    log.mockRestore();
  });
  it("omits bookId when absent and 400s a non-string bookId", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = store();
    parse(await handle(event("POST", "/api/suggestions", { name: "Cookery" }), deps(s)));
    expect((s.putSuggestion as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty("bookId");
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "Cookery", bookId: 5 }), deps())).status).toBe(400);
    log.mockRestore();
  });
  it("400s a bookId with characters outside the allowed set", async () => {
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "Cookery", bookId: "bad/id" }), deps())).status).toBe(400);
  });
  it("409s a name that matches a category or a pending suggestion, case-insensitively", async () => {
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "fiction" }), deps())).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "COOKBOOKS" }), deps())).status).toBe(409);
  });
});

describe("admin routes", () => {
  it("403 without the admins group", async () => {
    expect(parse(await handle(event("POST", "/api/categories", { name: "X" }), deps())).status).toBe(403);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined), deps())).status).toBe(403);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/reject", undefined), deps())).status).toBe(403);
  });
  it("creates a category directly", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = store();
    const { status, json } = parse(await handle(event("POST", "/api/categories", { name: "Cookery" }, admin), deps(s)));
    expect(status).toBe(201);
    expect(json).toEqual({ name: "Cookery" });
    expect(s.putCategory).toHaveBeenCalledWith({ name: "Cookery", nameLower: "cookery", createdBy: "a@x", createdAt: NOW, source: "admin" });
    log.mockRestore();
  });
  it("409s duplicates on create, including when the conditional put loses a race", async () => {
    expect(parse(await handle(event("POST", "/api/categories", { name: "Fiction" }, admin), deps())).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/categories", { name: "Cookbooks" }, admin), deps())).status).toBe(409); // pending suggestion
    const s = store({ putCategory: vi.fn().mockResolvedValue(false) });
    expect(parse(await handle(event("POST", "/api/categories", { name: "Fresh" }, admin), deps(s))).status).toBe(409);
  });
  it("accepts a suggestion in one transaction that creates the category and moves the book", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const s = store();
    const { status } = parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin), deps(s)));
    expect(status).toBe(204);
    expect(s.acceptSuggestion).toHaveBeenCalledWith(
      "s1",
      { name: "Cookbooks", nameLower: "cookbooks", createdBy: "a@x", createdAt: NOW, source: "suggestion" },
      { bookId: "b1", category: "Cookbooks", changedBy: "a@x", changedAt: NOW },
      "a@x", NOW,
    );
    expect(events()).toContainEqual(expect.objectContaining({ event: "suggestion.accepted", suggestionId: "s1", by: "a@x" }));
    expect(events()).toContainEqual(expect.objectContaining({ event: "category.created", name: "Cookbooks", source: "suggestion" }));
    log.mockRestore();
  });
  it("accept: passes no book when the suggestion has none; 404 unknown; 409 resolved, taken, or lost transaction", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const noBook = store({ getSuggestion: vi.fn().mockResolvedValue({ ...pending, bookId: undefined }) });
    await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin), deps(noBook));
    expect((noBook.acceptSuggestion as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBeUndefined();

    expect(parse(await handle(event("POST", "/api/suggestions/zz/accept", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue(undefined) })))).status).toBe(404);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue({ ...pending, status: "rejected" }) })))).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue({ ...pending, name: "Fiction", nameLower: "fiction" }) })))).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin),
      deps(store({ acceptSuggestion: vi.fn().mockResolvedValue(false) })))).status).toBe(409);
    log.mockRestore();
  });
  it("rejects a pending suggestion; 404 unknown; 409 already resolved", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const s = store();
    expect(parse(await handle(event("POST", "/api/suggestions/s1/reject", undefined, admin), deps(s))).status).toBe(204);
    expect(s.rejectSuggestion).toHaveBeenCalledWith("s1", "a@x", NOW);
    expect(events()).toContainEqual(expect.objectContaining({ event: "suggestion.rejected", suggestionId: "s1" }));
    expect(parse(await handle(event("POST", "/api/suggestions/zz/reject", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue(undefined) })))).status).toBe(404);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/reject", undefined, admin),
      deps(store({ rejectSuggestion: vi.fn().mockResolvedValue(false) })))).status).toBe(409);
    log.mockRestore();
  });
});

describe("notifications", () => {
  it("suggest notifies admins with the suggestion payload", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    await handle(event("POST", "/api/suggestions", { name: "Cookery", bookId: "b1" }), d);
    expect(d.notify).toHaveBeenCalledWith("suggestion_pending", { suggestionId: "id-1", name: "Cookery", bookId: "b1", suggestedBy: "u@x" }, "admins");
    log.mockRestore();
  });
  it("accept notifies the suggester and everyone; reject notifies the suggester", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin), d);
    expect(d.notify).toHaveBeenNthCalledWith(1, "suggestion_resolved", { suggestionId: "s1", name: "Cookbooks", status: "accepted", resolvedBy: "a@x", bookId: "b1" }, ["z@x"]);
    expect(d.notify).toHaveBeenNthCalledWith(2, "category_created", { name: "Cookbooks", createdBy: "a@x", source: "suggestion" }, "everyone");
    const r = deps();
    await handle(event("POST", "/api/suggestions/s1/reject", undefined, admin), r);
    expect(r.notify).toHaveBeenCalledWith("suggestion_resolved", { suggestionId: "s1", name: "Cookbooks", status: "rejected", resolvedBy: "a@x", bookId: "b1" }, ["z@x"]);
    log.mockRestore();
  });
  it("direct category creation notifies everyone", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const d = deps();
    await handle(event("POST", "/api/categories", { name: "Essays" }, admin), d);
    expect(d.notify).toHaveBeenCalledWith("category_created", { name: "Essays", createdBy: "a@x", source: "admin" }, "everyone");
    expect(events()).toContainEqual(expect.objectContaining({ event: "category.created", name: "Essays", source: "admin" }));
    log.mockRestore();
  });
  it("does not notify on failed writes, and a notify failure does not change the response", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dup = deps(store({ putCategory: vi.fn().mockResolvedValue(false) }));
    await handle(event("POST", "/api/categories", { name: "Fresh" }, admin), dup);
    expect(dup.notify).not.toHaveBeenCalled();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = deps(store(), { notify: vi.fn().mockRejectedValue(new Error("cognito down")) });
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "Cookery" }), broken)).status).toBe(201);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    log.mockRestore();
  });
});

describe("failures", () => {
  it("500s with a JSON error when the store throws", async () => {
    const s = store({ listCategories: vi.fn().mockRejectedValue(new Error("boom")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, json } = parse(await handle(event("GET", "/api/library"), deps(s)));
    expect(status).toBe(500);
    expect(json).toEqual({ error: "Internal error" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
