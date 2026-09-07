import { useState } from "react";
import type { Notification } from "../notifications/api";
import { localPart, relativeTime, renderNotification } from "../notifications/render";
import Link from "./Link";

interface Props {
  n: Notification;
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  sender?: string;
  deviceLabelOf?(deviceId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
  onNavigate?: () => void;
  nowMs?: number;
}

export default function NotificationItem({ n, isAdmin, titleOf, sender, deviceLabelOf, onResolve, onNavigate, nowMs }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = renderNotification(n, { titleOf, sender, deviceLabelOf });
  const p = n.payload ?? {};
  const pending = n.type === "suggestion_pending" && p.status === "pending";
  const name = String(p.name ?? "");

  async function resolve(action: "accept" | "reject") {
    if (!onResolve) return;
    setBusy(true); setError(undefined);
    try {
      await onResolve(String(p.suggestionId), action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`notif${n.read ? "" : " unread"}`}>
      <span className="notif-icon" aria-hidden="true">{r.icon}</span>
      <div className="notif-body">
        {r.href ? <Link href={r.href} onClick={onNavigate}>{r.text}</Link> : <span>{r.text}</span>}
        <div className="notif-meta">
          <span>{relativeTime(n.createdAt, nowMs)}</span>
          {n.type === "suggestion_pending" && p.status === "accepted" && <span>accepted by {localPart(String(p.resolvedBy ?? ""))}</span>}
          {n.type === "suggestion_pending" && p.status === "rejected" && <span>rejected</span>}
        </div>
        {error && <div className="notif-error" role="alert">{error}</div>}
      </div>
      {isAdmin && pending && onResolve && (
        <span className="chip-actions">
          <button type="button" aria-label={`Accept ${name}`} title="Accept" disabled={busy} onClick={() => void resolve("accept")}>✓</button>
          <button type="button" aria-label={`Reject ${name}`} title="Reject" disabled={busy} onClick={() => void resolve("reject")}>✗</button>
        </span>
      )}
    </li>
  );
}
