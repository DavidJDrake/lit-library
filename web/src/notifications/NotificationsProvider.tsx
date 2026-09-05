import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchNotifications, markNotificationsRead, type Notification } from "./api";

export const NOTIFICATIONS_POLL_MS = 5 * 60 * 1000;
export const PAGE_SIZE = 50;
export const POPOVER_COUNT = 5;

export interface NotificationsState {
  items: Notification[]; unread: number; status: "loading" | "ready" | "error"; error?: string; hasMore: boolean; seen: boolean;
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
  const [seen, setSeen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const page = await fetchNotifications(apiUrl, await getIdToken(), { limit: PAGE_SIZE }, fetchFn);
      if (!mounted.current) return;
      setItems(page.items); setUnread(page.unread); setNext(page.next); setStatus("ready"); setError(undefined);
      if (page.items.length > 0) setSeen(true);
    } catch (e) {
      if (!mounted.current) return;
      setStatus("error"); setError((e as Error).message);
    }
  }, [apiUrl, getIdToken, fetchFn]);

  const loadMore = useCallback(async () => {
    if (!next) return;
    const page = await fetchNotifications(apiUrl, await getIdToken(), { limit: PAGE_SIZE, before: next }, fetchFn);
    if (!mounted.current) return;
    setItems((cur) => [...cur, ...page.items]); setNext(page.next); setUnread(page.unread);
  }, [apiUrl, getIdToken, fetchFn, next]);

  // Optimistic: flip locally first so the badge reacts instantly; reconcile from the server on failure.
  // The unread delta is computed from itemsRef (not inside a state updater) so StrictMode's
  // double-invoked updaters cannot double-count.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const markRead = useCallback(async (ids: string[]) => {
    const targets = new Set(ids.filter(Boolean));
    if (targets.size === 0) return;
    const flipped = itemsRef.current.filter((n) => targets.has(n.id) && !n.read).length;
    if (flipped > 0) {
      setItems((cur) => cur.map((n) => (targets.has(n.id) && !n.read ? { ...n, read: true } : n)));
      setUnread((u) => Math.max(0, u - flipped));
    }
    try {
      await markNotificationsRead(apiUrl, await getIdToken(), [...targets], fetchFn);
    } catch {
      await refresh();
    }
  }, [apiUrl, getIdToken, fetchFn, refresh]);

  const markAllRead = useCallback(async () => {
    setItems((cur) => cur.map((n) => (n.read ? n : { ...n, read: true })));
    setUnread(0);
    try {
      await markNotificationsRead(apiUrl, await getIdToken(), "all", fetchFn);
    } catch {
      await refresh();
    }
  }, [apiUrl, getIdToken, fetchFn, refresh]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), NOTIFICATIONS_POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisibility); };
  }, [refresh]);

  const value = useMemo<NotificationsState>(() => ({
    items, unread, status, error, hasMore: Boolean(next), seen, refresh, loadMore, markRead, markAllRead,
  }), [items, unread, status, error, next, seen, refresh, loadMore, markRead, markAllRead]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return ctx;
}
