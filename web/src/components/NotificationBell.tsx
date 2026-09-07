import { useEffect, useRef, useState } from "react";
import { POPOVER_COUNT, useNotifications } from "../notifications/NotificationsProvider";
import Link from "./Link";
import NotificationItem from "./NotificationItem";

interface Props {
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  sender?: string;
  deviceLabelOf?(deviceId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function NotificationBell({ isAdmin, titleOf, sender, deviceLabelOf, onResolve }: Props) {
  const { items, unread, seen, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const bellButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const shown = items.slice(0, POPOVER_COUNT);

  // Move focus into the popover on open; return it to the bell on close. `wasOpen` guards
  // the close branch so mount (open starts false) doesn't steal focus onto the bell.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const first = popover.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? popover.current)?.focus();
    } else if (wasOpen.current) {
      bellButton.current?.focus();
    }
  }, [open]);

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
    // Scoped to the popover: Escape closes it only when focus is inside, so it doesn't
    // steal Escape from something else on the page (e.g. the reader typing in a search box).
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && popover.current?.contains(document.activeElement)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!seen) return null;

  return (
    <div className="bell" ref={root}>
      <button type="button" ref={bellButton} className="bell-button" aria-label="Notifications" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications" ref={popover} tabIndex={-1}>
          <ul className="notif-list">
            {shown.map((n) => (
              <NotificationItem key={n.id} n={n} isAdmin={isAdmin} titleOf={titleOf} sender={sender} deviceLabelOf={deviceLabelOf} onResolve={onResolve} onNavigate={() => setOpen(false)} />
            ))}
          </ul>
          <div className="popover-footer">
            <Link href="/notifications" onClick={() => setOpen(false)}>See all notifications</Link>
            {unread > 0 && <button type="button" className="more" onClick={() => void markAllRead()}>Mark all as read</button>}
          </div>
        </div>
      )}
    </div>
  );
}
