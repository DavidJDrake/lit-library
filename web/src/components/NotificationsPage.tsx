import { useNotifications } from "../notifications/NotificationsProvider";
import NotificationItem from "./NotificationItem";

interface Props {
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
}

export default function NotificationsPage({ isAdmin, titleOf, onResolve }: Props) {
  const { items, unread, status, error, hasMore, refresh, loadMore, markAllRead } = useNotifications();
  return (
    <main className="page notifications-page">
      <div className="page-head">
        <h2>Notifications</h2>
        {unread > 0 && <button type="button" className="btn secondary" onClick={() => void markAllRead()}>Mark all as read</button>}
      </div>
      {status === "error" && (
        <div className="error" role="alert">
          Couldn't load notifications ({error}). <button type="button" className="more" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {status === "loading" && <p className="empty">Loading…</p>}
      {status === "ready" && items.length === 0 && <p className="empty">No notifications yet</p>}
      {items.length > 0 && (
        <ul className="notif-list panel">
          {items.map((n) => <NotificationItem key={n.id} n={n} isAdmin={isAdmin} titleOf={titleOf} onResolve={onResolve} />)}
        </ul>
      )}
      {hasMore && <button type="button" className="btn secondary" onClick={() => void loadMore()}>Load more</button>}
    </main>
  );
}
