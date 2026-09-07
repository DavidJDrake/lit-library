import { apiCall } from "../catalog/apiCall";

export interface OpdsTokenStatus { exists: boolean; createdAt: string | null }
export interface GeneratedOpdsToken { token: string; createdAt: string }

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return ((await res.json()) as Record<string, unknown>) ?? {}; } catch { return {}; }
}

export async function getOpdsTokenStatus(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<OpdsTokenStatus> {
  const res = await apiCall(apiUrl, idToken, "/opds/token", { method: "GET" }, 200, fetchFn);
  const body = await readJson(res);
  return { exists: body.exists === true, createdAt: typeof body.createdAt === "string" ? body.createdAt : null };
}

// The plaintext token is returned exactly once, here — the caller must show it
// immediately and never ask for it again; the server never sends it a second time.
export async function generateOpdsToken(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<GeneratedOpdsToken> {
  const res = await apiCall(apiUrl, idToken, "/opds/token", { method: "POST" }, 201, fetchFn);
  const body = await readJson(res);
  if (typeof body.token !== "string" || !body.token || typeof body.createdAt !== "string") {
    throw new Error("Could not generate a feed link");
  }
  return { token: body.token, createdAt: body.createdAt };
}

export async function revokeOpdsToken(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/opds/token", { method: "DELETE" }, 204, fetchFn);
}
