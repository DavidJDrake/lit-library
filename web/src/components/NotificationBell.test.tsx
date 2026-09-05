import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../notifications/api";
import { NotificationsProvider } from "../notifications/NotificationsProvider";
import NotificationBell from "./NotificationBell";

const n = (i: number, read = false): Notification => ({
  id: `2026-09-05T10:00:${String(i).padStart(2, "0")}.000Z#${i}`, type: "category_created", payload: { name: `Cat ${i}`, createdBy: "j@example.com", source: "admin" }, read, createdAt: `2026-09-05T10:00:${String(i).padStart(2, "0")}.000Z`,
});
function server(items: Notification[], unread: number) {
  const posted: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(init.body)); return { ok: true, status: 204, headers: new Headers() }; }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items, unread }) };
  }) as unknown as typeof fetch;
  return { fetchFn, posted };
}
const mount = (fetchFn: typeof fetch, isAdmin = false) => render(
  <NotificationsProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}>
    <div data-testid="outside">outside</div>
    <NotificationBell isAdmin={isAdmin} titleOf={() => undefined} />
  </NotificationsProvider>,
);

describe("NotificationBell", () => {
  it("is hidden with no notifications ever, then shows a capped badge", async () => {
    const empty = server([], 0);
    mount(empty.fetchFn);
    await waitFor(() => expect(empty.fetchFn).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    const many = server(Array.from({ length: 12 }, (_, i) => n(i)), 12);
    mount(many.fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    expect(screen.getByText("9+")).toBeInTheDocument();
  });
  it("opens to the five most recent, marks the shown unread ones read, and closes on Escape/outside", async () => {
    const items = Array.from({ length: 7 }, (_, i) => n(i, i === 1));
    const { fetchFn, posted } = server(items, 6);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(JSON.parse(posted[0]).ids).toEqual([items[0].id, items[2].id, items[3].id, items[4].id]);
    expect(screen.getByText("2")).toBeInTheDocument(); // 6 unread − 4 shown
    expect(within(dialog).getByRole("link", { name: "See all notifications" })).toHaveAttribute("href", "/notifications");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Mark all as read posts all and clears the badge", async () => {
    const items = Array.from({ length: 7 }, (_, i) => n(i));
    const { fetchFn, posted } = server(items, 7);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(JSON.parse(posted[0]).ids).toEqual(items.slice(0, 5).map((it) => it.id));
    expect(screen.getByText("2")).toBeInTheDocument(); // 7 unread − 5 shown
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(posted.some((b) => b === JSON.stringify({ all: true }))).toBe(true));
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });
});
