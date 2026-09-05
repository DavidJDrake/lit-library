import { describe, expect, it, vi } from "vitest";
import { fetchNotifications, markNotificationsRead } from "./api";

function fetchWith(status: number, body?: unknown) {
  return vi.fn(async () => ({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body })) as unknown as typeof fetch;
}
const call = (f: typeof fetch, n = 0) => { const m = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[n]; return { url: String(m[0]), init: m[1] as RequestInit }; };

describe("fetchNotifications", () => {
  it("GETs with limit/before and validates the shape", async () => {
    const page = { items: [{ id: "2026-09-05T10:00:00.000Z#a", type: "books_added", payload: { count: 1, bookIds: ["x"] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" }], unread: 1, next: "2026-09-05T10:00:00.000Z#a" };
    const f = fetchWith(200, page);
    expect(await fetchNotifications("/api", "tok", { limit: 5, before: "2026-09-06T00:00:00.000Z#z" }, f)).toEqual(page);
    expect(call(f).url).toBe("/api/notifications?limit=5&before=2026-09-06T00%3A00%3A00.000Z%23z");
    expect((call(f).init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const g = fetchWith(200, page);
    await fetchNotifications("/api", "tok", {}, g);
    expect(call(g).url).toBe("/api/notifications");
    await expect(fetchNotifications("/api", "tok", {}, fetchWith(200, { items: "no" }))).rejects.toThrow(/malformed/);
    await expect(fetchNotifications("/api", "tok", {}, fetchWith(500, { error: "boom" }))).rejects.toThrow("boom");
  });
});

describe("markNotificationsRead", () => {
  it("POSTs ids or all and requires 204", async () => {
    const f = fetchWith(204);
    await markNotificationsRead("/api", "tok", ["2026-09-05T10:00:00.000Z#a"], f);
    expect(call(f).url).toBe("/api/notifications/read");
    expect(call(f).init.body).toBe(JSON.stringify({ ids: ["2026-09-05T10:00:00.000Z#a"] }));
    const g = fetchWith(204);
    await markNotificationsRead("/api", "tok", "all", g);
    expect(call(g).init.body).toBe(JSON.stringify({ all: true }));
    await expect(markNotificationsRead("/api", "tok", "all", fetchWith(400, { error: "bad" }))).rejects.toThrow("bad");
  });
});
