import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Catalog } from "../lambda/download/download";
import { Deps, handle, URL_TTL_SECONDS } from "../lambda/download/index";

const catalog: Catalog = {
  books: [{ id: "abc", title: "Attacking Network Protocols", formats: [
    { type: "epub", size: 10, s3Key: "books/B/EPUB/anp.epub" },
  ] }],
};

function event(body: string | undefined, email?: string | undefined) {
  const actualEmail = email === undefined && arguments.length < 2 ? "user@example.com" : email;
  return {
    body,
    requestContext: { authorizer: { jwt: { claims: actualEmail ? { email: actualEmail } : {}, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    loadCatalog: vi.fn().mockResolvedValue(catalog),
    presign: vi.fn().mockResolvedValue("https://signed.example/x"),
    logDownload: vi.fn().mockResolvedValue(undefined),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    ...overrides,
  };
}

function parse(res: Awaited<ReturnType<typeof handle>>) {
  const r = res as { statusCode: number; body: string };
  return { status: r.statusCode, json: JSON.parse(r.body) };
}

describe("handle", () => {
  it("returns a presigned url, logs the download, and echoes the TTL", async () => {
    const d = deps();
    const { status, json } = parse(await handle(event('{"bookId":"abc","format":"epub"}'), d));
    expect(status).toBe(200);
    expect(json).toEqual({ url: "https://signed.example/x", expiresIn: URL_TTL_SECONDS, filename: "Attacking Network Protocols.epub" });
    expect(d.presign).toHaveBeenCalledWith("books/B/EPUB/anp.epub", "Attacking Network Protocols.epub");
    expect(d.logDownload).toHaveBeenCalledWith({
      email: "user@example.com", sk: "2026-09-01T12:00:00.000Z#abc", bookId: "abc",
      format: "epub", title: "Attacking Network Protocols", timestamp: "2026-09-01T12:00:00.000Z",
    });
  });
  it("400 on a bad body", async () => {
    expect(parse(await handle(event("nope"), deps())).status).toBe(400);
  });
  it("401 when the token has no email claim", async () => {
    expect(parse(await handle(event('{"bookId":"abc","format":"epub"}', undefined), deps())).status).toBe(401);
  });
  it("404 for an unknown book or format, without logging", async () => {
    const d = deps();
    expect(parse(await handle(event('{"bookId":"abc","format":"pdf"}'), d)).status).toBe(404);
    expect(d.logDownload).not.toHaveBeenCalled();
  });
  it("502 when the catalog cannot be loaded", async () => {
    const d = deps({ loadCatalog: vi.fn().mockRejectedValue(new Error("s3 down")) });
    expect(parse(await handle(event('{"bookId":"abc","format":"epub"}'), d)).status).toBe(502);
  });
  it("502 when presigning fails", async () => {
    const d = deps({ presign: vi.fn().mockRejectedValue(new Error("kms down")) });
    const { status, json } = parse(await handle(event('{"bookId":"abc","format":"epub"}'), d));
    expect(status).toBe(502);
    expect(json).toEqual({ error: "Download unavailable" });
  });
  it("502 when logging the download fails", async () => {
    const d = deps({ logDownload: vi.fn().mockRejectedValue(new Error("ddb down")) });
    expect(parse(await handle(event('{"bookId":"abc","format":"epub"}'), d)).status).toBe(502);
  });
});
