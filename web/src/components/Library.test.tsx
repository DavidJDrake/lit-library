import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LibraryDataProvider } from "../catalog/LibraryDataProvider";
import type { KindleState } from "../kindle/KindleProvider";
import type { Catalog } from "../catalog/types";
import Library, { SESSION_RENEW_MS } from "./Library";

interface LibraryProps {
  apiUrl: string;
  getIdToken: () => Promise<string>;
  fetchFn?: typeof fetch;
  navigate?: (url: string) => void;
  isAdmin?: boolean;
  onChanged?: () => void;
  kindle?: KindleState;
}

function renderLibrary(props: LibraryProps) {
  return render(
    <LibraryDataProvider apiUrl={props.apiUrl} getIdToken={props.getIdToken} fetchFn={props.fetchFn}>
      <Library {...props} />
    </LibraryDataProvider>,
  );
}

const catalog: Catalog = {
  generatedAt: "t",
  books: [
    { id: "1", title: "Attacking Network Protocols", authors: ["James Forshaw"], description: null, category: "Security & Hacking", subjects: [], publisher: "No Starch Press", bundle: "Hacking", year: 2018, formats: [{ type: "epub", size: 1048576, s3Key: "a" }], coverUrl: null, addedAt: "2026-02-01" },
    { id: "2", title: "The Black Company", authors: ["Glen Cook"], description: null, category: "Fiction", subjects: [], publisher: "Tor", bundle: "Black Company", year: 1984, formats: [{ type: "epub", size: 2097152, s3Key: "b" }], coverUrl: null, addedAt: "2026-03-01" },
  ],
};

const overlay = {
  categories: [{ name: "Fiction", source: "seed" }, { name: "Security & Hacking", source: "seed" }, { name: "TTRPG", source: "seed" }],
  bookCategories: {},
  suggestions: [{ id: "s1", name: "Cookbooks", suggestedBy: "friend@example.com", createdAt: "2026-09-04T00:00:00Z" }],
};

type Handler = (url: string, init?: RequestInit) => Promise<unknown> | unknown;
function fetchFor(catalogBody: object, downloadBody: object = { url: "https://s3/x", filename: "f.epub", expiresIn: 900 }, extra: Record<string, Handler> = {}) {
  const jsonRes = (status: number, body: unknown) => ({
    ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body,
  });
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const key = `${init?.method ?? "GET"} ${u.replace(/^https?:\/\/[^/]+/, "")}`;
    for (const [pattern, handler] of Object.entries(extra)) if (new RegExp(pattern).test(key)) return handler(u, init);
    if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
    if (u.endsWith("/library")) return jsonRes(200, overlay);
    if (u.endsWith("/catalog.json")) return jsonRes(200, catalogBody);
    return jsonRes(200, downloadBody);
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Library", () => {
  it("loads the catalog and renders a card per book with the count", async () => {
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog) });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument();
    expect(screen.getByText(/2 books/)).toBeInTheDocument();
  });

  it("defaults to newest-added-first, with the sort select set to Recently added", async () => {
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog) });
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveValue("added");
    const cards = screen.getAllByRole("button", { name: /Attacking Network Protocols|The Black Company/ });
    expect(cards[0]).toHaveAccessibleName(/The Black Company/);
  });

  it("filters via a facet checkbox and searches via the box", async () => {
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog) });
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
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn, navigate });
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
      if (String(url).endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      return String(url).endsWith("/catalog.json")
        ? { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog }
        : { ok: false, status: 404, json: async () => ({ error: "Unknown book or format" }) };
    }) as unknown as typeof fetch;
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn, navigate: () => {} });
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
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/catalog/i));
  });

  it("establishes a session before loading the catalog", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (String(url).endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    renderLibrary({ apiUrl: "/api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(calls.indexOf("GET /api/session")).toBeLessThan(calls.indexOf("GET /catalog.json"));
    expect(calls.indexOf("GET /catalog.json")).toBeLessThan(calls.indexOf("GET /api/library"));
  });

  it("re-establishes the session and retries once when the catalog fetch is rejected", async () => {
    let catalogCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (String(url).endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      catalogCalls += 1;
      if (catalogCalls === 1) return { ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    renderLibrary({ apiUrl: "/api", getIdToken: async () => "tok", fetchFn });
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
      if (String(url).endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    const { unmount } = renderLibrary({ apiUrl: "/api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS + 10);
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(2);
    unmount();
    await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS + 10);
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(2);
  });

  it("re-establishes the session when the tab becomes visible again", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (String(url).endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
    }) as unknown as typeof fetch;
    renderLibrary({ apiUrl: "/api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(1);
    const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/session")).toHaveLength(2));
    visibilitySpy.mockRestore();
  });

  it("merges the overlay into categories and lists categories in the detail select", async () => {
    const fetchFn = fetchFor(catalog, undefined, { "GET /library$": () => ({
      ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ...overlay, bookCategories: { "1": "TTRPG" } }),
    }) });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /TTRPG/ })).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: /Security & Hacking/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const select = within(screen.getByRole("dialog", { hidden: true })).getByRole("combobox", { name: "Category" });
    expect(select).toHaveValue("TTRPG");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Fiction", "Security & Hacking", "TTRPG", "Suggest a new category…"]);
  });

  it("moves a book: PUTs, re-fetches the overlay, updates the grid and the open dialog, toasts", async () => {
    let bookCategories: Record<string, string> = {};
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/1/category$": (_u, init) => { bookCategories = { "1": JSON.parse(String(init?.body)).category }; return { ok: true, status: 204, headers: new Headers() }; },
      "GET /library$": () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ...overlay, bookCategories }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved to TTRPG"));
    expect(within(dialog).getByRole("combobox", { name: "Category" })).toHaveValue("TTRPG");
    expect(screen.getByRole("checkbox", { name: /TTRPG/ })).toBeInTheDocument();
    const put = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(put[1].headers.Authorization).toBe("Bearer tok");
  });

  it("toasts the API error and keeps the old category when the move fails", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/": () => ({ ok: false, status: 400, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "Unknown category" }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unknown category"));
    expect(within(dialog).getByRole("combobox", { name: "Category" })).toHaveValue("Security & Hacking");
  });

  it("suggests from the facet footer and shows pending chips; admin controls only with isAdmin", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "POST /suggestions$": () => ({ ok: true, status: 201, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ id: "s2" }) }),
    });
    const { rerender } = renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByText("Cookbooks · suggested by friend")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Accept Cookbooks" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Suggest a category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Poetry");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Suggested 'Poetry' — waiting for approval"));
    const post = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith("/suggestions"))!;
    expect(JSON.parse(post[1].body)).toEqual({ name: "Poetry" });
    rerender(<LibraryDataProvider apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} isAdmin /></LibraryDataProvider>);
    expect(screen.getByRole("button", { name: "Accept Cookbooks" })).toBeInTheDocument();
  });

  it("admin accepts a suggestion and adds a category directly", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "POST /suggestions/s1/accept$": () => ({ ok: true, status: 204, headers: new Headers() }),
      "POST /categories$": () => ({ ok: true, status: 201, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ name: "Essays" }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn, isAdmin: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept Cookbooks" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Accept Cookbooks" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Accepted 'Cookbooks'"));
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Category name" }), "Essays");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Added category 'Essays'"));
    const libraryCalls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/library"));
    expect(libraryCalls.length).toBe(3); // initial + one refetch per mutation
  });

  it("still renders read-only when the overlay fails, with a toast", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "GET /library$": () => ({ ok: false, status: 502, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Category editing is unavailable right now (boom)");
    expect(screen.queryByRole("button", { name: "Suggest a category" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    expect(within(screen.getByRole("dialog", { hidden: true })).queryByRole("combobox", { name: "Category" })).toBeNull();
  });

  it("keeps a selected facet checkbox visible at count 0 after the last matching book is moved away", async () => {
    let bookCategories: Record<string, string> = {};
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/1/category$": (_u, init) => { bookCategories = { "1": JSON.parse(String(init?.body)).category }; return { ok: true, status: 204, headers: new Headers() }; },
      "GET /library$": () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ...overlay, bookCategories }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("checkbox", { name: /Security & Hacking/ }));
    expect(screen.queryByRole("button", { name: /The Black Company/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved to TTRPG"));
    const checkbox = screen.getByRole("checkbox", { name: /Security & Hacking/ });
    expect(checkbox).toBeChecked();
    expect(checkbox.closest("label")).toHaveTextContent("0");
    expect(screen.getByText("No books match.")).toBeInTheDocument();
    await userEvent.click(checkbox);
    expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument();
  });

  it("toasts a partial-success message when the mutation succeeds but the overlay refetch fails", async () => {
    let libraryCalls = 0;
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/1/category$": () => ({ ok: true, status: 204, headers: new Headers() }),
      "GET /library$": () => {
        libraryCalls += 1;
        if (libraryCalls === 1) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
        return { ok: false, status: 502, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) };
      },
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved, but the list could not refresh (boom)"));
  });

  it("seeds the category filter from the query string", async () => {
    window.history.replaceState({}, "", "/?category=Fiction");
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog) });
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Attacking Network Protocols/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Fiction/ })).toBeChecked();
    window.history.replaceState({}, "", "/");
  });

  it("calls onChanged after a successful mutation, not after a failed one", async () => {
    const onChanged = vi.fn();
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/1/category$": () => ({ ok: true, status: 204, headers: new Headers() }),
      "PUT /books/2/category$": () => ({ ok: false, status: 400, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "nope" }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn, onChanged });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    await userEvent.selectOptions(within(screen.getByRole("dialog", { hidden: true })).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: /The Black Company/ }));
    await userEvent.selectOptions(within(screen.getByRole("dialog", { hidden: true })).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("nope"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("wires Send to Kindle to the provider and toasts the outcome", async () => {
    const kindle = { address: "jay_abc@kindle.com", sender: "library@lit.example.com", save: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue({ sentTo: "jay_abc@kindle.com", format: "epub" }) };
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog), kindle });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    await userEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Send to Kindle" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent to jay_abc@kindle.com — it usually arrives within a couple of minutes"));
    expect(kindle.send).toHaveBeenCalledWith("1", "epub");
    kindle.send.mockRejectedValueOnce(Object.assign(new Error("Kindle delivery isn't enabled for everyone yet"), { code: "not_enabled" }));
    await userEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Send to Kindle" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Kindle delivery isn't enabled for everyone yet"));
  });

  it("does not toast a no_address rejection, and lets it propagate so the inline form opens", async () => {
    const kindle = { address: "jay_abc@kindle.com", sender: "library@lit.example.com", save: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockRejectedValue(Object.assign(new Error("no_address"), { code: "no_address" })) };
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog), kindle });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    await userEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Send to Kindle" }));
    await waitFor(() => expect(within(screen.getByRole("dialog", { hidden: true })).getByRole("textbox", { name: "Your Kindle email" })).toBeInTheDocument());
    expect(screen.queryByRole("status")).toBeNull();
  });
});
