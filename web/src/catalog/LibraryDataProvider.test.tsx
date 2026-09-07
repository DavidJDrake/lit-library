import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LibraryDataProvider, useLibraryData } from "./LibraryDataProvider";
import type { Catalog } from "./types";

const catalog: Catalog = { generatedAt: "t", books: [
  { id: "1", title: "Attacking Network Protocols", authors: [], description: null, category: "Security & Hacking", subjects: [], publisher: null, bundle: "b", year: null, formats: [], coverUrl: null, addedAt: "2026-01-01" },
] };
const overlay = {
  categories: [{ name: "Fiction", source: "seed" }], bookCategories: { "1": "Fiction" }, suggestions: [],
  readingStatuses: {}, downloaded: [] as string[],
};

function fetchWith(overlayStatus = 200) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).replace(/^https?:\/\/[^/]+/, "")}`);
    if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
    if (String(url).endsWith("/library")) return { ok: overlayStatus < 300, status: overlayStatus, headers: new Headers({ "content-type": "application/json" }), json: async () => (overlayStatus < 300 ? overlay : { error: "down" }) };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function Probe() {
  const d = useLibraryData();
  return (
    <div>
      <span data-testid="books">{d.books?.length ?? "none"}</span>
      <span data-testid="cat">{d.overlay?.bookCategories["1"] ?? "-"}</span>
      <span data-testid="title">{d.titleOf("1") ?? "?"}{d.titleOf("zz") ?? "?"}</span>
      <span data-testid="err">{d.loadError ?? ""}|{d.overlayError ?? ""}</span>
      <span data-testid="status1">{d.overlay?.readingStatuses["1"] ?? "-"}</span>
      <span data-testid="status2">{d.overlay?.readingStatuses["2"] ?? "-"}</span>
      <button onClick={() => void d.refreshOverlay()}>refresh</button>
      <button onClick={() => void d.setReadingStatus("1", "reading").catch(() => {})}>set-1-reading</button>
      <button onClick={() => void d.setReadingStatus("2", "finished").catch(() => {})}>set-2-finished</button>
      <button onClick={() => void d.setReadingStatus("1", null).catch(() => {})}>clear-1</button>
    </div>
  );
}

describe("LibraryDataProvider", () => {
  it("establishes the session, loads the catalog, then the overlay, and resolves titles", async () => {
    const { fetchFn, calls } = fetchWith();
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("cat")).toHaveTextContent("Fiction"));
    expect(screen.getByTestId("books")).toHaveTextContent("1");
    expect(screen.getByTestId("title")).toHaveTextContent("Attacking Network Protocols?");
    expect(calls.indexOf("GET /api/session")).toBeLessThan(calls.indexOf("GET /catalog.json"));
    expect(calls.indexOf("GET /catalog.json")).toBeLessThan(calls.indexOf("GET /api/library"));
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/library")).toHaveLength(2));
  });
  it("reports an overlay failure without touching the catalog", async () => {
    const { fetchFn } = fetchWith(502);
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("err")).toHaveTextContent("|down"));
    expect(screen.getByTestId("books")).toHaveTextContent("1");
    expect(screen.getByTestId("cat")).toHaveTextContent("-");
  });
});

describe("LibraryDataProvider.setReadingStatus", () => {
  function fetchWithStatusWrite(statusHandler: (url: string, init?: RequestInit) => { ok: boolean; status: number }) {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      if (u.endsWith("/catalog.json")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
      if (u.includes("/status")) {
        const r = statusHandler(u, init);
        return { ...r, headers: new Headers(), json: async () => ({ error: "nope" }) };
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    return fetchFn;
  }

  it("applies a status optimistically, before the request resolves", async () => {
    let resolveWrite!: (v: { ok: boolean; status: number; headers: Headers }) => void;
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      if (u.endsWith("/catalog.json")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
      return new Promise((resolve) => { resolveWrite = resolve; });
    }) as unknown as typeof fetch;
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("status1")).toHaveTextContent("-"));
    await userEvent.click(screen.getByRole("button", { name: "set-1-reading" }));
    // Applied immediately, before the (still in-flight) request settles.
    expect(screen.getByTestId("status1")).toHaveTextContent("reading");
    resolveWrite({ ok: true, status: 204, headers: new Headers() });
    await waitFor(() => expect(screen.getByTestId("status1")).toHaveTextContent("reading"));
  });

  it("clears a status optimistically", async () => {
    const fetchFn = fetchWithStatusWrite(() => ({ ok: true, status: 204 }));
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("status1")).toHaveTextContent("-"));
    await userEvent.click(screen.getByRole("button", { name: "set-1-reading" }));
    await waitFor(() => expect(screen.getByTestId("status1")).toHaveTextContent("reading"));
    await userEvent.click(screen.getByRole("button", { name: "clear-1" }));
    expect(screen.getByTestId("status1")).toHaveTextContent("-");
  });

  it("a failed write reverts only the book it touched, leaving a concurrent write for a different book alone", async () => {
    const pending: Array<(v: { ok: boolean; status: number; headers: Headers }) => void> = [];
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };
      if (u.endsWith("/catalog.json")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
      return new Promise((resolve) => { pending.push(resolve); });
    }) as unknown as typeof fetch;
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("status1")).toHaveTextContent("-"));

    // Both writes start (and apply optimistically) while their requests are still in flight.
    await userEvent.click(screen.getByRole("button", { name: "set-1-reading" })); // will fail
    await userEvent.click(screen.getByRole("button", { name: "set-2-finished" })); // will succeed
    expect(screen.getByTestId("status1")).toHaveTextContent("reading");
    expect(screen.getByTestId("status2")).toHaveTextContent("finished");
    expect(pending).toHaveLength(2);

    pending[0]({ ok: false, status: 400, headers: new Headers() }); // book 1's write fails
    pending[1]({ ok: true, status: 204, headers: new Headers() }); // book 2's write succeeds
    await waitFor(() => expect(screen.getByTestId("status1")).toHaveTextContent("-")); // reverted
    expect(screen.getByTestId("status2")).toHaveTextContent("finished"); // untouched by book 1's revert
  });
});
