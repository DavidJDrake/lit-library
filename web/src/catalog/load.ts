import type { Catalog } from "./types";

export async function loadCatalog(fetchFn: typeof fetch = fetch): Promise<Catalog> {
  const res = await fetchFn("/catalog.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Catalog request failed: ${res.status}`);

  const contentType = res.headers?.get?.("content-type") ?? "";
  let body: unknown;
  if (!contentType.includes("application/json")) {
    throw new Error("Catalog request returned non-JSON (is the site deployed?)");
  }
  try {
    body = await res.json();
  } catch {
    throw new Error("Catalog request returned non-JSON (is the site deployed?)");
  }

  if (typeof body !== "object" || body === null || !Array.isArray((body as { books?: unknown }).books)) {
    throw new Error("Catalog is malformed");
  }
  return body as Catalog;
}
