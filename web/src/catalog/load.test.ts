import { describe, expect, it, vi } from "vitest";
import { loadCatalog } from "./load";

describe("loadCatalog", () => {
  it("fetches /catalog.json", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ generatedAt: "t", books: [] }) });
    const c = await loadCatalog(fetchFn);
    expect(c.books).toEqual([]);
    expect(fetchFn).toHaveBeenCalledWith("/catalog.json", expect.objectContaining({ cache: "no-cache" }));
  });
  it("throws on failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(loadCatalog(fetchFn)).rejects.toThrow("Catalog request failed: 503");
  });
});
