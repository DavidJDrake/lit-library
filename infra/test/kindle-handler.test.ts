import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Catalog } from "../lambda/download/download";
import type { DeviceList } from "../lambda/kindle/devices";
import { handle, tagValue, type Deps, type KindleStore } from "../lambda/kindle/index";
import { KINDLE_MAX_BYTES } from "../lambda/kindle/lib";

const NOW = "2026-09-05T12:00:00.000Z";
const catalog: Catalog = { books: [
  { id: "b1", title: "Attacking Network Protocols", formats: [{ type: "epub", size: 1000, s3Key: "books/a.epub" }, { type: "pdf", size: 2000, s3Key: "books/a.pdf" }] },
  { id: "big", title: "Huge Atlas", formats: [{ type: "pdf", size: KINDLE_MAX_BYTES + 1, s3Key: "books/big.pdf" }] },
  { id: "cbz", title: "Comic", formats: [{ type: "cbz", size: 10, s3Key: "books/c.cbz" }] },
] };

const ONE_DEVICE: DeviceList = {
  devices: [{ id: "abcd1234", label: "Kindle", address: "jay_abc@kindle.com", addedAt: "2026-09-01T00:00:00.000Z" }],
  defaultDeviceId: "abcd1234",
};
const TWO: DeviceList = {
  devices: [
    { id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: "2026-09-01T00:00:00.000Z" },
    { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com", addedAt: "2026-09-01T00:00:00.000Z" },
  ],
  defaultDeviceId: "bbbbbbbb",
};
function storeStub(list: DeviceList = { devices: [], defaultDeviceId: null }, version: string | null = null) {
  const saved: Array<{ list: DeviceList; updatedAt: string; expected: string | null | undefined }> = [];
  return {
    saved,
    store: {
      getDevices: async () => ({ ...list, version }),
      setDevices: async (_e: string, l: DeviceList, updatedAt: string, expected?: string | null) => {
        saved.push({ list: l, updatedAt, expected });
        return { ok: true as const, version: l.devices.length === 0 ? null : updatedAt };
      },
    } satisfies KindleStore,
  };
}
/** A store that accepts a write only while the caller's version matches, as DynamoDB's condition does. */
function versionedStore(list: DeviceList, version: string | null) {
  let current = version;
  let held = list;
  return {
    get version() { return current; },
    store: {
      getDevices: async () => ({ ...held, version: current }),
      setDevices: async (_e: string, l: DeviceList, updatedAt: string, expected?: string | null) => {
        if (expected !== undefined && expected !== current) return { ok: false as const, reason: "stale" as const };
        held = l;
        current = l.devices.length === 0 ? null : updatedAt;
        return { ok: true as const, version: current };
      },
    } satisfies KindleStore,
  };
}
function deps(over: Partial<Deps> = {}): Deps {
  return {
    store: storeStub(ONE_DEVICE).store, loadCatalog: vi.fn().mockResolvedValue(catalog),
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

describe("device routes", () => {
  it("GET returns the list without addedAt", async () => {
    const { store } = storeStub(TWO);
    const res = parse(await handle(ev("GET", "/api/kindle/devices"), deps({ store })));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }, { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com" }],
      defaultDeviceId: "bbbbbbbb",
      version: null,
    });
  });

  it("PUT saves the canonical list and returns it", async () => {
    const { store, saved } = storeStub(TWO);
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", {
      devices: [{ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com" }, { label: "New", address: "c@kindle.com" }],
      defaultDeviceId: "aaaaaaaa",
    }), deps({ store })));
    expect(res.status).toBe(200);
    expect(res.json.devices[0]).toEqual({ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com" });
    expect(res.json.devices[1].id).toMatch(/^[0-9a-f]{8}$/);
    expect(res.json.defaultDeviceId).toBe("aaaaaaaa");
    expect(saved).toHaveLength(1);
    expect(saved[0].list.devices[0].addedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("PUT rejects a malformed body before touching the store", async () => {
    const { store, saved } = storeStub(TWO);
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", { nope: 1 }), deps({ store })));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad_request", message: "Body must be JSON {devices, defaultDeviceId?}" });
    expect(saved).toHaveLength(0);
  });

  it("PUT surfaces a validation failure and saves nothing", async () => {
    const { store, saved } = storeStub(TWO);
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", { devices: [{ label: "", address: "a@kindle.com" }] }), deps({ store })));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "bad_label", message: "Give the device a name of 30 characters or fewer" });
    expect(saved).toHaveLength(0);
  });

  it("PUT with an empty list clears the setting", async () => {
    const { store, saved } = storeStub(TWO);
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", { devices: [] }), deps({ store })));
    expect(res.json).toEqual({ devices: [], defaultDeviceId: null, version: null });
    expect(saved[0].list.devices).toEqual([]);
  });

  it("GET returns the stored row's version, and PUT sends it back and reports the new one", async () => {
    const seen = "2026-09-04T08:00:00.000Z";
    const { store, saved } = storeStub(TWO, seen);
    expect(parse(await handle(ev("GET", "/api/kindle/devices"), deps({ store }))).json.version).toBe(seen);
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", {
      devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }], version: seen,
    }), deps({ store })));
    expect(saved[0].expected).toBe(seen);
    expect(res.json.version).toBe(NOW);
  });

  it("PUT without a version writes unconditionally, so an older client keeps working", async () => {
    const { store, saved } = storeStub(TWO, "2026-09-04T08:00:00.000Z");
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", {
      devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }],
    }), deps({ store })));
    expect(res.status).toBe(200);
    expect(saved[0].expected).toBeUndefined();
  });

  it("PUT with an explicit null version expects no stored row", async () => {
    const { store, saved } = storeStub({ devices: [], defaultDeviceId: null }, null);
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", {
      devices: [{ label: "Scribe", address: "a@kindle.com" }], version: null,
    }), deps({ store })));
    expect(res.status).toBe(200);
    expect(saved[0].expected).toBeNull();
  });

  it("PUT answers 409 stale when the row moved on, and saves nothing", async () => {
    const store: KindleStore = {
      getDevices: async () => ({ ...TWO, version: "newer" }),
      setDevices: async () => ({ ok: false, reason: "stale" }),
    };
    const res = parse(await handle(ev("PUT", "/api/kindle/devices", {
      devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }], version: "older",
    }), deps({ store })));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "stale", message: "Your devices changed in another tab — reload and try again" });
  });

  it("two tabs saving from the same version: the first wins, the second is told to reload", async () => {
    const seen = "2026-09-04T08:00:00.000Z";
    const { store } = versionedStore(TWO, seen);
    const d = deps({ store });
    const body = (label: string) => ({
      devices: [{ id: "aaaaaaaa", label, address: "a@kindle.com" }, { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com" }],
      defaultDeviceId: "bbbbbbbb", version: seen,
    });
    const first = parse(await handle(ev("PUT", "/api/kindle/devices", body("Study Scribe")), d));
    const second = parse(await handle(ev("PUT", "/api/kindle/devices", body("Desk Scribe")), d));
    expect(first.status).toBe(200);
    expect(first.json.version).toBe(NOW);
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("stale");
    // The loser's rename never reached the row.
    expect(parse(await handle(ev("GET", "/api/kindle/devices"), d)).json.devices[0].label).toBe("Study Scribe");
  });

  it("still 404s an unknown path and 401s a token with no email", async () => {
    const { store } = storeStub(TWO);
    expect(parse(await handle(ev("GET", "/api/kindle/address"), deps({ store }))).status).toBe(404);
    expect(parse(await handle(ev("GET", "/api/kindle/devices", undefined, undefined), deps({ store }))).status).toBe(401);
  });
});

describe("send", () => {
  it("sends the EPUB by default with the right MIME, tags, log row, and 202", async () => {
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { status, json } = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(status).toBe(202);
    expect(json).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub", deviceId: "abcd1234", deviceLabel: "Kindle" });
    expect(d.loadObject).toHaveBeenCalledWith("books/a.epub");
    const [raw, tags] = (d.sender.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(raw).toContain("To: jay_abc@kindle.com\r\n");
    expect(raw).toContain("From: library@lit.example.com\r\n");
    expect(raw).toContain("Subject: Attacking Network Protocols\r\n");
    expect(raw).toContain('filename="Attacking Network Protocols.epub"');
    expect(tags).toEqual({ recipient: tagValue("jay@example.com"), bookId: "b1", deviceId: "abcd1234" });
    expect(d.logSend).toHaveBeenCalledWith({ email: "jay@example.com", sk: `${NOW}#b1`, bookId: "b1", format: "kindle:epub", title: "Attacking Network Protocols", timestamp: NOW });
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.sent", email: "jay@example.com", bookId: "b1", format: "epub", bytes: 6, sesMessageId: "ses-1", deviceId: "abcd1234" }));
    log.mockRestore();
  });
  it("honours an explicit pdf request", async () => {
    const d = deps();
    const { json } = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1", format: "pdf" }), d));
    expect(json.format).toBe("pdf");
    expect(d.loadObject).toHaveBeenCalledWith("books/a.pdf");
  });
  it("409 no_address, 404 unknown, 400 unsupported, 413 too_large (before reading S3)", async () => {
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store: storeStub({ devices: [], defaultDeviceId: null }).store }))).json).toEqual({ error: "no_address" });
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "zz" }), deps())).status).toBe(404);
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "cbz" }), deps())).json).toEqual({ error: "unsupported" });
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "big" }), d));
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "too_large", message: "Too large for Kindle delivery — download instead", bytes: KINDLE_MAX_BYTES + 1, limit: KINDLE_MAX_BYTES });
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
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.send_failed", bookId: "b1", stage: "catalog", deviceId: "abcd1234" }));
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
    expect(r2.json).toEqual({ error: "failed", message: "Could not send the book right now" });
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((e) => e.event === "kindle.send_failed")).toHaveLength(2);
    log.mockRestore(); spy.mockRestore();
  });
  it("still 202s and logs kindle.sent when the downloads-row write fails (SES already accepted)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({ logSend: vi.fn().mockRejectedValue(new Error("ddb throttled")) });
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub", deviceId: "abcd1234", deviceLabel: "Kindle" });
    const events = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(events).toContainEqual(expect.objectContaining({ event: "kindle.send_failed", bookId: "b1", code: "log", reason: "ddb throttled" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "kindle.sent", bookId: "b1", format: "epub", deviceId: "abcd1234" }));
    log.mockRestore(); spy.mockRestore();
  });
  it("401 without email, 404 on unknown routes, 500 on unexpected errors", async () => {
    expect(parse(await handle(ev("GET", "/api/kindle/devices", undefined, undefined), deps())).status).toBe(401);
    expect(parse(await handle(ev("DELETE", "/api/kindle/devices"), deps())).status).toBe(404);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: KindleStore = { getDevices: vi.fn().mockRejectedValue(new Error("boom")), setDevices: vi.fn() };
    expect(parse(await handle(ev("GET", "/api/kindle/devices"), deps({ store: broken }))).status).toBe(500);
    spy.mockRestore();
  });
});

describe("send targets a device", () => {
  it("sends to the default device and reports its label", async () => {
    const sent: Array<{ raw: string; tags: Record<string, string> }> = [];
    const { store } = storeStub(TWO);
    const res = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({
      store, sender: { send: async (raw, tags) => { sent.push({ raw, tags }); return { messageId: "m1" }; } },
    })));
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ sentTo: "b@kindle.com", format: "epub", deviceId: "bbbbbbbb", deviceLabel: "Phone" });
    expect(sent[0].tags.deviceId).toBe("bbbbbbbb");
    expect(sent[0].raw).toContain("To: b@kindle.com");
  });

  it("sends to an explicitly chosen device", async () => {
    const sent: Array<{ tags: Record<string, string> }> = [];
    const { store } = storeStub(TWO);
    const res = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1", deviceId: "aaaaaaaa" }), deps({
      store, sender: { send: async (_r, tags) => { sent.push({ tags }); return { messageId: "m1" }; } },
    })));
    expect(res.json).toMatchObject({ sentTo: "a@kindle.com", deviceId: "aaaaaaaa", deviceLabel: "Scribe" });
    expect(sent[0].tags.deviceId).toBe("aaaaaaaa");
  });

  it("rejects a device the user no longer has", async () => {
    const { store } = storeStub(TWO);
    const res = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1", deviceId: "gone" }), deps({ store })));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "unknown_device", message: "That device is no longer saved — reload and try again" });
  });

  it("409s with no devices saved", async () => {
    const { store } = storeStub({ devices: [], defaultDeviceId: null });
    const res = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store })));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "no_address" });
  });

  it("reports an empty label for an unnamed migrated device", async () => {
    const legacy: DeviceList = { devices: [{ id: "abcd1234", label: "", address: "me_x@kindle.com", addedAt: "" }], defaultDeviceId: "abcd1234" };
    const { store } = storeStub(legacy);
    const res = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store })));
    expect(res.json).toMatchObject({ sentTo: "me_x@kindle.com", deviceLabel: "" });
  });
});

describe("tagValue", () => {
  it("hex-encodes so the value fits SES's [A-Za-z0-9_-] tag charset", () => {
    expect(tagValue("jay@example.com")).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(tagValue("jay@example.com"), "hex").toString()).toBe("jay@example.com");
  });
});
