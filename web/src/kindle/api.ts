import { apiCall } from "../catalog/apiCall";

export interface KindleDevice { id: string; label: string; address: string }
export interface DeviceInput { id?: string; label: string; address: string }
/** `version` is the server's opaque row stamp; null when there is no stored row. */
export interface DeviceListDto { devices: KindleDevice[]; defaultDeviceId: string | null; version: string | null }

export type KindleErrorCode =
  | "no_address" | "too_large" | "unsupported" | "not_enabled" | "failed"
  | "unknown_device" | "bad_request" | "bad_label" | "bad_address" | "too_many" | "bad_default" | "stale";

const CODES = new Set<string>([
  "no_address", "too_large", "unsupported", "not_enabled", "failed",
  "unknown_device", "bad_request", "bad_label", "bad_address", "too_many", "bad_default", "stale",
]);

export class KindleError extends Error {
  constructor(public readonly code: KindleErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "KindleError";
  }
}

interface ErrorBody { error?: string; message?: string; bytes?: number; limit?: number }

const codeOf = (body: ErrorBody): KindleErrorCode =>
  (typeof body.error === "string" && CODES.has(body.error) ? body.error : "failed") as KindleErrorCode;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return ((await res.json()) as Record<string, unknown>) ?? {}; } catch { return {}; }
}

function toDevice(v: unknown): KindleDevice | undefined {
  const d = v as Partial<KindleDevice> | null;
  return d && typeof d.id === "string" && typeof d.label === "string" && typeof d.address === "string"
    ? { id: d.id, label: d.label, address: d.address } : undefined;
}

function toList(body: Record<string, unknown>): DeviceListDto {
  const devices = Array.isArray(body.devices) ? body.devices.map(toDevice).filter((d): d is KindleDevice => !!d) : [];
  const def = typeof body.defaultDeviceId === "string" && devices.some((d) => d.id === body.defaultDeviceId)
    ? body.defaultDeviceId : null;
  return { devices, defaultDeviceId: def, version: typeof body.version === "string" ? body.version : null };
}

export async function getKindleDevices(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<DeviceListDto> {
  const res = await apiCall(apiUrl, idToken, "/kindle/devices", { method: "GET" }, 200, fetchFn);
  return toList(await readJson(res));
}

/**
 * `version` is the one the caller last read. Sending it makes the write conditional, so a
 * second tab is told its list is `stale` rather than silently dropping a device it never
 * saw. Passing `undefined` omits the field, and the server writes unconditionally.
 */
export async function saveKindleDevices(
  apiUrl: string, idToken: string, devices: DeviceInput[], defaultDeviceId?: string,
  version?: string | null, fetchFn: typeof fetch = fetch,
): Promise<DeviceListDto> {
  const res = await fetchFn(`${apiUrl}/kindle/devices`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      devices,
      ...(defaultDeviceId ? { defaultDeviceId } : {}),
      ...(version === undefined ? {} : { version }),
    }),
  });
  const body = await readJson(res);
  if (res.status === 200) return toList(body);
  const err = body as ErrorBody;
  throw new KindleError(codeOf(err), err.message ?? err.error ?? `Save failed: ${res.status}`);
}

export async function sendToKindle(
  apiUrl: string, idToken: string, bookId: string, format?: string, deviceId?: string, fetchFn: typeof fetch = fetch,
): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }> {
  const res = await fetchFn(`${apiUrl}/kindle/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, ...(format ? { format } : {}), ...(deviceId ? { deviceId } : {}) }),
  });
  const body = await readJson(res);
  if (res.status === 202 && typeof body.sentTo === "string") {
    return {
      sentTo: body.sentTo,
      format: typeof body.format === "string" ? body.format : "",
      deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : "",
    };
  }
  const err = body as ErrorBody;
  const message = err.message ?? err.error ?? `Send failed: ${res.status}`;
  if (res.status === 409) throw new KindleError("no_address", message);
  if (res.status === 413) throw new KindleError("too_large", message, { bytes: err.bytes, limit: err.limit });
  throw new KindleError(codeOf(err), message);
}
