import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchNotifications, markNotificationsRead, type Notification } from "./api";

export const NOTIFICATIONS_POLL_MS = 5 * 60 * 1000;
export const PAGE_SIZE = 50;
export const POPOVER_COUNT = 5;

export interface NotificationsState {
  items: Notification[]; unread: number; status: "loading" | "ready" | "error"; error?: string; hasMore: boolean; seen: boolean;
  // Separate from `status`/`error`, which describe the initial load only: a failed loadMore
  // (fetching the next page) must not read as a full-page failure — see loadMore below.
  loadMoreError?: string;
  refresh(): Promise<void>; loadMore(): Promise<void>; markRead(ids: string[]): Promise<void>; markAllRead(): Promise<void>;
}

const Ctx = createContext<NotificationsState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; children: ReactNode }

export function NotificationsProvider({ apiUrl, getIdToken, fetchFn = fetch, children }: Props) {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [next, setNext] = useState<string>();
  const [status, setStatus] = useState<NotificationsState["status"]>("loading");
  const [error, setError] = useState<string>();
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [seen, setSeen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Mirrors of the latest items/unread so the optimistic handlers below can read "current
  // truth" synchronously — they aren't in any callback's dep array, so a plain closure
  // over `items`/`unread` would go stale.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const unreadRef = useRef(unread);
  useEffect(() => { unreadRef.current = unread; }, [unread]);

  // Guards against a background refresh (poll/visibility/manual) landing after a newer
  // refresh started, or after an optimistic write already succeeded, and clobbering
  // fresher state with what it fetched.
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seqRef.current;
    try {
      const page = await fetchNotifications(apiUrl, await getIdToken(), { limit: PAGE_SIZE }, fetchFn);
      if (!mounted.current || mine !== seqRef.current) return;
      setItems(page.items); setUnread(page.unread); setNext(page.next); setStatus("ready"); setError(undefined);
      if (page.items.length > 0) setSeen(true);
    } catch (e) {
      if (!mounted.current || mine !== seqRef.current) return;
      setStatus("error"); setError((e as Error).message);
    }
  }, [apiUrl, getIdToken, fetchFn]);

  const loadingMore = useRef(false);
  const loadMore = useCallback(async () => {
    if (!next || loadingMore.current) return;
    loadingMore.current = true;
    setLoadMoreError(undefined);
    try {
      const page = await fetchNotifications(apiUrl, await getIdToken(), { limit: PAGE_SIZE, before: next }, fetchFn);
      if (!mounted.current) return;
      setItems((cur) => [...cur, ...page.items]); setNext(page.next); setUnread(page.unread);
    } catch (e) {
      // Own field, not `status`/`error`: a second-page failure must not read as an
      // initial-load failure and blow away the page-wide view of items already shown.
      if (mounted.current) setLoadMoreError((e as Error).message);
    } finally {
      loadingMore.current = false;
    }
  }, [apiUrl, getIdToken, fetchFn, next]);

  // Optimistic: flip locally first so the badge reacts instantly. A failed write reverts
  // only the ids *this call* flipped (not a whole pre-flip snapshot — two markRead calls can
  // be in flight at once for different notifications, and one failing must not undo the
  // other's already-applied or still-pending flip). A successful write bumps seqRef so a
  // refresh already in flight when the write started can't later overwrite it with stale
  // (pre-write) data.
  const markRead = useCallback(async (ids: string[]) => {
    const targets = new Set(ids.filter(Boolean));
    if (targets.size === 0) return;
    seqRef.current += 1;
    const flippedIds = itemsRef.current.filter((n) => targets.has(n.id) && !n.read).map((n) => n.id);
    if (flippedIds.length > 0) {
      const flippedSet = new Set(flippedIds);
      setItems((cur) => cur.map((n) => (flippedSet.has(n.id) ? { ...n, read: true } : n)));
      setUnread((u) => Math.max(0, u - flippedIds.length));
    }
    try {
      await markNotificationsRead(apiUrl, await getIdToken(), [...targets], fetchFn);
    } catch {
      if (mounted.current && flippedIds.length > 0) {
        const revertSet = new Set(flippedIds);
        setItems((cur) => cur.map((n) => (revertSet.has(n.id) ? { ...n, read: false } : n)));
        setUnread((u) => u + flippedIds.length);
      }
    }
  }, [apiUrl, getIdToken, fetchFn]);

  const markAllRead = useCallback(async () => {
    seqRef.current += 1;
    const prevItems = itemsRef.current;
    const prevUnread = unreadRef.current;
    setItems((cur) => cur.map((n) => (n.read ? n : { ...n, read: true })));
    setUnread(0);
    try {
      await markNotificationsRead(apiUrl, await getIdToken(), "all", fetchFn);
    } catch {
      if (mounted.current) { setItems(prevItems); setUnread(prevUnread); }
    }
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), NOTIFICATIONS_POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisibility); };
  }, [refresh]);

  const value = useMemo<NotificationsState>(() => ({
    items, unread, status, error, hasMore: Boolean(next), seen, loadMoreError, refresh, loadMore, markRead, markAllRead,
  }), [items, unread, status, error, next, seen, loadMoreError, refresh, loadMore, markRead, markAllRead]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return ctx;
}
