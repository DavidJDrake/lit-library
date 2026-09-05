import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LibraryDataProvider, useLibraryData } from "./LibraryDataProvider";
import type { Catalog } from "./types";

const catalog: Catalog = { generatedAt: "t", books: [
  { id: "1", title: "Attacking Network Protocols", authors: [], description: null, category: "Security & Hacking", subjects: [], publisher: null, bundle: "b", year: null, formats: [], coverUrl: null, addedAt: "2026-01-01" },
] };
const overlay = { categories: [{ name: "Fiction", source: "seed" }], bookCategories: { "1": "Fiction" }, suggestions: [] };

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
      <button onClick={() => void d.refreshOverlay()}>refresh</button>
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
