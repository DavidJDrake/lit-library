import { useEffect, useRef, useState } from "react";
import { POPOVER_COUNT, useNotifications } from "../notifications/NotificationsProvider";
import Link from "./Link";
import NotificationItem from "./NotificationItem";

interface Props {
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
}

export default function NotificationBell({ isAdmin, titleOf, onResolve }: Props) {
  const { items, unread, seen, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  // Whether there was unread content when the popover was opened. Opening auto-marks the
  // shown rows read, which can drop `unread` to 0 in the same tick (e.g. every notification
  // fits in the popover) — that shouldn't yank "Mark all as read" out from under the user
  // before they get a chance to use it, so its visibility is decided once, at open time.
  const [canMarkAll, setCanMarkAll] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shown = items.slice(0, POPOVER_COUNT);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) setCanMarkAll(unread > 0);
      return next;
    });
  }

  // GitHub-style: what you have seen in the popover counts as read.
  useEffect(() => {
    if (!open) return;
    const ids = shown.filter((n) => !n.read).map((n) => n.id);
    if (ids.length > 0) void markRead(ids);
    // Only when the popover opens — later refreshes while open should not auto-clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!seen) return null;

  return (
    <div className="bell" ref={root}>
      <button type="button" className="bell-button" aria-label="Notifications" aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <ul className="notif-list">
            {shown.map((n) => (
              <NotificationItem key={n.id} n={n} isAdmin={isAdmin} titleOf={titleOf} onResolve={onResolve} onNavigate={() => setOpen(false)} />
            ))}
          </ul>
          <div className="popover-footer">
            <Link href="/notifications" onClick={() => setOpen(false)}>See all notifications</Link>
            {canMarkAll && <button type="button" className="more" onClick={() => { void markAllRead(); setCanMarkAll(false); }}>Mark all as read</button>}
          </div>
        </div>
      )}
    </div>
  );
}
