import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import type { AppConfig } from "./config";

const cfg: AppConfig = { cognitoDomain: "https://c", clientId: "id", apiUrl: "https://api", redirectUri: "http://localhost:5173/", kindleSender: "library@lit.example.com" };

describe("App", () => {
  it("shows the sign-in page when signed out", async () => {
    window.history.replaceState({}, "", "/");
    render(<AuthProvider config={cfg}><App /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument());
  });
  it("renders the privacy and terms pages without signing in", async () => {
    window.history.replaceState({}, "", "/privacy");
    const { unmount } = render(<AuthProvider config={cfg}><App /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument());
    unmount();
    window.history.replaceState({}, "", "/terms");
    render(<AuthProvider config={cfg}><App /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Terms" })).toBeInTheDocument());
  });

  it("ends the CloudFront session (no Authorization header) before signing out", async () => {
    const jwt = (p: object) => { const b = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return `${b({ alg: "none" })}.${b(p)}.sig`; };
    window.sessionStorage.setItem("lit.tokens", JSON.stringify({ idToken: jwt({ email: "u@example.com" }), accessToken: "a", expiresAt: Date.now() + 100_000 }));
    window.history.replaceState({}, "", "/");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/notifications/read")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ categories: [], bookCategories: {}, suggestions: [] }) };
      if (u.includes("/notifications")) {
        return {
          ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ items: [{ id: "2026-09-05T10:00:00.000Z#a", type: "books_added", payload: { count: 2, bookIds: [] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" }], unread: 1 }),
        };
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ generatedAt: "t", books: [] }) };
    }) as unknown as typeof fetch;
    const navigate = vi.fn();
    render(<AuthProvider config={cfg} fetchFn={fetchFn} navigate={navigate}><App fetchFn={fetchFn} /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const deleteCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1]?.method === "DELETE");
    expect(deleteCall?.[0]).toBe("https://api/session");
    expect(deleteCall?.[1]?.headers).toBeUndefined();
    expect(new URL(navigate.mock.calls[0][0]).pathname).toBe("/logout");
  });

  it("shows the bell when signed in and routes to the notifications page", async () => {
    const jwt = (p: object) => { const b = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return `${b({ alg: "none" })}.${b(p)}.sig`; };
    window.sessionStorage.setItem("lit.tokens", JSON.stringify({ idToken: jwt({ email: "u@example.com" }), accessToken: "a", expiresAt: Date.now() + 100_000 }));
    window.history.replaceState({}, "", "/");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/notifications/read")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      if (u.endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ categories: [], bookCategories: {}, suggestions: [] }) };
      if (u.includes("/notifications")) {
        return {
          ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ items: [{ id: "2026-09-05T10:00:00.000Z#a", type: "books_added", payload: { count: 2, bookIds: [] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" }], unread: 1 }),
        };
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ generatedAt: "t", books: [] }) };
    }) as unknown as typeof fetch;
    render(<AuthProvider config={cfg} fetchFn={fetchFn}><App fetchFn={fetchFn} /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    // Opening the popover marks the shown (unread) notification read — the badge clears
    // and a POST /notifications/read with its id goes out (204, not the earlier bug's 200).
    await waitFor(() => expect(document.querySelector(".bell-badge")).toBeNull());
    const readCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1]?.method === "POST" && String(c[0]).endsWith("/notifications/read"),
    );
    expect(readCall?.[1]?.body).toBe(JSON.stringify({ ids: ["2026-09-05T10:00:00.000Z#a"] }));
    await userEvent.click(screen.getByRole("link", { name: "See all notifications" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/notifications");
    await userEvent.click(screen.getByRole("link", { name: "Lit Library" }));
    await waitFor(() => expect(screen.getByRole("searchbox")).toBeInTheDocument());
  });
});
