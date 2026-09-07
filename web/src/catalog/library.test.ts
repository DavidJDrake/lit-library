import { describe, expect, it, vi } from "vitest";
import {
  applyOverlay, createCategory, fetchOverlay, resolveSuggestion, setBookCategory, setBookReadingStatus, suggestCategory, suggesterLabel, type Overlay,
} from "./library";
import type { Book } from "./types";

const book = (id: string, category: string, over: Partial<Book> = {}): Book => ({
  id, title: id, authors: [], description: null, category, subjects: [], publisher: null, bundle: "b", year: null,
  formats: [], coverUrl: null, addedAt: "2026-01-01", ...over,
});
const overlay: Overlay = {
  categories: [{ name: "Fiction", source: "seed" }, { name: "Cookbooks", source: "admin" }],
  bookCategories: { a: "Cookbooks" },
  suggestions: [],
  readingStatuses: { a: "reading" },
  downloaded: ["b"],
};

function fetchWith(status: number, body?: unknown, contentType = "application/json") {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    json: async () => body,
  })) as unknown as typeof fetch;
}
function call(f: typeof fetch, n = 0) {
  const m = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[n];
  return { url: String(m[0]), init: m[1] as RequestInit };
}

describe("fetchOverlay", () => {
  it("GETs /library with the bearer token and validates the shape", async () => {
    const f = fetchWith(200, overlay);
    expect(await fetchOverlay("/api", "tok", f)).toEqual(overlay);
    const { url, init } = call(f);
    expect(url).toBe("/api/library");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
  it("throws on non-200, non-JSON, and malformed bodies", async () => {
    await expect(fetchOverlay("/api", "tok", fetchWith(500, { error: "x" }))).rejects.toThrow("x");
    await expect(fetchOverlay("/api", "tok", fetchWith(200, "<html>", "text/html"))).rejects.toThrow(/non-JSON/);
    await expect(fetchOverlay("/api", "tok", fetchWith(200, { categories: "nope" }))).rejects.toThrow(/malformed/);
  });
});

describe("applyOverlay", () => {
  it("replaces categories from the map, keeps others, and preserves identity of untouched books", () => {
    const a = book("a", "Fiction"), b = book("b", "Fiction");
    const out = applyOverlay([a, b], overlay);
    expect(out.map((x) => x.category)).toEqual(["Cookbooks", "Fiction"]);
    expect(a.category).toBe("Fiction"); // input not mutated
  });
  it("merges the chosen reading status and the derived downloaded set, independently of each other", () => {
    const a = book("a", "Fiction"); // in readingStatuses (reading), not in downloaded
    const b = book("b", "Fiction"); // in downloaded, not in readingStatuses
    const c = book("c", "Fiction"); // in neither
    const out = applyOverlay([a, b, c], overlay);
    expect(out[0]).toMatchObject({ readingStatus: "reading", downloaded: false });
    expect(out[1]).toMatchObject({ readingStatus: null, downloaded: true });
    expect(out[2]).toBe(c); // wholly untouched: identity preserved, exactly like category
  });
  it("shows both facts together for a book that is downloaded and also has a chosen status", () => {
    const both: Overlay = { ...overlay, bookCategories: {}, readingStatuses: { a: "finished" }, downloaded: ["a"] };
    const out = applyOverlay([book("a", "Fiction")], both);
    expect(out[0]).toMatchObject({ readingStatus: "finished", downloaded: true });
  });
  it("preserves identity of a book untouched by category, status, or downloaded", () => {
    const untouched: Overlay = { categories: [], bookCategories: {}, suggestions: [], readingStatuses: {}, downloaded: [] };
    const c = book("c", "Fiction");
    expect(applyOverlay([c], untouched)[0]).toBe(c);
  });
});

describe("mutations", () => {
  it("setBookCategory PUTs and requires 204", async () => {
    const f = fetchWith(204);
    await setBookCategory("/api", "tok", "a b", "Fiction", f);
    const { url, init } = call(f);
    expect(url).toBe("/api/books/a%20b/category");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ category: "Fiction" }));
    await expect(setBookCategory("/api", "tok", "a", "Nope", fetchWith(400, { error: "Unknown category" }))).rejects.toThrow("Unknown category");
    await expect(setBookCategory("/api", "tok", "a", "X", fetchWith(200, undefined, ""))).rejects.toThrow(/204/);
  });
  it("setBookReadingStatus PUTs a status and requires 204; null clears", async () => {
    const f = fetchWith(204);
    await setBookReadingStatus("/api", "tok", "a b", "reading", f);
    const { url, init } = call(f);
    expect(url).toBe("/api/books/a%20b/status");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ status: "reading" }));
    const g = fetchWith(204);
    await setBookReadingStatus("/api", "tok", "a", null, g);
    expect(call(g).init.body).toBe(JSON.stringify({ status: null }));
    await expect(setBookReadingStatus("/api", "tok", "a", "reading", fetchWith(400, { error: "status must be one of..." }))).rejects.toThrow(/status must be one of/);
  });
  it("suggestCategory POSTs name and optional bookId and requires 201", async () => {
    const f = fetchWith(201, { id: "s1" });
    await suggestCategory("/api", "tok", "Cookbooks", "a", f);
    expect(call(f).init.body).toBe(JSON.stringify({ name: "Cookbooks", bookId: "a" }));
    const g = fetchWith(201, { id: "s2" });
    await suggestCategory("/api", "tok", "Cookbooks", undefined, g);
    expect(call(g).init.body).toBe(JSON.stringify({ name: "Cookbooks" }));
    await expect(suggestCategory("/api", "tok", "Fiction", undefined, fetchWith(409, { error: "exists" }))).rejects.toThrow("exists");
  });
  it("createCategory and resolveSuggestion hit the admin routes", async () => {
    const f = fetchWith(201, { name: "X" });
    await createCategory("/api", "tok", "X", f);
    expect(call(f).url).toBe("/api/categories");
    const g = fetchWith(204);
    await resolveSuggestion("/api", "tok", "s1", "accept", g);
    expect(call(g).url).toBe("/api/suggestions/s1/accept");
    expect(call(g).init.method).toBe("POST");
    await expect(resolveSuggestion("/api", "tok", "s1", "reject", fetchWith(403, { error: "Admin only" }))).rejects.toThrow("Admin only");
  });
});

describe("suggesterLabel", () => {
  it("shows the local part only", () => {
    expect(suggesterLabel("friend@example.com")).toBe("friend");
    expect(suggesterLabel("weird")).toBe("weird");
  });
});
