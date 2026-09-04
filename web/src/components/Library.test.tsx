import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Catalog } from "../catalog/types";
import Library, { SESSION_RENEW_MS } from "./Library";

const catalog: Catalog = {
  generatedAt: "t",
  books: [
    { id: "1", title: "Attacking Network Protocols", authors: ["James Forshaw"], description: null, category: "Security & Hacking", subjects: [], publisher: "No Starch Press", bundle: "Hacking", year: 2018, formats: [{ type: "epub", size: 1048576, s3Key: "a" }], coverUrl: null, addedAt: "2026-02-01" },
    { id: "2", title: "The Black Company", authors: ["Glen Cook"], description: null, category: "Fiction", subjects: [], publisher: "Tor", bundle: "Black Company", year: 1984, formats: [{ type: "epub", size: 2097152, s3Key: "b" }], coverUrl: null, addedAt: "2026-03-01" },
  ],
};

function fetchFor(catalogBody: object, downloadBody: object = { url: "https://s3/x", filename: "f.epub", expiresIn: 900 }) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
    return {
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => (String(url).endsWith("/catalog.json") ? catalogBody : downloadBody),
    };
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
});

describe("Library", () => {
  it("loads the catalog and renders a card per book with the count", async () => {
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFor(catalog)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument();
    expect(screen.getByText(/2 books/)).toBeInTheDocument();
  });

  it("defaults to newest-added-first, with the sort select set to Recently added", async () => {
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFor(catalog)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveValue("added");
    const cards = screen.getAllByRole("button", { name: /Attacking Network Protocols|The Black Company/ });
    expect(cards[0]).toHaveAccessibleName(/The Black Company/);
  });

  it("filters via a facet checkbox and searches via the box", async () => {
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFor(catalog)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("checkbox", { name: /Fiction/ }));
    expect(screen.queryByRole("button", { name: /Attacking Network Protocols/ })).toBeNull();
    expect(screen.getByText(/1 book\b/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Fiction/ }));
    await userEvent.type(screen.getByRole("searchbox"), "forshaw");
    await waitFor(() => expect(screen.queryByRole("button", { name: /The Black Company/ })).toBeNull());
    expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument();
  });

  it("opens the detail dialog and downloads with the ID token", async () => {
    const fetchFn = fetchFor(catalog);
    const navigate = vi.fn();
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} navigate={navigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /The Black Company/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.click(within(dialog).getByRole("button", { name: /Download EPUB/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://s3/x"));
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith("/download"))!;
    expect(call[1].headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(call[1].body)).toEqual({ bookId: "2", format: "epub" });
  });

  it("shows a toast when the download fails", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      return String(url).endsWith("/catalog.json")
        ? { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog }
        : { ok: false, status: 404, json: async () => ({ error: "Unknown book or format" }) };
    }) as unknown as typeof fetch;
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} navigate={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /The Black Company/ }));
    await userEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: /Download EPUB/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unknown book or format"));
  });

  it("shows an error when the catalog cannot load", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      return { ok: false, status: 503, json: async () => ({}) };
    }) as unknown as typeof fetch;
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/catalog/i));
  });

  it("establishes a session before loading the catalog", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    render(<Library apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(calls.indexOf("GET /api/session")).toBeLessThan(calls.indexOf("GET /catalog.json"));
  });

  it("re-establishes the session and retries once when the catalog fetch is rejected", async () => {
    let catalogCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      catalogCalls += 1;
      if (catalogCalls === 1) return { ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    render(<Library apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(catalogCalls).toBe(2);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/session"))).toHaveLength(2);
  });

  it("renews the session cookie on a timer while mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    const { unmount } = render(<Library apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS + 10);
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(2);
    unmount();
    await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS + 10);
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(2);
    vi.useRealTimers();
  });
});
