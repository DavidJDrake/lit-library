import { describe, expect, it, vi } from "vitest";
import { apiCall } from "./apiCall";

function fetchWith(status: number, body?: unknown, contentType: string | null = "application/json") {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("apiCall", () => {
  it("throws the body's message over its error code", async () => {
    await expect(apiCall("/api", "tok", "/x", { method: "PUT" }, 204, fetchWith(400, { error: "bad", message: "Human text" })))
      .rejects.toThrow("Human text");
  });
  it("falls back to the error code when there is no message", async () => {
    await expect(apiCall("/api", "tok", "/x", { method: "PUT" }, 204, fetchWith(400, { error: "Only error" })))
      .rejects.toThrow("Only error");
  });
  it("falls back to a generic message for a non-JSON body", async () => {
    await expect(apiCall("/api", "tok", "/x", { method: "PUT" }, 204, fetchWith(400, "<html>", "text/html")))
      .rejects.toThrow("Request failed: expected 204, got 400");
  });
});
