import { describe, expect, it } from "vitest";
import { derivedDeviceId, newDeviceId, publicList, readDevices, validateDevices, type DeviceList } from "../lambda/kindle/devices";

const NOW = "2026-09-06T12:00:00.000Z";
const empty: DeviceList = { devices: [], defaultDeviceId: null };
const one: DeviceList = {
  devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW }],
  defaultDeviceId: "aaaaaaaa",
};
const two: DeviceList = {
  devices: [
    { id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW },
    { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com", addedAt: NOW },
  ],
  defaultDeviceId: "bbbbbbbb",
};

describe("ids", () => {
  it("generates 8 hex characters, distinct per call", () => {
    const a = newDeviceId(), b = newDeviceId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
  it("derives a stable id from an address, case-insensitively", () => {
    expect(derivedDeviceId("Me_X@Kindle.com")).toBe(derivedDeviceId("me_x@kindle.com"));
    expect(derivedDeviceId("me_x@kindle.com")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("readDevices", () => {
  it("reads a stored device list and keeps a valid default", () => {
    expect(readDevices({ devices: two.devices, defaultDeviceId: "bbbbbbbb" })).toEqual(two);
  });
  it("falls back to the first device when the stored default is missing", () => {
    expect(readDevices({ devices: two.devices, defaultDeviceId: "gone" }).defaultDeviceId).toBe("aaaaaaaa");
  });
  it("migrates a legacy single address to one unnamed default device", () => {
    const list = readDevices({ kindleAddress: "Me_X@Kindle.com", updatedAt: NOW });
    expect(list.devices).toEqual([{ id: derivedDeviceId("me_x@kindle.com"), label: "", address: "me_x@kindle.com", addedAt: NOW }]);
    expect(list.defaultDeviceId).toBe(derivedDeviceId("me_x@kindle.com"));
  });
  it("reads a missing row, an empty row, and a malformed entry as an empty list", () => {
    expect(readDevices(undefined)).toEqual(empty);
    expect(readDevices({})).toEqual(empty);
    expect(readDevices({ devices: [{ id: 1, label: "x" }] })).toEqual(empty);
  });
});

describe("publicList", () => {
  it("drops addedAt", () => {
    expect(publicList(one)).toEqual({ devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "aaaaaaaa" });
  });
});

describe("validateDevices", () => {
  const ok = (r: ReturnType<typeof validateDevices>) => { if (!r.ok) throw new Error(`expected ok, got ${r.error}`); return r.list; };

  it("assigns an id and addedAt to a new device and makes a lone device the default", () => {
    const list = ok(validateDevices([{ label: " Scribe ", address: "A@Kindle.com" }], "ignored", empty, NOW));
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(list.devices[0]).toMatchObject({ label: "Scribe", address: "a@kindle.com", addedAt: NOW });
    expect(list.defaultDeviceId).toBe(list.devices[0].id);
  });
  it("keeps the id and addedAt of an existing device and renames it", () => {
    const list = ok(validateDevices([{ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com" }], undefined, one, "2026-10-01T00:00:00.000Z"));
    expect(list.devices[0]).toEqual({ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com", addedAt: NOW });
  });
  it("accepts a legacy migrated id as existing", () => {
    const legacy = readDevices({ kindleAddress: "me_x@kindle.com", updatedAt: NOW });
    const list = ok(validateDevices([{ id: legacy.devices[0].id, label: "Scribe", address: "me_x@kindle.com" }], undefined, legacy, NOW));
    expect(list.devices[0].id).toBe(legacy.devices[0].id);
  });
  it("honours an explicit default and keeps the existing default when none is sent", () => {
    expect(ok(validateDevices(two.devices, "aaaaaaaa", two, NOW)).defaultDeviceId).toBe("aaaaaaaa");
    expect(ok(validateDevices(two.devices, undefined, two, NOW)).defaultDeviceId).toBe("bbbbbbbb");
  });
  it("falls back to the first device when the kept default was removed", () => {
    const list = ok(validateDevices([two.devices[0]], undefined, two, NOW));
    expect(list.defaultDeviceId).toBe("aaaaaaaa");
  });
  it("accepts an empty list and clears the default", () => {
    expect(ok(validateDevices([], undefined, two, NOW))).toEqual(empty);
  });

  it.each([
    ["missing label", [{ address: "a@kindle.com" }], "bad_label", "Give the device a name of 30 characters or fewer"],
    ["blank label", [{ label: "   ", address: "a@kindle.com" }], "bad_label", "Give the device a name of 30 characters or fewer"],
    ["long label", [{ label: "x".repeat(31), address: "a@kindle.com" }], "bad_label", "Give the device a name of 30 characters or fewer"],
    ["duplicate label", [{ label: "Scribe", address: "a@kindle.com" }, { label: "scribe", address: "b@kindle.com" }], "bad_label", "You already have a device with that name"],
    ["bad address", [{ label: "Scribe", address: "a@example.com" }], "bad_address", "Enter your @kindle.com address"],
    ["duplicate address", [{ label: "One", address: "a@kindle.com" }, { label: "Two", address: "A@kindle.com" }], "bad_address", "That address is already saved"],
  ])("rejects %s", (_name, devices, error, message) => {
    const r = validateDevices(devices, undefined, empty, NOW);
    expect(r).toMatchObject({ ok: false, error, message });
  });

  it("rejects more than five devices", () => {
    const many = Array.from({ length: 6 }, (_v, i) => ({ label: `D${i}`, address: `d${i}@kindle.com` }));
    expect(validateDevices(many, undefined, empty, NOW)).toMatchObject({ ok: false, error: "too_many", message: "You can save up to 5 devices" });
  });
  it("rejects a default that names no device in the list", () => {
    expect(validateDevices(two.devices, "gone", two, NOW)).toMatchObject({ ok: false, error: "bad_default", message: "Choose one of your devices as the default" });
  });
  it("rejects an id the user does not have", () => {
    expect(validateDevices([{ id: "cccccccc", label: "Ghost", address: "c@kindle.com" }], undefined, two, NOW))
      .toMatchObject({ ok: false, error: "unknown_device", message: "That device is no longer saved — reload and try again" });
  });
  it("rejects a non-array input", () => {
    expect(validateDevices("nope", undefined, empty, NOW)).toMatchObject({ ok: false, error: "bad_label" });
  });
});
