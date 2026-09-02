import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import type { AppConfig } from "./config";

const cfg: AppConfig = { cognitoDomain: "https://c", clientId: "id", apiUrl: "https://api", redirectUri: "http://localhost:5173/" };

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

  it("ends the CloudFront session before signing out", async () => {
    const jwt = (p: object) => { const b = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); return `${b({ alg: "none" })}.${b(p)}.sig`; };
    window.sessionStorage.setItem("lit.tokens", JSON.stringify({ idToken: jwt({ email: "u@example.com" }), accessToken: "a", expiresAt: Date.now() + 100_000 }));
    window.history.replaceState({}, "", "/");
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ generatedAt: "t", books: [] }) };
    }) as unknown as typeof fetch;
    const navigate = vi.fn();
    render(<AuthProvider config={cfg} fetchFn={fetchFn} navigate={navigate}><App fetchFn={fetchFn} /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const deleteCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1]?.method === "DELETE");
    expect(deleteCall?.[0]).toBe("https://api/session");
    expect(new URL(navigate.mock.calls[0][0]).pathname).toBe("/logout");
  });
});
