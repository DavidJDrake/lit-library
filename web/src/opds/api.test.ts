import { describe, expect, it, vi } from "vitest";
import { generateOpdsToken, getOpdsTokenStatus, revokeOpdsToken } from "./api";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

describe("getOpdsTokenStatus", () => {
  it("reports no token", async () => {
    const fetchFn = vi.fn(async () => json(200, { exists: false, createdAt: null })) as unknown as typeof fetch;
    expect(await getOpdsTokenStatus("/api", "tok", fetchFn)).toEqual({ exists: false, createdAt: null });
  });
  it("reports an existing token's creation time", async () => {
    const fetchFn = vi.fn(async () => json(200, { exists: true, createdAt: "2026-09-06T12:00:00.000Z" })) as unknown as typeof fetch;
    expect(await getOpdsTokenStatus("/api", "tok", fetchFn)).toEqual({ exists: true, createdAt: "2026-09-06T12:00:00.000Z" });
  });
  it("tolerates a malformed body", async () => {
    const fetchFn = vi.fn(async () => json(200, {})) as unknown as typeof fetch;
    expect(await getOpdsTokenStatus("/api", "tok", fetchFn)).toEqual({ exists: false, createdAt: null });
  });
  it("sends a GET to /opds/token with the bearer token", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => { calls.push([u, init]); return json(200, { exists: false, createdAt: null }); }) as unknown as typeof fetch;
    await getOpdsTokenStatus("/api", "id-tok", fetchFn);
    expect(calls[0][0]).toBe("/api/opds/token");
    expect(calls[0][1]?.method).toBe("GET");
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer id-tok");
  });
});

describe("generateOpdsToken", () => {
  it("POSTs and returns the plaintext token and creation time", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => { calls.push([u, init]); return json(201, { token: "the-plaintext-token", createdAt: "2026-09-06T12:00:00.000Z" }); }) as unknown as typeof fetch;
    const out = await generateOpdsToken("/api", "id-tok", fetchFn);
    expect(out).toEqual({ token: "the-plaintext-token", createdAt: "2026-09-06T12:00:00.000Z" });
    expect(calls[0][0]).toBe("/api/opds/token");
    expect(calls[0][1]?.method).toBe("POST");
  });
  it("throws when the server's response is missing the token", async () => {
    const fetchFn = vi.fn(async () => json(201, { createdAt: "2026-09-06T12:00:00.000Z" })) as unknown as typeof fetch;
    await expect(generateOpdsToken("/api", "tok", fetchFn)).rejects.toThrow();
  });
  it("throws on an unexpected status", async () => {
    const fetchFn = vi.fn(async () => json(500, { error: "internal" })) as unknown as typeof fetch;
    await expect(generateOpdsToken("/api", "tok", fetchFn)).rejects.toThrow();
  });
});

describe("revokeOpdsToken", () => {
  it("DELETEs /opds/token", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => {
      calls.push([u, init]);
      return { ok: true, status: 204, headers: new Headers(), json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    await revokeOpdsToken("/api", "id-tok", fetchFn);
    expect(calls[0][0]).toBe("/api/opds/token");
    expect(calls[0][1]?.method).toBe("DELETE");
  });
});
