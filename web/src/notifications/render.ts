import type { Notification } from "./api";

export interface RenderContext { titleOf(bookId: string): string | undefined }
export interface Rendered { icon: string; text: string; href?: string }

export function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
const categoryHref = (name: unknown) => `/?category=${encodeURIComponent(String(name))}`;
const str = (v: unknown) => (typeof v === "string" ? v : "");

// One entry per notification type. Adding a type = one entry here + one notify() call server-side.
const RENDERERS: Record<Notification["type"], (p: Record<string, unknown>, ctx: RenderContext) => Rendered> = {
  suggestion_pending: (p, ctx) => {
    const title = typeof p.bookId === "string" ? ctx.titleOf(p.bookId) : undefined;
    const text = `${localPart(str(p.suggestedBy))} suggested "${str(p.name)}"${title ? ` for ${title}` : ""}`;
    return { icon: "💡", text, ...(p.status === "accepted" ? { href: categoryHref(p.name) } : {}) };
  },
  suggestion_resolved: (p) => {
    const who = localPart(str(p.resolvedBy));
    return p.status === "accepted"
      ? { icon: "✅", text: `Your suggestion "${str(p.name)}" was accepted by ${who}`, href: categoryHref(p.name) }
      : { icon: "🚫", text: `Your suggestion "${str(p.name)}" was rejected by ${who}` };
  },
  books_added: (p) => {
    const count = Number(p.count) || 0;
    return { icon: "📚", text: `${count} new ${count === 1 ? "book" : "books"} added`, href: "/" };
  },
  category_created: (p) => ({ icon: "🏷️", text: `New category "${str(p.name)}"`, href: categoryHref(p.name) }),
};

export function renderNotification(n: Notification, ctx: RenderContext): Rendered {
  const r = RENDERERS[n.type];
  return r ? r(n.payload ?? {}, ctx) : { icon: "•", text: String(n.type) };
}

export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
