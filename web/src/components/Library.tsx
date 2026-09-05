import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { requestDownload, startDownload } from "../catalog/download";
import { loadCatalog } from "../catalog/load";
import { establishSession } from "../catalog/session";
import { applyFilters, buildSearchIndex, facetCounts, searchBooks, sortBooks } from "../catalog/search";
import { emptyFilters, FACET_KEYS, type Book, type FacetKey, type Filters, type SortKey } from "../catalog/types";
import BookCard from "./BookCard";
import BookDetail from "./BookDetail";
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
  const [selected, setSelected] = useState<Book | null>(null);
  const [toast, setToast] = useState<string>();

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

  const deferredQuery = useDeferredValue(query);

  const facets = useMemo(
    () => Object.fromEntries(
      FACET_KEYS.map((k) => [
        k,
        books ? facetCounts(applyFilters(books, { ...filters, [k]: new Set<string>() }), k) : [],
      ]),
    ) as Record<FacetKey, Array<{ value: string; count: number }>>,
    [books, filters],
  );
  const filtered = useMemo(() => (books ? applyFilters(books, filters) : []), [books, filters]);
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

  const dismissToast = useCallback(() => setToast(undefined), []);

  if (loadError) return <div className="error" role="alert" style={{ margin: "2rem" }}>{loadError}</div>;
  if (!books) return <p className="empty">Loading the library…</p>;

  return (
    <div className="library">
      <aside className="sidebar">
        {FACET_KEYS.map((key) => (
          <FacetGroup key={key} title={FACET_TITLES[key]} options={facets[key]}
            selected={filters[key]} onToggle={(v) => toggle(key, v)} />
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
            {visible.map((b) => <BookCard key={b.id} book={b} onOpen={setSelected} />)}
          </div>
        )}
      </section>
      <BookDetail book={selected} onClose={() => setSelected(null)} onDownload={download}
        categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}
