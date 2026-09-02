import { describe, expect, it, vi } from "vitest";
import { endSession, establishSession } from "./session";

describe("establishSession", () => {
  it("GETs /session with the ID token and same-origin credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await establishSession("/api", "tok", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith("/api/session", {
      method: "GET", headers: { Authorization: "Bearer tok" }, credentials: "same-origin",
    });
  });
  it("throws on failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    await expect(establishSession("/api", "tok", fetchFn)).rejects.toThrow("Could not start a session: 502");
  });
});

describe("endSession", () => {
  it("DELETEs /session and never throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(endSession("/api", "tok", fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "DELETE" }));
  });
});
