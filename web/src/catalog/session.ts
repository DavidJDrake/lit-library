// CloudFront signed cookies gate /catalog.json and /covers/*. The session
// endpoint sets them (same-origin, HttpOnly) for 12 hours.
export async function establishSession(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`${apiUrl}/session`, {
    method: "GET",
    headers: { Authorization: `Bearer ${idToken}` },
    credentials: "same-origin",
  });
  // The SPA fallback returns 200 HTML for auth/deploy problems (unknown API
  // paths resolve to index.html), so only a real 204 counts as success.
  if (res.status !== 204) throw new Error(`Could not start a session: ${res.status}`);
}

export async function endSession(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    await fetchFn(`${apiUrl}/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
      credentials: "same-origin",
    });
  } catch {
    // best-effort: the cookies expire on their own within 12 hours
  }
}
