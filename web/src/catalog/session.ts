// CloudFront signed cookies gate /catalog.json and /covers/*. The session
// endpoint sets them (same-origin, HttpOnly) for 2 hours; the app renews them
// silently while signed in (see Library.tsx's SESSION_RENEW_MS).
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

// Unauthenticated: it only clears cookies, so this works even when the ID
// token is expired or otherwise unavailable (e.g. sign-out after the
// refresh token has died).
export async function endSession(apiUrl: string, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    await fetchFn(`${apiUrl}/session`, { method: "DELETE", credentials: "same-origin" });
  } catch {
    // best-effort: cookies also expire on their own within SESSION_SECONDS
  }
}
