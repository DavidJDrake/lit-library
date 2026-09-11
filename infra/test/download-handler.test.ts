import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Catalog } from "../lambda/download/download";
import { Deps, handle, URL_TTL_SECONDS } from "../lambda/download/index";
import type { OpdsTokenResolver } from "../lambda/download/opds-store";

const catalog: Catalog = {
  books: [{ id: "abc", title: "Attacking Network Protocols", authors: ["James Forshaw"], formats: [
    { type: "epub", size: 10, s3Key: "books/B/EPUB/anp.epub" },
  ] }],
};

function event(body: string | undefined, email?: string | undefined) {
  const actualEmail = email === undefined && arguments.length < 2 ? "user@example.com" : email;
  return {
    body,
    rawPath: "/api/download",
    requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: actualEmail ? { email: actualEmail } : {}, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2;
}

function getEvent(path: string, query: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    queryStringParameters: query,
    requestContext: { http: { method: "GET" } },
  } as unknown as APIGatewayProxyEventV2;
}

function opds(overrides: Partial<OpdsTokenResolver> = {}): OpdsTokenResolver {
  return { resolveToken: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    loadCatalog: vi.fn().mockResolvedValue(catalog),
    presign: vi.fn().mockResolvedValue("https://signed.example/x"),
    logDownload: vi.fn().mockResolvedValue(undefined),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    opds: opds(),
    ...overrides,
  };
}

function parse(res: Awaited<ReturnType<typeof handle>>) {
  const r = res as { statusCode: number; body?: string; headers?: Record<string, string> };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined, headers: r.headers ?? {} };
}

describe("POST /api/download", () => {
  it("returns a presigned url, logs the download, and echoes the TTL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const d = deps();
    const { status, json } = parse(await handle(event('{"bookId":"abc","format":"epub"}'), d));
    expect(status).toBe(200);
    expect(json).toEqual({ url: "https://signed.example/x", expiresIn: URL_TTL_SECONDS, filename: "Attacking Network Protocols.epub" });
    expect(d.presign).toHaveBeenCalledWith("books/B/EPUB/anp.epub", "Attacking Network Protocols.epub");
    expect(d.logDownload).toHaveBeenCalledWith({
      email: "user@example.com", sk: "2026-09-01T12:00:00.000Z#abc", bookId: "abc",
      format: "epub", title: "Attacking Network Protocols", timestamp: "2026-09-01T12:00:00.000Z",
    });
    expect(events()).toContainEqual(expect.objectContaining({ event: "download.issued", email: "user@example.com", bookId: "abc", format: "epub" }));
    log.mockRestore();
  });
  it("400 on a bad body", async () => {
    expect(parse(await handle(event("nope"), deps())).status).toBe(400);
  });
  it("keys the download row by a lowercased email, so one reader cannot split across two partitions", async () => {
    // The downloads table is keyed by this value, and Send-to-Kindle writes the same
    // table. If one producer lowercased and the other did not, a reader with a
    // mixed-case address would get half their history under each spelling.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    const { status } = parse(await handle(event('{"bookId":"abc","format":"epub"}', "Reader@Example.COM"), d));
    expect(status).toBe(200);
    expect(d.logDownload).toHaveBeenCalledWith(expect.objectContaining({ email: "reader@example.com" }));
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(
      expect.objectContaining({ event: "download.issued", email: "reader@example.com" }),
    );
    log.mockRestore();
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
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({ presign: vi.fn().mockRejectedValue(new Error("kms down")) });
    const { status, json } = parse(await handle(event('{"bookId":"abc","format":"epub"}'), d));
    expect(status).toBe(502);
    expect(json).toEqual({ error: "Download unavailable" });
    log.mockRestore();
  });
  it("502 when logging the download fails", async () => {
    const d = deps({ logDownload: vi.fn().mockRejectedValue(new Error("ddb down")) });
    expect(parse(await handle(event('{"bookId":"abc","format":"epub"}'), d)).status).toBe(502);
  });
});

describe("GET /api/opds (feed)", () => {
  it("returns the OPDS 2.0 feed for a valid token: every book, one acquisition link per format", async () => {
    const d = deps({ opds: opds({ resolveToken: vi.fn().mockResolvedValue("reader@example.com") }) });
    const res = await handle(getEvent("/api/opds", { token: "good-token" }), d);
    const r = res as { statusCode: number; headers: Record<string, string>; body: string };
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/opds+json");
    const feed = JSON.parse(r.body);
    expect(feed.metadata.title).toBe("Lit Library");
    expect(feed.links).toEqual(expect.arrayContaining([expect.objectContaining({ rel: "self" })]));
    expect(feed.publications).toHaveLength(1);
    expect(feed.publications[0].metadata.title).toBe("Attacking Network Protocols");
    expect(feed.publications[0].metadata.author).toEqual([{ name: "James Forshaw" }]);
    expect(feed.publications[0].links).toEqual([
      expect.objectContaining({ rel: "http://opds-spec.org/acquisition", type: "application/epub+zip" }),
    ]);
    // The token travels with every link, so a reader app can follow them without re-authenticating.
    expect(feed.publications[0].links[0].href).toContain("token=good-token");
    expect((d.opds.resolveToken as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("good-token");
  });

  it("401s with no detail for a missing token", async () => {
    const { status, json } = parse(await handle(getEvent("/api/opds", {}), deps()));
    expect(status).toBe(401);
    expect(json).toEqual({ error: "unauthorized" });
  });

  it("401s a token that does not resolve (unknown, malformed, or revoked) — same response for all", async () => {
    const d = deps({ opds: opds({ resolveToken: vi.fn().mockResolvedValue(undefined) }) });
    const res1 = parse(await handle(getEvent("/api/opds", { token: "unknown" }), d));
    const res2 = parse(await handle(getEvent("/api/opds", { token: "mal formed!" }), d));
    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect(res1.json).toEqual(res2.json);
  });

  it("502s when the catalog cannot be loaded", async () => {
    const d = deps({ opds: opds({ resolveToken: vi.fn().mockResolvedValue("reader@example.com") }), loadCatalog: vi.fn().mockRejectedValue(new Error("down")) });
    expect(parse(await handle(getEvent("/api/opds", { token: "good" }), d)).status).toBe(502);
  });
});

describe("GET /api/opds/download/{bookId}/{format} (acquisition)", () => {
  it("redirects with a freshly signed URL and logs the download exactly like a website download", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({ opds: opds({ resolveToken: vi.fn().mockResolvedValue("reader@example.com") }) });
    const res = await handle(getEvent("/api/opds/download/abc/epub", { token: "good-token" }), d);
    const r = res as { statusCode: number; headers: Record<string, string> };
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("https://signed.example/x");
    expect(d.presign).toHaveBeenCalledWith("books/B/EPUB/anp.epub", "Attacking Network Protocols.epub");
    expect(d.logDownload).toHaveBeenCalledWith({
      email: "reader@example.com", sk: "2026-09-01T12:00:00.000Z#abc", bookId: "abc",
      format: "epub", title: "Attacking Network Protocols", timestamp: "2026-09-01T12:00:00.000Z",
    });
    log.mockRestore();
  });

  it("401s with no detail for a missing, unknown, malformed, or revoked token", async () => {
    const d = deps({ opds: opds({ resolveToken: vi.fn().mockResolvedValue(undefined) }) });
    expect(parse(await handle(getEvent("/api/opds/download/abc/epub", {}), d)).status).toBe(401);
    expect(parse(await handle(getEvent("/api/opds/download/abc/epub", { token: "revoked" }), d)).status).toBe(401);
    expect(d.logDownload).not.toHaveBeenCalled();
    expect(d.presign).not.toHaveBeenCalled();
  });

  it("404s an unknown book or format for a valid token, without logging", async () => {
    const d = deps({ opds: opds({ resolveToken: vi.fn().mockResolvedValue("reader@example.com") }) });
    expect(parse(await handle(getEvent("/api/opds/download/abc/pdf", { token: "good" }), d)).status).toBe(404);
    expect(d.logDownload).not.toHaveBeenCalled();
  });

  it("502s when presigning fails", async () => {
    const d = deps({
      opds: opds({ resolveToken: vi.fn().mockResolvedValue("reader@example.com") }),
      presign: vi.fn().mockRejectedValue(new Error("kms down")),
    });
    expect(parse(await handle(getEvent("/api/opds/download/abc/epub", { token: "good" }), d)).status).toBe(502);
  });
});

describe("unmatched routes", () => {
  it("404s a path this Lambda does not serve", async () => {
    const e = { rawPath: "/api/nope", requestContext: { http: { method: "GET" } } } as unknown as APIGatewayProxyEventV2;
    expect(parse(await handle(e, deps())).status).toBe(404);
  });
});
