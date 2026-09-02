import { describe, expect, it, vi } from "vitest";
import { loadCatalog } from "./load";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, headers: new Headers({ "content-type": "application/json; charset=utf-8" }), json: async () => body };
}

describe("loadCatalog", () => {
  it("fetches /catalog.json", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ generatedAt: "t", books: [] }));
    const c = await loadCatalog(fetchFn);
    expect(c.books).toEqual([]);
    expect(fetchFn).toHaveBeenCalledWith("/catalog.json", expect.objectContaining({ cache: "no-cache" }));
  });
  it("throws on failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) });
    await expect(loadCatalog(fetchFn)).rejects.toThrow("Catalog request failed: 503");
  });
  it("throws when the response is not JSON (e.g. an HTML error page)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }),
      json: async () => { throw new Error("Unexpected token <"); },
    });
    await expect(loadCatalog(fetchFn)).rejects.toThrow("Catalog request returned non-JSON (is the site deployed?)");
  });
  it("throws when json() throws despite a JSON content-type", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
      json: async () => { throw new Error("Unexpected end of input"); },
    });
    await expect(loadCatalog(fetchFn)).rejects.toThrow("Catalog request returned non-JSON (is the site deployed?)");
  });
  it("throws when the parsed body has no books array", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ generatedAt: "t" }));
    await expect(loadCatalog(fetchFn)).rejects.toThrow("Catalog is malformed");
  });
});
