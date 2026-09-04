import { generateKeyPairSync } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { handle, type SessionEvent } from "../lambda/session/index";

const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const env = { siteDomain: "lit.example.com", keyPairId: "K2EXAMPLE" };

function event(method: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return { requestContext: { http: { method }, authorizer: { jwt: { claims: { email: "u@example.com" }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
// The real DELETE /api/session event: no authorizer at all (see infra/lib/api.ts).
function unauthenticatedDeleteEvent(): APIGatewayProxyEventV2 {
  return { requestContext: { http: { method: "DELETE" } } } as unknown as APIGatewayProxyEventV2;
}
type Result = { statusCode: number; cookies?: string[]; body?: string };

describe("session handler", () => {
  it("GET sets the three signed cookies", async () => {
    const r = (await handle(event("GET"), { loadPrivateKey: async () => privateKeyPem, now: () => new Date() }, env)) as Result;
    expect(r.statusCode).toBe(204);
    expect(r.cookies?.map((c) => c.split("=")[0])).toEqual(["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id"]);
    expect(r.cookies?.[2]).toContain("CloudFront-Key-Pair-Id=K2EXAMPLE");
  });
  it("DELETE clears them without loading the signing key", async () => {
    const loadPrivateKey = vi.fn();
    const r = (await handle(event("DELETE"), { loadPrivateKey, now: () => new Date() }, env)) as Result;
    expect(r.statusCode).toBe(204);
    expect(r.cookies?.every((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(loadPrivateKey).not.toHaveBeenCalled();
  });
  it("DELETE with no authorizer (the real unauthenticated shape) clears cookies without loading the signing key", async () => {
    const loadPrivateKey = vi.fn();
    const r = (await handle(unauthenticatedDeleteEvent() as SessionEvent, { loadPrivateKey, now: () => new Date() }, env)) as Result;
    expect(r.statusCode).toBe(204);
    expect(r.cookies?.every((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(loadPrivateKey).not.toHaveBeenCalled();
  });
  it("rejects other methods", async () => {
    const r = (await handle(event("POST"), { loadPrivateKey: vi.fn(), now: () => new Date() }, env)) as Result;
    expect(r.statusCode).toBe(405);
  });
  it("502s when the key cannot be loaded, logging only the error name/message (never key material)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = (await handle(event("GET"), { loadPrivateKey: async () => { throw new Error("nope"); }, now: () => new Date() }, env)) as Result;
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body!)).toEqual({ error: "Session unavailable" });
    expect(errorSpy).toHaveBeenCalledWith("signing key load failed:", "Error", "nope");
    errorSpy.mockRestore();
  });
});
