import { apiCall } from "../catalog/apiCall";

export type NotificationType = "suggestion_pending" | "suggestion_resolved" | "books_added" | "category_created" | "kindle_bounce";
export interface Notification { id: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationsPage { items: Notification[]; unread: number; next?: string }

export async function fetchNotifications(
  apiUrl: string, idToken: string, opts: { limit?: number; before?: string } = {}, fetchFn: typeof fetch = fetch,
): Promise<NotificationsPage> {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const qs = q.toString();
  const res = await apiCall(apiUrl, idToken, `/notifications${qs ? `?${qs}` : ""}`, { method: "GET" }, 200, fetchFn);
  const body = (await res.json()) as Partial<NotificationsPage>;
  if (!Array.isArray(body?.items) || typeof body.unread !== "number") throw new Error("Notifications response is malformed");
  return body as NotificationsPage;
}

export async function markNotificationsRead(apiUrl: string, idToken: string, target: string[] | "all", fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/notifications/read",
    { method: "POST", body: JSON.stringify(target === "all" ? { all: true } : { ids: target }) }, 204, fetchFn);
}
