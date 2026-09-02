export interface DownloadTicket { url: string; filename: string; expiresIn: number }

export async function requestDownload(
  apiUrl: string, idToken: string, bookId: string, format: string, fetchFn: typeof fetch = fetch,
): Promise<DownloadTicket> {
  const res = await fetchFn(`${apiUrl}/download`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, format }),
  });
  if (!res.ok) {
    let message = `Download failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  return (await res.json()) as DownloadTicket;
}

// The presigned URL carries Content-Disposition: attachment, so navigating to it
// downloads the file without leaving the page.
export function startDownload(url: string, navigate: (u: string) => void = (u) => window.location.assign(u)): void {
  navigate(url);
}
