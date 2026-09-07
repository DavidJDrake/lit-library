import { describe, expect, it, vi } from "vitest";
import { getKindleDevices, KindleError, saveKindleDevices, sendToKindle } from "./api";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

describe("getKindleDevices", () => {
  it("returns the list and the default", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" })) as unknown as typeof fetch;
    expect(await getKindleDevices("/api", "tok", fetchFn)).toEqual({ devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1", version: null });
  });
  it("tolerates a malformed body", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: 1 }, { id: "a1", label: "S", address: "a@kindle.com" }] })) as unknown as typeof fetch;
    expect(await getKindleDevices("/api", "tok", fetchFn)).toEqual({ devices: [{ id: "a1", label: "S", address: "a@kindle.com" }], defaultDeviceId: null, version: null });
  });
  it("carries the server's version back to the caller", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [], defaultDeviceId: null, version: "2026-09-06T12:00:00.000Z" })) as unknown as typeof fetch;
    expect((await getKindleDevices("/api", "tok", fetchFn)).version).toBe("2026-09-06T12:00:00.000Z");
  });
});

describe("saveKindleDevices", () => {
  it("PUTs the list and returns the canonical response", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" }); }) as unknown as typeof fetch;
    const out = await saveKindleDevices("/api", "tok", [{ label: "Scribe", address: "a@kindle.com" }], "a1", undefined, fetchFn);
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(String(calls[0].body))).toEqual({ devices: [{ label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" });
    expect(out.devices[0].id).toBe("a1");
  });
  it("omits the default when none is given", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(200, { devices: [], defaultDeviceId: null }); }) as unknown as typeof fetch;
    await saveKindleDevices("/api", "tok", [], undefined, undefined, fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ devices: [] });
  });
  it("sends the version it was given, including an explicit null", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(200, { devices: [], defaultDeviceId: null, version: null }); }) as unknown as typeof fetch;
    await saveKindleDevices("/api", "tok", [], undefined, "v1", fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ devices: [], version: "v1" });
    await saveKindleDevices("/api", "tok", [], undefined, null, fetchFn);
    expect(JSON.parse(String(calls[1].body))).toEqual({ devices: [], version: null });
  });
  it("throws a typed stale error when another tab has written", async () => {
    const fetchFn = vi.fn(async () => json(409, { error: "stale", message: "Your devices changed in another tab — reload and try again" })) as unknown as typeof fetch;
    await expect(saveKindleDevices("/api", "tok", [], undefined, "v1", fetchFn)).rejects.toMatchObject({
      name: "KindleError", code: "stale", message: "Your devices changed in another tab — reload and try again",
    });
  });
  it("throws a typed error carrying the server message", async () => {
    const fetchFn = vi.fn(async () => json(400, { error: "bad_label", message: "You already have a device with that name" })) as unknown as typeof fetch;
    await expect(saveKindleDevices("/api", "tok", [], undefined, undefined, fetchFn)).rejects.toMatchObject({
      name: "KindleError", code: "bad_label", message: "You already have a device with that name",
    });
  });
});

describe("sendToKindle", () => {
  it("posts the device id and returns the label", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(202, { sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "Scribe" }); }) as unknown as typeof fetch;
    const out = await sendToKindle("/api", "tok", "b1", "epub", "a1", fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ bookId: "b1", format: "epub", deviceId: "a1" });
    expect(out).toEqual({ sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "Scribe" });
  });
  it("omits an absent format and device", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(202, { sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "" }); }) as unknown as typeof fetch;
    await sendToKindle("/api", "tok", "b1", undefined, undefined, fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ bookId: "b1" });
  });
  it("maps 409, 400 unknown_device and 413 to codes", async () => {
    const mk = (status: number, body: unknown) => (vi.fn(async () => json(status, body)) as unknown as typeof fetch);
    await expect(sendToKindle("/api", "t", "b", undefined, undefined, mk(409, { error: "no_address" }))).rejects.toMatchObject({ code: "no_address" });
    await expect(sendToKindle("/api", "t", "b", undefined, "x", mk(400, { error: "unknown_device", message: "gone" }))).rejects.toMatchObject({ code: "unknown_device", message: "gone" });
    await expect(sendToKindle("/api", "t", "b", undefined, undefined, mk(413, { error: "too_large", message: "big", bytes: 9, limit: 8 }))).rejects.toMatchObject({ code: "too_large", details: { bytes: 9, limit: 8 } });
  });
  it("downgrades an unrecognised error code to failed, keeping the server's message", async () => {
    const fetchFn = vi.fn(async () => json(500, { error: "internal", message: "boom" })) as unknown as typeof fetch;
    await expect(sendToKindle("/api", "t", "b", undefined, undefined, fetchFn)).rejects.toMatchObject({ code: "failed", message: "boom" });
  });
});
