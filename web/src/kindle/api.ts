import { apiCall } from "../catalog/apiCall";

export type KindleErrorCode = "no_address" | "too_large" | "unsupported" | "not_enabled" | "failed";

export class KindleError extends Error {
  constructor(public readonly code: KindleErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "KindleError";
  }
}

export async function getKindleAddress(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const res = await apiCall(apiUrl, idToken, "/kindle/address", { method: "GET" }, 200, fetchFn);
  const body = (await res.json()) as { kindleAddress?: unknown };
  return typeof body?.kindleAddress === "string" && body.kindleAddress ? body.kindleAddress : null;
}

export async function saveKindleAddress(apiUrl: string, idToken: string, address: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/kindle/address", { method: "PUT", body: JSON.stringify({ kindleAddress: address }) }, 204, fetchFn);
}

export async function sendToKindle(
  apiUrl: string, idToken: string, bookId: string, format?: string, fetchFn: typeof fetch = fetch,
): Promise<{ sentTo: string; format: string }> {
  const res = await fetchFn(`${apiUrl}/kindle/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(format ? { bookId, format } : { bookId }),
  });
  let body: { error?: string; message?: string; sentTo?: string; format?: string; bytes?: number; limit?: number } = {};
  try { body = (await res.json()) ?? {}; } catch { /* non-JSON */ }
  if (res.status === 202 && body.sentTo) return { sentTo: body.sentTo, format: body.format ?? "" };
  const message = body.message ?? body.error ?? `Send failed: ${res.status}`;
  if (res.status === 409) throw new KindleError("no_address", message);
  if (res.status === 413) throw new KindleError("too_large", message, { bytes: body.bytes, limit: body.limit });
  if (body.error === "unsupported") throw new KindleError("unsupported", message);
  if (body.error === "not_enabled") throw new KindleError("not_enabled", message);
  throw new KindleError("failed", message);
}
