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
      <span data-testid="loadMoreError">{s.loadMoreError ?? ""}</span>
      <span data-testid="read-ids">{s.items.filter((i) => i.read).map((i) => i.id).join(",")}</span>
      <button onClick={() => void s.markRead([s.items[0]?.id])}>read-first</button>
      <button onClick={() => void s.markRead([s.items[1]?.id])}>read-second</button>
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
  it("a failed markRead reverts only the notification it flipped, leaving an overlapping successful markRead's flip alone", async () => {
    const deferredA = deferred<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>();
    const deferredB = deferred<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>();
    const posted: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = String(init.body);
        posted.push(body);
        return body.includes(n(1).id) ? deferredA.promise : deferredB.promise;
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1), n(2)], unread: 2 }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("2"));

    // Two overlapping markRead calls for different notifications, both left in flight.
    await userEvent.click(screen.getByRole("button", { name: "read-first" })); // flips n(1)
    await userEvent.click(screen.getByRole("button", { name: "read-second" })); // flips n(2)
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
    await waitFor(() => expect(posted).toHaveLength(2));

    // The first call's request fails; the second succeeds.
    await act(async () => {
      deferredA.resolve({ ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "x" }) });
      deferredB.resolve({ ok: true, status: 204, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}) });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    // Only n(1) (the failed call's own flip) reverts; n(2) stays read, and the unread
    // count is adjusted by exactly the one reverted item, not restored from a snapshot
    // that would also undo n(2)'s successful flip.
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByTestId("read-ids")).toHaveTextContent(n(2).id);
  });
  it("a failed markRead does not double-count on top of a refresh that already landed the server's not-yet-written count", async () => {
    const deferredPost = deferred<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>();
    let gets = 0;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return deferredPost.promise;
      gets += 1;
      // Every GET (initial load and the later manual refresh) reflects the server not
      // having seen the write yet: n(1) still unread, unread count still 5.
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 5 }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("5"));

    // markRead optimistically drops the count, and its write is left in flight.
    await userEvent.click(screen.getByRole("button", { name: "read-first" }));
    expect(screen.getByTestId("unread")).toHaveTextContent("4");

    // A background refresh (poll/visibility/manual) lands while the write is still
    // pending. The server hasn't processed the write, so it legitimately reports the
    // notification as still unread and resets the count to 5 -- this is correct, not a bug.
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(gets).toBe(2));
    expect(screen.getByTestId("unread")).toHaveTextContent("5");

    // The write then fails. Its revert must not add flippedIds.length back on top of the
    // refresh's already-current count, which would drift to 6 against a truth of 5.
    await act(async () => {
      deferredPost.resolve({ ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "x" }) });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(screen.getByTestId("unread")).toHaveTextContent("5");
  });
  it("a failed markAllRead reverts only the notifications it flipped, leaving a concurrent successful single mark (and the notification it targets) alone", async () => {
    const deferredAll = deferred<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>();
    let gets = 0;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = String(init.body);
        if (body === JSON.stringify({ all: true })) return deferredAll.promise;
        // The single markRead for n(3) below: succeed immediately.
        return { ok: true, status: 204, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}) };
      }
      gets += 1;
      if (gets === 1) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1, next: "cursor" }) };
      // loadMore's page: a notification (n(3)) that didn't exist yet when markAllRead started.
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(3)], unread: 1 }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("1"));

    // markAllRead flips n(1) (the only notification that exists yet) and is left in flight.
    await userEvent.click(screen.getByRole("button", { name: "read-all" }));
    expect(screen.getByTestId("unread")).toHaveTextContent("0");

    // A second page loads in, bringing in n(3) -- a notification markAllRead never knew about.
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

    // n(3) is marked read individually, and that write succeeds.
    await userEvent.click(screen.getByRole("button", { name: "read-second" }));
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("0"));

    // markAllRead's own write then fails. A whole-list snapshot captured back when
    // markAllRead started (before n(3) even existed) would restore over it and lose n(3)
    // entirely; the per-item revert must only touch n(1), the one notification this call
    // itself flipped, leaving n(3) present and read.
    await act(async () => {
      deferredAll.resolve({ ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "x" }) });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(screen.getByTestId("read-ids")).toHaveTextContent(n(3).id);
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
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
  it("a refresh already in flight before markRead starts cannot clobber it with stale data", async () => {
    const posted: string[] = [];
    let getCount = 0;
    const deferredGet = deferred<{ items: Notification[]; unread: number }>();
    const deferredPost = deferred<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>();
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(String(init.body)); return deferredPost.promise; }
      getCount += 1;
      if (getCount === 1) {
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1 }) };
      }
      const page = await deferredGet.promise;
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => page };
    }) as unknown as typeof fetch;

    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("1"));

    // A background refresh (poll/visibility) starts first and is left in flight.
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(getCount).toBe(2));

    // markRead starts while that refresh is still pending; its own write is also left in flight.
    await userEvent.click(screen.getByRole("button", { name: "read-first" }));
    expect(screen.getByTestId("unread")).toHaveTextContent("0");

    // The stale refresh resolves with pre-read data before the write finishes; it must be
    // discarded (the sequence bump at the start of markRead already invalidated it), not applied.
    await act(async () => {
      deferredGet.resolve({ items: [n(1)], unread: 1 });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    // The write itself then completes normally.
    await act(async () => {
      deferredPost.resolve({ ok: true, status: 204, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}) });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    await waitFor(() => expect(posted).toEqual([JSON.stringify({ ids: [n(1).id] })]));
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
  });
  it("loadMore reports its own loadMoreError, leaving status/error (the initial-load fields) untouched, and keeps existing items", async () => {
    let gets = 0;
    const fetchFn = vi.fn(async () => {
      gets += 1;
      if (gets === 1) {
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1, next: "2026-09-05T10:00:01.000Z#1" }) };
      }
      return { ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("more")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("loadMoreError")).toHaveTextContent("boom"));
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    expect(screen.getByTestId("more")).toHaveTextContent("true");
  });
  it("a retried loadMore clears a previous loadMoreError once it succeeds", async () => {
    let gets = 0;
    const fetchFn = vi.fn(async () => {
      gets += 1;
      if (gets === 1) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1, next: "2026-09-05T10:00:01.000Z#1" }) };
      if (gets === 2) return { ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(2)], unread: 1 }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("more")).toHaveTextContent("true"));
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("loadMoreError")).toHaveTextContent("boom"));
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
    expect(screen.getByTestId("loadMoreError")).toHaveTextContent("");
  });
  it("a successful refresh clears a stale loadMoreError left by a prior failed loadMore", async () => {
    let gets = 0;
    const fetchFn = vi.fn(async () => {
      gets += 1;
      if (gets === 1) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1, next: "2026-09-05T10:00:01.000Z#1" }) };
      if (gets === 2) return { ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items: [n(1)], unread: 1 }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("more")).toHaveTextContent("true"));
    // Fail a load-more: the inline error appears.
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("loadMoreError")).toHaveTextContent("boom"));
    // A background refresh (poll/visibility/manual) then succeeds and replaces the list.
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(gets).toBe(3));
    // The stale inline message, which no longer describes anything visible, is gone.
    expect(screen.getByTestId("loadMoreError")).toHaveTextContent("");
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
