import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  applyOverlay, createCategory, resolveSuggestion, setBookCategory, suggestCategory,
} from "../catalog/library";
import { requestDownload, startDownload } from "../catalog/download";
import { useLibraryData } from "../catalog/LibraryDataProvider";
import { applyFilters, buildSearchIndex, facetCounts, filtersFromSearch, searchBooks, sortBooks } from "../catalog/search";
import { FACET_KEYS, type Book, type FacetKey, type Filters, type SortKey } from "../catalog/types";
import type { KindleError } from "../kindle/api";
import type { KindleState } from "../kindle/KindleProvider";
import BookCard from "./BookCard";
import BookDetail from "./BookDetail";
import CategorySuggestions from "./CategorySuggestions";
import FacetGroup from "./FacetGroup";
import Toast from "./Toast";

export { SESSION_RENEW_MS } from "../catalog/LibraryDataProvider";

interface Props {
  apiUrl: string;
  getIdToken: () => Promise<string>;
  fetchFn?: typeof fetch;
  navigate?: (url: string) => void;
  isAdmin?: boolean;
  onChanged?: () => void;
  kindle?: KindleState;
}

const FACET_TITLES: Record<FacetKey, string> = {
  category: "Category", format: "Format", publisher: "Publisher", bundle: "Bundle", author: "Author", year: "Year",
};

export default function Library({ apiUrl, getIdToken, fetchFn = fetch, navigate, isAdmin = false, onChanged, kindle }: Props) {
  const { books, overlay, loadError, overlayError, refreshOverlay } = useLibraryData();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(window.location.search));
  const [sort, setSort] = useState<SortKey>("added");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; variant: "error" | "ok" }>();
  const fail = useCallback((message: string) => setToast({ message, variant: "error" }), []);
  const ok = useCallback((message: string) => setToast({ message, variant: "ok" }), []);

  useEffect(() => {
    if (overlayError) fail(`Category editing is unavailable right now (${overlayError})`);
  }, [overlayError, fail]);

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
      fail((e as Error).message);
    }
  }, [apiUrl, getIdToken, fetchFn, navigate, fail]);

  // Every mutation re-fetches the overlay rather than patching local state: one
  // code path, and the server's view always wins (which is also the "revert" on failure).
  const mutate = useCallback(async (run: (token: string) => Promise<void>, success: string) => {
    try {
      await run(await getIdToken());
    } catch (e) {
      fail((e as Error).message);
      return;
    }
    ok(success);
    onChanged?.();
    try {
      await refreshOverlay();
    } catch (e) {
      fail(`Saved, but the list could not refresh (${(e as Error).message})`);
    }
  }, [getIdToken, refreshOverlay, fail, ok, onChanged]);

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

  const kindleForDialog = useMemo(() => kindle && {
    devices: kindle.devices, defaultDeviceId: kindle.defaultDeviceId, sender: kindle.sender,
    onSend: async (book: Book, format?: "epub" | "pdf", deviceId?: string) => {
      try {
        const r = await kindle.send(book.id, format, deviceId);
        ok(`Sent to ${r.deviceLabel || r.sentTo} — it usually arrives within a couple of minutes`);
      } catch (e) {
        // no_address is handled by the dialog reopening the inline form, not a toast; every
        // other failure toasts here and still rethrows so the dialog resets its sending state.
        if ((e as KindleError).code !== "no_address") fail((e as Error).message);
        throw e;
      }
    },
    onSaveDevice: async (label: string, address: string) => {
      try { await kindle.save([...(kindle.devices ?? []), { label, address }]); }
      catch (e) { fail((e as Error).message); throw e; }
    },
  }, [kindle, ok, fail]);

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
        categories={categoryNames} onChangeCategory={changeCategory} onSuggest={(name, bookId) => suggest(name, bookId)}
        kindle={kindleForDialog} />
      <Toast message={toast?.message} variant={toast?.variant} onDismiss={dismissToast} />
    </div>
  );
}
