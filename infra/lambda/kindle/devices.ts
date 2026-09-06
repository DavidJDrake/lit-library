import { createHash, randomBytes } from "node:crypto";
import { KINDLE_ADDRESS_RE } from "./lib";

export interface KindleDevice { id: string; label: string; address: string; addedAt: string }
export interface DeviceList { devices: KindleDevice[]; defaultDeviceId: string | null }
export interface PublicDevice { id: string; label: string; address: string }

export const MAX_DEVICES = 5;
export const MAX_LABEL = 30;

export type DeviceErrorCode = "bad_label" | "bad_address" | "too_many" | "bad_default" | "unknown_device";
export type ValidateResult = { ok: true; list: DeviceList } | { ok: false; error: DeviceErrorCode; message: string };

const MESSAGES = {
  bad_label: "Give the device a name of 30 characters or fewer",
  dup_label: "You already have a device with that name",
  bad_address: "Enter your @kindle.com address",
  dup_address: "That address is already saved",
  too_many: "You can save up to 5 devices",
  bad_default: "Choose one of your devices as the default",
  unknown_device: "That device is no longer saved — reload and try again",
} as const;

const fail = (error: DeviceErrorCode, message: string): ValidateResult => ({ ok: false, error, message });

/** SES tag values allow [A-Za-z0-9_-]; hex keeps ids usable as a tag without encoding. */
export const newDeviceId = (): string => randomBytes(4).toString("hex");

/** Stable id for a migrated legacy address, so reading twice without a write agrees. */
export const derivedDeviceId = (address: string): string =>
  createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 8);

function isStoredDevice(v: unknown): v is KindleDevice {
  const d = v as Partial<KindleDevice> | null;
  return !!d && typeof d.id === "string" && typeof d.label === "string"
    && typeof d.address === "string" && typeof d.addedAt === "string";
}

export function readDevices(item: Record<string, unknown> | undefined): DeviceList {
  const raw = item?.devices;
  if (Array.isArray(raw)) {
    const devices = raw.filter(isStoredDevice);
    if (devices.length === 0) return { devices: [], defaultDeviceId: null };
    const stored = item?.defaultDeviceId;
    const def = typeof stored === "string" && devices.some((d) => d.id === stored) ? stored : devices[0].id;
    return { devices, defaultDeviceId: def };
  }
  const legacy = item?.kindleAddress;
  if (typeof legacy === "string" && legacy.trim()) {
    const address = legacy.trim().toLowerCase();
    const id = derivedDeviceId(address);
    const addedAt = typeof item?.updatedAt === "string" ? item.updatedAt : "";
    return { devices: [{ id, label: "", address, addedAt }], defaultDeviceId: id };
  }
  return { devices: [], defaultDeviceId: null };
}

export const publicList = (list: DeviceList) => ({
  devices: list.devices.map(({ id, label, address }) => ({ id, label, address })),
  defaultDeviceId: list.defaultDeviceId,
});

export function validateDevices(input: unknown, requestedDefault: unknown, existing: DeviceList, now: string): ValidateResult {
  if (!Array.isArray(input)) return fail("bad_label", MESSAGES.bad_label);
  if (input.length > MAX_DEVICES) return fail("too_many", MESSAGES.too_many);

  const byId = new Map(existing.devices.map((d) => [d.id, d]));
  const devices: KindleDevice[] = [];
  const labels = new Set<string>();
  const addresses = new Set<string>();

  for (const raw of input) {
    const entry = (raw ?? {}) as { id?: unknown; label?: unknown; address?: unknown };

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label || label.length > MAX_LABEL) return fail("bad_label", MESSAGES.bad_label);
    if (labels.has(label.toLowerCase())) return fail("bad_label", MESSAGES.dup_label);
    labels.add(label.toLowerCase());

    const address = typeof entry.address === "string" ? entry.address.trim().toLowerCase() : "";
    if (!KINDLE_ADDRESS_RE.test(address)) return fail("bad_address", MESSAGES.bad_address);
    if (addresses.has(address)) return fail("bad_address", MESSAGES.dup_address);
    addresses.add(address);

    if (typeof entry.id === "string" && entry.id) {
      const known = byId.get(entry.id);
      if (!known) return fail("unknown_device", MESSAGES.unknown_device);
      devices.push({ id: known.id, label, address, addedAt: known.addedAt });
    } else {
      devices.push({ id: newDeviceId(), label, address, addedAt: now });
    }
  }

  if (devices.length === 0) return { ok: true, list: { devices: [], defaultDeviceId: null } };
  // A single device is always its own default, whatever the client asked for.
  if (devices.length === 1) return { ok: true, list: { devices, defaultDeviceId: devices[0].id } };

  if (typeof requestedDefault === "string" && requestedDefault) {
    if (!devices.some((d) => d.id === requestedDefault)) return fail("bad_default", MESSAGES.bad_default);
    return { ok: true, list: { devices, defaultDeviceId: requestedDefault } };
  }
  const kept = existing.defaultDeviceId && devices.some((d) => d.id === existing.defaultDeviceId)
    ? existing.defaultDeviceId : devices[0].id;
  return { ok: true, list: { devices, defaultDeviceId: kept } };
}
