import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  applyOverlay, createCategory, fetchOverlay, resolveSuggestion, setBookCategory, suggestCategory, type Overlay,
} from "../catalog/library";
import { requestDownload, startDownload } from "../catalog/download";
import { loadCatalog } from "../catalog/load";
import { establishSession } from "../catalog/session";
import { applyFilters, buildSearchIndex, facetCounts, searchBooks, sortBooks } from "../catalog/search";
import { emptyFilters, FACET_KEYS, type Book, type FacetKey, type Filters, type SortKey } from "../catalog/types";
import BookCard from "./BookCard";
import BookDetail from "./BookDetail";
import CategorySuggestions from "./CategorySuggestions";
import FacetGroup from "./FacetGroup";
import Toast from "./Toast";

interface Props {
  apiUrl: string;
  getIdToken: () => Promise<string>;
  fetchFn?: typeof fetch;
  navigate?: (url: string) => void;
  isAdmin?: boolean;
}

const FACET_TITLES: Record<FacetKey, string> = {
  category: "Category", format: "Format", publisher: "Publisher", bundle: "Bundle", author: "Author", year: "Year",
};

// The session cookie lasts 2h (SESSION_SECONDS); renew well within that
// window so a long-open tab never hits the stale-cookie fallback.
export const SESSION_RENEW_MS = 90 * 60 * 1000;

export default function Library({ apiUrl, getIdToken, fetchFn = fetch, navigate, isAdmin = false }: Props) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [sort, setSort] = useState<SortKey>("added");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toast, setToast] = useState<string>();

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
          // A broken library Lambda must not take the site down: render read-only.
          if (!cancelled) setToast(`Category editing is unavailable right now (${(e as Error).message})`);
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

  const merged = useMemo(() => (books && overlay ? applyOverlay(books, overlay) : books), [books, overlay]);
  const categoryNames = useMemo(() => overlay?.categories.map((c) => c.name) ?? [], [overlay]);
  const selected = useMemo(() => merged?.find((b) => b.id === selectedId) ?? null, [merged, selectedId]);

  const deferredQuery = useDeferredValue(query);

  const facets = useMemo(
    () => Object.fromEntries(
      FACET_KEYS.map((k) => {
        const counts = merged ? facetCounts(applyFilters(merged, { ...filters, [k]: new Set<string>() }), k) : [];
        // A value the user has selected can drop out of the computed counts entirely
        // (e.g. the last book in that category was just moved elsewhere). Keep its
        // checkbox visible at count 0 rather than stranding a checked-but-invisible filter.
        const missing = [...filters[k]].filter((v) => !counts.some((c) => c.value === v));
        return [k, missing.length === 0 ? counts : [...counts, ...missing.map((value) => ({ value, count: 0 }))]];
      }),
    ) as Record<FacetKey, Array<{ value: string; count: number }>>,
    [merged, filters],
  );
  const filtered = useMemo(() => (merged ? applyFilters(merged, filters) : []), [merged, filters]);
  const index = useMemo(() => buildSearchIndex(filtered), [filtered]);
  const searched = useMemo(() => searchBooks(filtered, deferredQuery, index), [filtered, deferredQuery, index]);
  const visible = useMemo(
    () => (deferredQuery.trim() ? searched : sortBooks(searched, sort)),
    [searched, deferredQuery, sort],
  );

  const toggle = useCallback((key: FacetKey, value: string) => {
    setFilters((f) => {
      const next = new Set(f[key]);
      next.has(value) ? next.delete(value) : next.add(value);
      return { ...f, [key]: next };
    });
  }, []);

  const download = useCallback(async (book: Book, format: string) => {
    try {
      const token = await getIdToken();
      const ticket = await requestDownload(apiUrl, token, book.id, format, fetchFn);
      startDownload(ticket.url, navigate);
    } catch (e) {
      setToast((e as Error).message);
    }
  }, [apiUrl, getIdToken, fetchFn, navigate]);

  // Every mutation re-fetches the overlay rather than patching local state: one
  // code path, and the server's view always wins (which is also the "revert" on failure).
  const mutate = useCallback(async (run: (token: string) => Promise<void>, success: string) => {
    try {
      await run(await getIdToken());
    } catch (e) {
      setToast((e as Error).message);
      return;
    }
    setToast(success);
    try {
      await refreshOverlay();
    } catch (e) {
      setToast(`Saved, but the list could not refresh (${(e as Error).message})`);
    }
  }, [getIdToken, refreshOverlay]);

  const changeCategory = useCallback((book: Book, category: string) =>
    mutate((t) => setBookCategory(apiUrl, t, book.id, category, fetchFn), `Moved to ${category}`), [mutate, apiUrl, fetchFn]);
  const suggest = useCallback((name: string, bookId?: string) =>
    mutate((t) => suggestCategory(apiUrl, t, name, bookId, fetchFn), `Suggested '${name}' — waiting for approval`), [mutate, apiUrl, fetchFn]);
  const addCategory = useCallback((name: string) =>
    mutate((t) => createCategory(apiUrl, t, name, fetchFn), `Added category '${name}'`), [mutate, apiUrl, fetchFn]);
  const resolve = useCallback((id: string, action: "accept" | "reject") => {
    const name = overlay?.suggestions.find((s) => s.id === id)?.name ?? "suggestion";
    return mutate((t) => resolveSuggestion(apiUrl, t, id, action, fetchFn), `${action === "accept" ? "Accepted" : "Rejected"} '${name}'`);
  }, [mutate, apiUrl, fetchFn, overlay]);

  const dismissToast = useCallback(() => setToast(undefined), []);

  if (loadError) return <div className="error" role="alert" style={{ margin: "2rem" }}>{loadError}</div>;
  if (!books) return <p className="empty">Loading the library…</p>;

  return (
    <div className="library">
      <aside className="sidebar">
        {FACET_KEYS.map((key) => (
          <FacetGroup key={key} title={FACET_TITLES[key]} options={facets[key]}
            selected={filters[key]} onToggle={(v) => toggle(key, v)}
            footer={key === "category" && overlay ? (
              <CategorySuggestions suggestions={overlay.suggestions} isAdmin={isAdmin}
                onSuggest={(name) => suggest(name)} onCreate={addCategory} onResolve={resolve} />
            ) : undefined} />
        ))}
      </aside>
      <section>
        <div className="toolbar">
          <input type="search" placeholder="Search titles, authors, descriptions…" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
          <select value={query.trim() ? "relevance" : sort} onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort by" disabled={query.trim().length > 0}>
            <option value="relevance">Relevance</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="year">Year (newest)</option>
            <option value="added">Recently added</option>
          </select>
          <span className="count">{visible.length} {visible.length === 1 ? "book" : "books"}</span>
        </div>
        {visible.length === 0 ? <p className="empty">No books match.</p> : (
          <div className="grid">
            {visible.map((b) => <BookCard key={b.id} book={b} onOpen={(b) => setSelectedId(b.id)} />)}
          </div>
        )}
      </section>
      <BookDetail book={selected} onClose={() => setSelectedId(null)} onDownload={download}
        categories={categoryNames} onChangeCategory={changeCategory} onSuggest={(name, bookId) => suggest(name, bookId)} />
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}
