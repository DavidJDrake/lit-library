import { describe, expect, it } from "vitest";
import type { Notification } from "./api";
import { localPart, relativeTime, renderNotification } from "./render";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const mk = (type: Notification["type"], payload: Record<string, unknown>): Notification => ({ id: "x", type, payload, read: false, createdAt: "2026-09-05T11:00:00.000Z" });
const ctx = { titleOf: (id: string) => (id === "b1" ? "Black Hound of Death" : undefined) };

describe("renderNotification", () => {
  it("suggestion_pending with and without a resolvable book", () => {
    expect(renderNotification(mk("suggestion_pending", { suggestionId: "s", name: "Cosmic Horror", bookId: "b1", suggestedBy: "zach@example.com", status: "pending" }), ctx))
      .toEqual({ icon: "💡", text: 'zach suggested "Cosmic Horror" for Black Hound of Death' });
    expect(renderNotification(mk("suggestion_pending", { suggestionId: "s", name: "Cosmic Horror", bookId: "zz", suggestedBy: "zach@example.com", status: "accepted" }), ctx))
      .toEqual({ icon: "💡", text: 'zach suggested "Cosmic Horror"', href: "/?category=Cosmic%20Horror" });
  });
  it("suggestion_resolved, books_added, category_created, unknown", () => {
    expect(renderNotification(mk("suggestion_resolved", { suggestionId: "s", name: "Poetry", status: "accepted", resolvedBy: "jay@example.com" }), ctx))
      .toEqual({ icon: "✅", text: 'Your suggestion "Poetry" was accepted by jay', href: "/?category=Poetry" });
    expect(renderNotification(mk("suggestion_resolved", { suggestionId: "s", name: "Poetry", status: "rejected", resolvedBy: "jay@example.com" }), ctx))
      .toEqual({ icon: "🚫", text: 'Your suggestion "Poetry" was rejected by jay' });
    expect(renderNotification(mk("books_added", { count: 23, bookIds: [] }), ctx)).toEqual({ icon: "📚", text: "23 new books added", href: "/" });
    expect(renderNotification(mk("books_added", { count: 1, bookIds: [] }), ctx).text).toBe("1 new book added");
    expect(renderNotification(mk("category_created", { name: "Essays", createdBy: "jay@example.com", source: "admin" }), ctx))
      .toEqual({ icon: "🏷️", text: 'New category "Essays"', href: "/?category=Essays" });
    expect(renderNotification({ ...mk("books_added", {}), type: "surprise" as Notification["type"] }, ctx)).toEqual({ icon: "•", text: "surprise" });
  });
  it("kindle_bounce names the book and the sender and links to settings", () => {
    const ctx2 = { ...ctx, sender: "library@lit.example.com" };
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "Permanent/General" }), ctx2))
      .toEqual({ icon: "📵", text: 'Your Kindle rejected "Black Hound of Death" — add library@lit.example.com to your approved senders', href: "/settings" });
    expect(renderNotification(mk("kindle_bounce", { bookId: "zz", kind: "Bounce", reason: "x" }), ctx2).text)
      .toBe('Your Kindle rejected "a book" — add library@lit.example.com to your approved senders');
  });
  it("kindle_bounce names the device when it is still saved", () => {
    const ctx2 = { ...ctx, sender: "library@lit.example.com", deviceLabelOf: (id: string) => (id === "a1" ? "Scribe" : undefined) };
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x", deviceId: "a1" }), ctx2))
      .toEqual({ icon: "📵", text: 'Scribe rejected "Black Hound of Death" — add library@lit.example.com to your approved senders', href: "/settings" });
  });

  it("kindle_bounce falls back when the device is gone or was never recorded", () => {
    const ctx2 = { ...ctx, sender: "library@lit.example.com", deviceLabelOf: () => undefined };
    const expected = 'Your Kindle rejected "Black Hound of Death" — add library@lit.example.com to your approved senders';
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x", deviceId: "gone" }), ctx2).text).toBe(expected);
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x" }), ctx2).text).toBe(expected);
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x", deviceId: "a1" }), { ...ctx, sender: "library@lit.example.com" }).text).toBe(expected);
  });
});

describe("relativeTime / localPart", () => {
  it("buckets by age", () => {
    expect(relativeTime("2026-09-05T11:59:30.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-09-05T11:45:00.000Z", NOW)).toBe("15 min ago");
    expect(relativeTime("2026-09-05T09:00:00.000Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-09-03T12:00:00.000Z", NOW)).toBe("2 d ago");
    expect(relativeTime("2026-08-01T12:00:00.000Z", NOW)).toBe("1 Aug 2026");
    expect(localPart("a.b@example.com")).toBe("a.b");
    expect(localPart("plain")).toBe("plain");
  });
});
