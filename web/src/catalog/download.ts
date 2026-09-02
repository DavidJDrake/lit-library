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

const IFRAME_LIFETIME_MS = 60_000;

// The presigned URL carries Content-Disposition: attachment. Rather than navigating
// the top window (which would leave the page for some browsers/formats), load it in
// a hidden iframe so the download starts without disrupting the current view.
function iframeDownload(url: string): void {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), IFRAME_LIFETIME_MS);
}

export function startDownload(url: string, navigate: (u: string) => void = iframeDownload): void {
  navigate(url);
}
