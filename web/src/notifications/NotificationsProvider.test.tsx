import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "./api";
import { NOTIFICATIONS_POLL_MS, NotificationsProvider, useNotifications } from "./NotificationsProvider";

const n = (i: number, read = false): Notification => ({
  id: `2026-09-05T10:00:0${i}.000Z#${i}`, type: "books_added", payload: { count: i, bookIds: [] }, read, createdAt: `2026-09-05T10:00:0${i}.000Z`,
});

function server(pages: Array<{ items: Notification[]; unread: number; next?: string }>, readStatus = 204) {
  const posted: string[] = [];
  let gets = 0;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(init.body)); return { ok: readStatus < 300, status: readStatus, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "x" }) }; }
    const page = pages[Math.min(gets, pages.length - 1)];
    gets += 1;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => page };
  }) as unknown as typeof fetch;
  return { fetchFn, posted, gets: () => gets };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function Probe() {
  const s = useNotifications();
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.items.length}</span>
      <span data-testid="unread">{s.unread}</span>
      <span data-testid="seen">{String(s.seen)}</span>
      <span data-testid="more">{String(s.hasMore)}</span>
      <button onClick={() => void s.markRead([s.items[0]?.id])}>read-first</button>
      <button onClick={() => void s.markAllRead()}>read-all</button>
      <button onClick={() => void s.loadMore()}>more</button>
      <button onClick={() => void s.refresh()}>refresh</button>
    </div>
  );
}
const mount = (fetchFn: typeof fetch) => render(<NotificationsProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></NotificationsProvider>);

afterEach(() => vi.useRealTimers());

describe("NotificationsProvider", () => {
  it("loads on mount, exposes unread/seen/hasMore, and appends on loadMore", async () => {
    const { fetchFn } = server([{ items: [n(1), n(2, true)], unread: 1, next: "2026-09-05T10:00:02.000Z#2" }, { items: [n(3)], unread: 1 }]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByTestId("seen")).toHaveTextContent("true");
    expect(screen.getByTestId("more")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("3"));
    expect(screen.getByTestId("more")).toHaveTextContent("false");
    expect(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain("before=2026-09-05T10%3A00%3A02.000Z%232");
  });
  it("loadMore ignores a call while the previous one is still in flight", async () => {
    const { fetchFn, gets } = server([
      { items: [n(1)], unread: 1, next: "2026-09-05T10:00:01.000Z#1" },
      { items: [n(2)], unread: 1 },
    ]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("more")).toHaveTextContent("true"));
    const more = screen.getByRole("button", { name: "more" }) as HTMLButtonElement;
    // Two clicks in the same synchronous tick, so the second lands before the first's fetch settles.
    act(() => { more.click(); more.click(); });
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
    expect(gets()).toBe(2); // initial load + exactly one loadMore GET; the concurrent second call was ignored
  });
  it("markRead is optimistic and posts; a failed post reverts locally without an extra GET", async () => {
    const { fetchFn, posted } = server([{ items: [n(1), n(2)], unread: 2 }]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("2"));
    await userEvent.click(screen.getByRole("button", { name: "read-first" }));
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    await waitFor(() => expect(posted).toEqual([JSON.stringify({ ids: [n(1).id] })]));
    const failing = server([{ items: [n(1)], unread: 1 }], 500);
    mount(failing.fetchFn);
    await waitFor(() => expect(screen.getAllByTestId("unread")[1]).toHaveTextContent("1"));
    const getsBeforeWrite = failing.gets();
    await userEvent.click(screen.getAllByRole("button", { name: "read-all" })[1]);
    await waitFor(() => expect(failing.posted).toEqual([JSON.stringify({ all: true })]));
    // Reverted to the pre-flip snapshot, not refreshed from the server (which would drop loadMore's pagination).
    expect(screen.getAllByTestId("unread")[1]).toHaveTextContent("1");
    expect(screen.getAllByTestId("count")[1]).toHaveTextContent("1");
    expect(failing.gets()).toBe(getsBeforeWrite);
  });
  it("a stale in-flight refresh cannot clobber a markRead that already succeeded", async () => {
    const posted: string[] = [];
    let getCount = 0;
    const deferredGet = deferred<{ items: Notification[]; unread: number }>();
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(String(init.body));
        return { ok: true, status: 204, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}) };
      }
      getCount += 1;
      if (getCount === 1) {
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1 }) };
      }
      const page = await deferredGet.promise;
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => page };
    }) as unknown as typeof fetch;

    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("1"));

    // A background refresh (poll/visibility) starts and is left in flight.
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(getCount).toBe(2));

    // markRead completes (POST 204) while that refresh is still pending.
    await userEvent.click(screen.getByRole("button", { name: "read-first" }));
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
    await waitFor(() => expect(posted).toEqual([JSON.stringify({ ids: [n(1).id] })]));

    // The stale refresh now resolves with pre-read data; it must be discarded, not applied.
    await act(async () => {
      deferredGet.resolve({ items: [n(1)], unread: 1 });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
  });
  it("polls every NOTIFICATIONS_POLL_MS and on visibility, and reports errors without throwing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchFn, gets } = server([{ items: [], unread: 0 }]);
    mount(fetchFn);
    await waitFor(() => expect(gets()).toBe(1));
    expect(screen.getByTestId("seen")).toHaveTextContent("false");
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_MS + 10); });
    expect(gets()).toBe(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    await waitFor(() => expect(gets()).toBe(3));
    vi.useRealTimers();
    const broken = vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({ error: "down" }) })) as unknown as typeof fetch;
    mount(broken);
    await waitFor(() => expect(screen.getAllByTestId("status")[1]).toHaveTextContent("error"));
  });
});
