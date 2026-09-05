import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchOverlay, type Overlay } from "./library";
import { loadCatalog } from "./load";
import { establishSession } from "./session";
import type { Book } from "./types";

// The session cookie lasts 2h (SESSION_SECONDS); renew well within that
// window so a long-open tab never hits the stale-cookie fallback.
export const SESSION_RENEW_MS = 90 * 60 * 1000;

export interface LibraryData {
  books: Book[] | null;
  overlay: Overlay | null;
  loadError?: string;
  overlayError?: string;
  refreshOverlay(): Promise<void>;
  titleOf(bookId: string): string | undefined;
}

const Ctx = createContext<LibraryData | undefined>(undefined);

interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; children: ReactNode }

// Owns everything that has to be loaded once per signed-in session: the CloudFront
// session cookie, catalog.json, and the category overlay. Library renders from it;
// the notification bell resolves book titles through it.
export function LibraryDataProvider({ apiUrl, getIdToken, fetchFn = fetch, children }: Props) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [overlayError, setOverlayError] = useState<string>();

  const refreshOverlay = useCallback(async () => {
    setOverlay(await fetchOverlay(apiUrl, await getIdToken(), fetchFn));
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await establishSession(apiUrl, await getIdToken(), fetchFn);
        let catalog;
        try {
          catalog = await loadCatalog(fetchFn);
        } catch {
          // A stale/missing cookie makes CloudFront serve index.html instead; refresh once and retry.
          await establishSession(apiUrl, await getIdToken(), fetchFn);
          catalog = await loadCatalog(fetchFn);
        }
        if (!cancelled) setBooks(catalog.books);
        try {
          const o = await fetchOverlay(apiUrl, await getIdToken(), fetchFn);
          if (!cancelled) setOverlay(o);
        } catch (e) {
          // A broken library Lambda must not take the site down: consumers render read-only.
          if (!cancelled) setOverlayError((e as Error).message);
        }
      } catch (e) {
        if (!cancelled) setLoadError(`Could not load the catalog (${(e as Error).message}). Try reloading the page.`);
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => {
    const renew = () => {
      void getIdToken().then((t) => establishSession(apiUrl, t, fetchFn)).catch(() => { /* the next tick retries; a failed request during browsing re-establishes on demand */ });
    };
    const id = setInterval(renew, SESSION_RENEW_MS);
    // A tab left backgrounded past the renewal interval (throttled timers,
    // sleeping device) can come back with an expired cookie before the next
    // tick fires; catch up as soon as it's visible again.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") renew();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [apiUrl, getIdToken, fetchFn]);

  const titles = useMemo(() => new Map((books ?? []).map((b) => [b.id, b.title])), [books]);
  const titleOf = useCallback((id: string) => titles.get(id), [titles]);

  const value = useMemo<LibraryData>(() => ({ books, overlay, loadError, overlayError, refreshOverlay, titleOf }),
    [books, overlay, loadError, overlayError, refreshOverlay, titleOf]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibraryData(): LibraryData {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLibraryData must be used inside <LibraryDataProvider>");
  return ctx;
}
