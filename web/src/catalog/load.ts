import type { Catalog } from "./types";

export async function loadCatalog(fetchFn: typeof fetch = fetch): Promise<Catalog> {
  const res = await fetchFn("/catalog.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Catalog request failed: ${res.status}`);
  return (await res.json()) as Catalog;
}
