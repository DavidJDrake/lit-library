async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (body?.message) return body.message;
    if (body?.error) return body.error;
  } catch {
    // non-JSON error body — keep the fallback
  }
  return fallback;
}

// Same-origin call to the library API. The SPA fallback answers unknown paths with
// 200 HTML, so callers state the exact status they expect.
export async function apiCall(
  apiUrl: string, idToken: string, path: string, init: RequestInit, expectStatus: number, fetchFn: typeof fetch,
): Promise<Response> {
  const res = await fetchFn(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status !== expectStatus) throw new Error(await errorMessage(res, `Request failed: expected ${expectStatus}, got ${res.status}`));
  return res;
}
