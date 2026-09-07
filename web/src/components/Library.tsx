import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  applyOverlay, createCategory, resolveSuggestion, setBookCategory, suggestCategory,
} from "../catalog/library";
import { requestDownload, startDownload } from "../catalog/download";
import { useLibraryData } from "../catalog/LibraryDataProvider";
import {
  applyFilters, buildSearchIndex, facetCounts, filtersFromSearch, queryFromSearch,
  searchBooks, searchFromView, sortBooks, sortFromSearch,
} from "../catalog/search";
import { FACET_KEYS, type Book, type FacetKey, type Filters, type ReadingStatus, type SortKey } from "../catalog/types";
import type { KindleError } from "../kindle/api";
import { LOAD_FAILED_MESSAGE, type KindleState } from "../kindle/KindleProvider";
import BookCard from "./BookCard";
import BookDetail from "./BookDetail";
import CategorySuggestions from "./CategorySuggestions";
import FacetGroup from "./FacetGroup";
import Toast from "./Toast";
import { useGridWindow } from "./useGridWindow";

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
  const { books, overlay, loadError, overlayError, refreshOverlay, setReadingStatus } = useLibraryData();
  const [query, setQuery] = useState(() => queryFromSearch(window.location.search));
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(window.location.search));
  const [sort, setSort] = useState<SortKey>(() => sortFromSearch(window.location.search));
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

  // A new search, facet filter or sort is a new list, not a continuation of the old
  // one — scroll back to the top rather than leaving the reader stranded in reserved
  // space below a now-shorter list. A background data refresh (e.g. after moving a
  // book) is deliberately not in this list: it can reorder `visible` without the
  // reader having asked for a different view, and should not move them.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [deferredQuery, sort, filters]);

  // View → URL, one direction only: replace (never push) the current entry so the address
  // bar always describes what's on screen without flooding history — a facet toggle or a
  // character typed into search is view state, not navigation. Keyed off the deferred query
  // so a fast typist doesn't rewrite the address bar on every keystroke, only once things
  // settle. replaceState never fires `popstate`, so this can't loop into the effect below;
  // the guard below is what makes it a no-op (not just harmless) when nothing changed.
  useEffect(() => {
    const next = searchFromView({ query: deferredQuery, filters, sort });
    if (next === window.location.search) return;
    window.history.replaceState({}, "", `${window.location.pathname}${next}${window.location.hash}`);
  }, [deferredQuery, filters, sort]);

  // URL → state, the other direction: re-read and re-apply on every `popstate`, whether it
  // came from the browser's back/forward buttons or a same-page Link (which pushes a history
  // entry and dispatches `popstate` itself, even to a URL identical to the current one). That
  // unconditional re-apply is what fixes the re-seed bug — following a category link while
  // already on that URL still re-applies the filter, because this runs regardless of whether
  // the address bar's text actually changed.
  useEffect(() => {
    const onPopState = () => {
      const search = window.location.search;
      setQuery(queryFromSearch(search));
      setFilters(filtersFromSearch(search));
      setSort(sortFromSearch(search));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const { wrapperRef, gridRef, range } = useGridWindow(visible.length);
  const windowed = range ? visible.slice(range.startIndex, range.endIndex) : visible;

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
  // Optimistic, unlike changeCategory above: setReadingStatus (from LibraryDataProvider)
  // already patches the overlay locally and reverts only this book on failure, so there is
  // no refreshOverlay round trip here — just surface a failure as a toast.
  const changeStatus = useCallback(async (book: Book, status: ReadingStatus | null) => {
    try {
      await setReadingStatus(book.id, status);
    } catch (e) {
      fail((e as Error).message);
    }
  }, [setReadingStatus, fail]);
  const suggest = useCallback((name: string, bookId?: string) =>
    mutate((t) => suggestCategory(apiUrl, t, name, bookId, fetchFn), `Suggested '${name}' — waiting for approval`), [mutate, apiUrl, fetchFn]);
  const addCategory = useCallback((name: string) =>
    mutate((t) => createCategory(apiUrl, t, name, fetchFn), `Added category '${name}'`), [mutate, apiUrl, fetchFn]);
  const resolve = useCallback((id: string, action: "accept" | "reject") => {
    const name = overlay?.suggestions.find((s) => s.id === id)?.name ?? "suggestion";
    return mutate((t) => resolveSuggestion(apiUrl, t, id, action, fetchFn), `${action === "accept" ? "Accepted" : "Rejected"} '${name}'`);
  }, [mutate, apiUrl, fetchFn, overlay]);

  const kindleForDialog = useMemo(() => kindle && {
    devices: kindle.devices, defaultDeviceId: kindle.defaultDeviceId, sender: kindle.sender, loadFailed: kindle.loadFailed,
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
    // Never compose a whole-list PUT out of a list we do not have: read the real one
    // first, so a load that failed cannot turn "add one device" into "delete the rest".
    // The failure is rendered by the form that raised it, not toasted here as well.
    onSaveDevice: async (label: string, address: string) => {
      const current = kindle.devices ?? await kindle.reload().catch(() => { throw new Error(LOAD_FAILED_MESSAGE); });
      await kindle.save([...current, { label, address }]);
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
          <div ref={wrapperRef}>
            {range && range.topSpacer > 0 && <div style={{ height: range.topSpacer }} />}
            <div className="grid" ref={gridRef}>
              {windowed.map((b) => <BookCard key={b.id} book={b} onOpen={(b) => setSelectedId(b.id)} />)}
            </div>
            {range && range.bottomSpacer > 0 && <div style={{ height: range.bottomSpacer }} />}
          </div>
        )}
      </section>
      <BookDetail book={selected} onClose={() => setSelectedId(null)} onDownload={download}
        categories={categoryNames} onChangeCategory={changeCategory} onSuggest={(name, bookId) => suggest(name, bookId)}
        onChangeStatus={changeStatus} kindle={kindleForDialog} />
      <Toast message={toast?.message} variant={toast?.variant} onDismiss={dismissToast} />
    </div>
  );
}
