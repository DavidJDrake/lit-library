import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchOverlay, setBookReadingStatus, type Overlay } from "./library";
import { loadCatalog } from "./load";
import { establishSession } from "./session";
import type { Book, ReadingStatus } from "./types";

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
  /**
   * Optimistic: patches the overlay locally before the request lands, so the change reads
   * as instant. A failure reverts only this book's status — not a whole-overlay snapshot —
   * matching the notifications provider's per-item revert, since a second call for a
   * different (or the same) book may be in flight at the same time. `status` is null to
   * clear. Rejects (after reverting) so the caller can show its own error.
   */
  setReadingStatus(bookId: string, status: ReadingStatus | null): Promise<void>;
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

  // Lets the optimistic handler below read "current truth" synchronously without going
  // stale between renders (overlay itself isn't safe to close over in a callback that
  // isn't re-created every time it changes).
  const overlayRef = useRef(overlay);
  useEffect(() => { overlayRef.current = overlay; }, [overlay]);

  // One generation counter per book: if two setReadingStatus calls for the same book are
  // in flight and the older one fails after the newer one has already applied (optimistically
  // or for real), the older failure must not revert past the newer value. Only the call that
  // is still the latest for that book is allowed to revert.
  const statusGenRef = useRef<Record<string, number>>({});

  const patchStatus = useCallback((bookId: string, status: ReadingStatus | null) => {
    setOverlay((o) => {
      if (!o) return o;
      if (status === null) {
        return { ...o, readingStatuses: Object.fromEntries(Object.entries(o.readingStatuses).filter(([id]) => id !== bookId)) };
      }
      return { ...o, readingStatuses: { ...o.readingStatuses, [bookId]: status } };
    });
  }, []);

  const setReadingStatus = useCallback(async (bookId: string, status: ReadingStatus | null) => {
    const current = overlayRef.current;
    if (!current) throw new Error("Library overlay not loaded yet");
    const previousStatus = current.readingStatuses[bookId] ?? null;
    const gen = (statusGenRef.current[bookId] ?? 0) + 1;
    statusGenRef.current[bookId] = gen;
    patchStatus(bookId, status);
    try {
      await setBookReadingStatus(apiUrl, await getIdToken(), bookId, status, fetchFn);
    } catch (e) {
      // A newer call for this same book has since taken over; its outcome (still pending,
      // or already applied) must win over this stale failure.
      if (statusGenRef.current[bookId] === gen) patchStatus(bookId, previousStatus);
      throw e;
    }
  }, [apiUrl, getIdToken, fetchFn, patchStatus]);

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

  const value = useMemo<LibraryData>(() => ({ books, overlay, loadError, overlayError, refreshOverlay, titleOf, setReadingStatus }),
    [books, overlay, loadError, overlayError, refreshOverlay, titleOf, setReadingStatus]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibraryData(): LibraryData {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLibraryData must be used inside <LibraryDataProvider>");
  return ctx;
}
