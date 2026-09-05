import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../notifications/api";
import { NotificationsProvider } from "../notifications/NotificationsProvider";
import NotificationsPage from "./NotificationsPage";

const n = (i: number): Notification => ({ id: `2026-09-05T10:00:${String(i).padStart(2, "0")}.000Z#${i}`, type: "books_added", payload: { count: i + 1, bookIds: [] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" });
function server(pages: Array<{ items: Notification[]; unread: number; next?: string }>, fail = false) {
  let gets = 0;
  const posted: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(init.body)); return { ok: true, status: 204, headers: new Headers() }; }
    if (fail && gets === 0) { gets += 1; return { ok: false, status: 502, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "down" }) }; }
    const page = pages[Math.min(gets, pages.length - 1)]; gets += 1;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => page };
  }) as unknown as typeof fetch;
  return { fetchFn, posted };
}
const mount = (fetchFn: typeof fetch) => render(
  <NotificationsProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}>
    <NotificationsPage isAdmin={false} titleOf={() => undefined} />
  </NotificationsProvider>,
);

describe("NotificationsPage", () => {
  it("lists everything, loads more, and marks all read", async () => {
    const { fetchFn, posted } = server([{ items: [n(0), n(1)], unread: 2, next: "2026-09-05T10:00:01.000Z#1" }, { items: [n(2)], unread: 2 }]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(posted).toContain(JSON.stringify({ all: true })));
    expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });
  it("shows an empty state and an error state with retry", async () => {
    mount(server([{ items: [], unread: 0 }]).fetchFn);
    await waitFor(() => expect(screen.getByText("No notifications yet")).toBeInTheDocument());
    const { fetchFn } = server([{ items: [n(0)], unread: 1 }], true);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("down"));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });
});
