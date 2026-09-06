import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Catalog } from "../lambda/download/download";
import { handle, tagValue, type Deps, type KindleStore } from "../lambda/kindle/index";
import { KINDLE_MAX_BYTES } from "../lambda/kindle/lib";

const NOW = "2026-09-05T12:00:00.000Z";
const catalog: Catalog = { books: [
  { id: "b1", title: "Attacking Network Protocols", formats: [{ type: "epub", size: 1000, s3Key: "books/a.epub" }, { type: "pdf", size: 2000, s3Key: "books/a.pdf" }] },
  { id: "big", title: "Huge Atlas", formats: [{ type: "pdf", size: KINDLE_MAX_BYTES + 1, s3Key: "books/big.pdf" }] },
  { id: "cbz", title: "Comic", formats: [{ type: "cbz", size: 10, s3Key: "books/c.cbz" }] },
] };

function store(address: string | null = "jay_abc@kindle.com"): KindleStore {
  return { getAddress: vi.fn().mockResolvedValue(address), setAddress: vi.fn().mockResolvedValue(undefined) };
}
function deps(over: Partial<Deps> = {}): Deps {
  return {
    store: store(), loadCatalog: vi.fn().mockResolvedValue(catalog),
    loadObject: vi.fn().mockResolvedValue(new TextEncoder().encode("PKdata")),
    sender: { send: vi.fn().mockResolvedValue({ messageId: "ses-1" }) },
    logSend: vi.fn().mockResolvedValue(undefined), now: () => new Date(NOW), senderAddress: "library@lit.example.com",
    ...over,
  };
}
// Note: a plain default parameter (`email = "Jay@Example.com"`) can't be overridden by an
// explicit `undefined` argument (JS applies the default to an explicit `undefined` the same as
// an omitted one), so "no email" is distinguished via arguments.length instead.
function ev(method: string, path: string, body?: unknown, email?: string) {
  const resolvedEmail = arguments.length >= 4 ? email : "Jay@Example.com";
  return {
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: resolvedEmail ? { email: resolvedEmail } : {}, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const parse = (r: Awaited<ReturnType<typeof handle>>) => { const x = r as { statusCode: number; body?: string }; return { status: x.statusCode, json: x.body ? JSON.parse(x.body) : undefined }; };

describe("address", () => {
  it("GET returns the saved address or null, keyed by the lowercased email", async () => {
    const d = deps();
    expect(parse(await handle(ev("GET", "/api/kindle/address"), d))).toEqual({ status: 200, json: { kindleAddress: "jay_abc@kindle.com" } });
    expect(d.store.getAddress).toHaveBeenCalledWith("jay@example.com");
    expect(parse(await handle(ev("GET", "/api/kindle/address"), deps({ store: store(null) }))).json).toEqual({ kindleAddress: null });
  });
  it("PUT validates, lowercases, clears on empty, 400s otherwise", async () => {
    const d = deps();
    expect(parse(await handle(ev("PUT", "/api/kindle/address", { kindleAddress: "Jay_ABC@Kindle.com" }), d)).status).toBe(204);
    expect(d.store.setAddress).toHaveBeenCalledWith("jay@example.com", "jay_abc@kindle.com", NOW);
    expect(parse(await handle(ev("PUT", "/api/kindle/address", { kindleAddress: "" }), d)).status).toBe(204);
    expect(d.store.setAddress).toHaveBeenLastCalledWith("jay@example.com", null, NOW);
    expect(parse(await handle(ev("PUT", "/api/kindle/address", { kindleAddress: "jay@gmail.com" }), d)).status).toBe(400);
    expect(parse(await handle(ev("PUT", "/api/kindle/address", {}), d)).status).toBe(400);
  });
});

describe("send", () => {
  it("sends the EPUB by default with the right MIME, tags, log row, and 202", async () => {
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { status, json } = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(status).toBe(202);
    expect(json).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub" });
    expect(d.loadObject).toHaveBeenCalledWith("books/a.epub");
    const [raw, tags] = (d.sender.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(raw).toContain("To: jay_abc@kindle.com\r\n");
    expect(raw).toContain("From: library@lit.example.com\r\n");
    expect(raw).toContain("Subject: Attacking Network Protocols\r\n");
    expect(raw).toContain('filename="Attacking Network Protocols.epub"');
    expect(tags).toEqual({ recipient: tagValue("jay@example.com"), bookId: "b1" });
    expect(d.logSend).toHaveBeenCalledWith({ email: "jay@example.com", sk: `${NOW}#b1`, bookId: "b1", format: "kindle:epub", title: "Attacking Network Protocols", timestamp: NOW });
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.sent", email: "jay@example.com", bookId: "b1", format: "epub", bytes: 6, sesMessageId: "ses-1" }));
    log.mockRestore();
  });
  it("honours an explicit pdf request", async () => {
    const d = deps();
    const { json } = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1", format: "pdf" }), d));
    expect(json.format).toBe("pdf");
    expect(d.loadObject).toHaveBeenCalledWith("books/a.pdf");
  });
  it("409 no_address, 404 unknown, 400 unsupported, 413 too_large (before reading S3)", async () => {
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store: store(null) }))).json).toEqual({ error: "no_address" });
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "zz" }), deps())).status).toBe(404);
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "cbz" }), deps())).json).toEqual({ error: "unsupported" });
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "big" }), d));
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "too_large", bytes: KINDLE_MAX_BYTES + 1, limit: KINDLE_MAX_BYTES });
    expect(d.loadObject).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.oversize", bookId: "big" }));
    log.mockRestore();
    expect(parse(await handle(ev("POST", "/api/kindle/send", {}), deps())).status).toBe(400);
  });
  it("502s when the catalog can't be read from storage", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({ loadCatalog: vi.fn().mockRejectedValue(new Error("S3 down")) });
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "failed", message: "Could not read the book from storage" });
    expect(d.logSend).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.send_failed", bookId: "b1", stage: "catalog" }));
    log.mockRestore(); spy.mockRestore();
  });
  it("502s when the object can't be read from storage", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({ loadObject: vi.fn().mockRejectedValue(new Error("object missing")) });
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "failed", message: "Could not read the book from storage" });
    expect(d.logSend).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.send_failed", bookId: "b1", stage: "object" }));
    log.mockRestore(); spy.mockRestore();
  });
  it("maps the sandbox rejection to 502 not_enabled and other failures to 502 failed, logging send_failed and no log row", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sandbox = deps({ sender: { send: vi.fn().mockRejectedValue(Object.assign(new Error("Email address is not verified."), { name: "MessageRejected" })) } });
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), sandbox));
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" });
    expect(sandbox.logSend).not.toHaveBeenCalled();
    const broken = deps({ sender: { send: vi.fn().mockRejectedValue(new Error("SES down")) } });
    const r2 = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), broken));
    expect(r2.status).toBe(502);
    expect(r2.json).toEqual({ error: "failed", message: "SES down" });
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((e) => e.event === "kindle.send_failed")).toHaveLength(2);
    log.mockRestore(); spy.mockRestore();
  });
  it("still 202s and logs kindle.sent when the downloads-row write fails (SES already accepted)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({ logSend: vi.fn().mockRejectedValue(new Error("ddb throttled")) });
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub" });
    const events = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(events).toContainEqual(expect.objectContaining({ event: "kindle.send_failed", bookId: "b1", code: "log", reason: "ddb throttled" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "kindle.sent", bookId: "b1", format: "epub" }));
    log.mockRestore(); spy.mockRestore();
  });
  it("401 without email, 404 on unknown routes, 500 on unexpected errors", async () => {
    expect(parse(await handle(ev("GET", "/api/kindle/address", undefined, undefined), deps())).status).toBe(401);
    expect(parse(await handle(ev("DELETE", "/api/kindle/address"), deps())).status).toBe(404);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parse(await handle(ev("GET", "/api/kindle/address"), deps({ store: { getAddress: vi.fn().mockRejectedValue(new Error("boom")), setAddress: vi.fn() } }))).status).toBe(500);
    spy.mockRestore();
  });
});

describe("tagValue", () => {
  it("hex-encodes so the value fits SES's [A-Za-z0-9_-] tag charset", () => {
    expect(tagValue("jay@example.com")).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(tagValue("jay@example.com"), "hex").toString()).toBe("jay@example.com");
  });
});
