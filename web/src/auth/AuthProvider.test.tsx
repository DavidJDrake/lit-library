import React, { StrictMode, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { AuthProvider, useAuth } from "./AuthProvider";
import { savePkce, saveTokens } from "./storage";

const cfg: AppConfig = {
  cognitoDomain: "https://lit-x.auth.us-east-1.amazoncognito.com",
  clientId: "client123", apiUrl: "https://api.example.com", redirectUri: "http://localhost:5173/",
  kindleSender: "library@lit.example.com",
};

function jwt(payload: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

function Probe() {
  const a = useAuth();
  const [tokenResult, setTokenResult] = useState("");
  return (
    <div>
      <span data-testid="status">{a.status}</span>
      <span data-testid="email">{a.email ?? ""}</span>
      <span data-testid="admin">{String(a.isAdmin)}</span>
      <span data-testid="error">{a.error ?? ""}</span>
      <span data-testid="token-result">{tokenResult}</span>
      <button onClick={() => void a.signIn()}>signin</button>
      <button onClick={() => a.signOut()}>signout</button>
      <button onClick={() => {
        a.getIdToken().then(
          (t) => setTokenResult(t),
          (e: Error) => setTokenResult(`ERROR: ${e.message}`),
        );
      }}>getToken</button>
    </div>
  );
}

function setUrl(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

describe("AuthProvider", () => {
  beforeEach(() => setUrl(""));

  it("starts signed out with no stored tokens", async () => {
    render(<AuthProvider config={cfg}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut"));
  });

  it("signIn stores PKCE state and navigates to the hosted UI", async () => {
    const navigate = vi.fn();
    render(<AuthProvider config={cfg} navigate={navigate}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut"));
    await act(async () => { screen.getByText("signin").click(); });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const url = new URL(navigate.mock.calls[0][0]);
    expect(url.pathname).toBe("/oauth2/authorize");
    const stored = JSON.parse(window.sessionStorage.getItem("lit.pkce")!);
    expect(url.searchParams.get("state")).toBe(stored.state);
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
  });

  it("completes the callback: verifies state, exchanges the code, cleans the URL", async () => {
    savePkce({ verifier: "ver", state: "st1" });
    setUrl("?code=abc&state=st1");
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      id_token: jwt({ email: "user@example.com" }), access_token: "acc", refresh_token: "ref", expires_in: 3600,
    }) });
    render(<AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("email")).toHaveTextContent("user@example.com");
    expect(window.location.search).toBe("");
    expect(JSON.parse(window.sessionStorage.getItem("lit.tokens")!).accessToken).toBe("acc");
  });

  it("rejects a callback whose state does not match", async () => {
    savePkce({ verifier: "ver", state: "expected" });
    setUrl("?code=abc&state=wrong");
    const fetchFn = vi.fn();
    render(<AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut"));
    expect(screen.getByTestId("error")).toHaveTextContent(/state/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("surfaces the private-library message from an error callback", async () => {
    setUrl("?error=invalid_request&error_description=PreSignUp+failed+with+error+This+is+a+private+library.+Access+is+limited+to+authorized+accounts.+");
    render(<AuthProvider config={cfg}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut"));
    expect(screen.getByTestId("error")).toHaveTextContent("This is a private library. Access is limited to authorized accounts");
  });

  it("restores a stored session and refreshes when expired", async () => {
    saveTokens({ idToken: jwt({ email: "old@example.com" }), accessToken: "a", refreshToken: "ref", expiresAt: Date.now() - 1000 });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      id_token: jwt({ email: "old@example.com" }), access_token: "fresh", expires_in: 3600,
    }) });
    render(<AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(JSON.parse(window.sessionStorage.getItem("lit.tokens")!).accessToken).toBe("fresh");
  });

  it("signOut clears tokens and navigates to the logout URL", async () => {
    saveTokens({ idToken: jwt({ email: "x@example.com" }), accessToken: "a", expiresAt: Date.now() + 100_000 });
    const navigate = vi.fn();
    render(<AuthProvider config={cfg} navigate={navigate}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    await act(async () => { screen.getByText("signout").click(); });
    expect(window.sessionStorage.getItem("lit.tokens")).toBeNull();
    expect(new URL(navigate.mock.calls[0][0]).pathname).toBe("/logout");
  });

  it("handles code callback under StrictMode: ends signedIn and calls fetchFn once", async () => {
    savePkce({ verifier: "ver", state: "st1" });
    setUrl("?code=abc&state=st1");
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      id_token: jwt({ email: "strict@example.com" }), access_token: "acc", refresh_token: "ref", expires_in: 3600,
    }) });
    render(
      <StrictMode>
        <AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>
      </StrictMode>
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("email")).toHaveTextContent("strict@example.com");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("handles error callback under StrictMode: preserves the error message", async () => {
    setUrl("?error=invalid_request&error_description=PreSignUp+failed+with+error+This+is+a+private+library.+Access+is+limited+to+authorized+accounts.+");
    render(
      <StrictMode>
        <AuthProvider config={cfg}><Probe /></AuthProvider>
      </StrictMode>
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut"));
    expect(screen.getByTestId("error")).toHaveTextContent("This is a private library. Access is limited to authorized accounts");
  });

  it("exposes isAdmin from the cognito:groups claim", async () => {
    saveTokens({ idToken: jwt({ email: "a@example.com", "cognito:groups": ["admins"] }), accessToken: "a", expiresAt: Date.now() + 100_000 });
    render(<AuthProvider config={cfg} fetchFn={vi.fn() as unknown as typeof fetch}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("admin")).toHaveTextContent("true");
  });
  it("isAdmin is false without the admins group", async () => {
    saveTokens({ idToken: jwt({ email: "u@example.com", "cognito:groups": ["readers"] }), accessToken: "a", expiresAt: Date.now() + 100_000 });
    render(<AuthProvider config={cfg} fetchFn={vi.fn() as unknown as typeof fetch} navigate={() => {}}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("admin")).toHaveTextContent("false");
  });
  it("isAdmin becomes false after signing out", async () => {
    saveTokens({ idToken: jwt({ email: "a@example.com", "cognito:groups": ["admins"] }), accessToken: "a", expiresAt: Date.now() + 100_000 });
    render(<AuthProvider config={cfg} fetchFn={vi.fn() as unknown as typeof fetch} navigate={() => {}}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("admin")).toHaveTextContent("true");
    await act(async () => { screen.getByText("signout").click(); });
    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
    expect(screen.getByTestId("admin")).toHaveTextContent("false");
  });

  describe("getIdToken", () => {
    it("returns the current id token without refreshing when it is still valid", async () => {
      const idToken = jwt({ email: "x@example.com" });
      saveTokens({ idToken, accessToken: "a", expiresAt: Date.now() + 3_600_000 });
      const fetchFn = vi.fn();
      render(<AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>);
      await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
      await act(async () => { screen.getByText("getToken").click(); });
      await waitFor(() => expect(screen.getByTestId("token-result")).toHaveTextContent(idToken));
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("refreshes an expired stored token and returns the new id token", async () => {
      vi.useFakeTimers();
      try {
        const start = Date.now();
        saveTokens({ idToken: jwt({ email: "x@example.com" }), accessToken: "old", refreshToken: "ref", expiresAt: start + 120_000 });
        const freshIdToken = jwt({ email: "x@example.com" });
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
          id_token: freshIdToken, access_token: "fresh-access", refresh_token: "ref2", expires_in: 3600,
        }) });
        render(<AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByTestId("status")).toHaveTextContent("signedIn");
        expect(fetchFn).not.toHaveBeenCalled();

        vi.setSystemTime(start + 120_000); // now inside the 60s expiry skew
        await act(async () => {
          screen.getByText("getToken").click();
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("token-result")).toHaveTextContent(freshIdToken);
        expect(JSON.parse(window.sessionStorage.getItem("lit.tokens")!).accessToken).toBe("fresh-access");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects and signs the user out when the refresh fails", async () => {
      vi.useFakeTimers();
      try {
        const start = Date.now();
        saveTokens({ idToken: jwt({ email: "x@example.com" }), accessToken: "old", refreshToken: "ref", expiresAt: start + 120_000 });
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
        render(<AuthProvider config={cfg} fetchFn={fetchFn}><Probe /></AuthProvider>);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByTestId("status")).toHaveTextContent("signedIn");

        vi.setSystemTime(start + 120_000);
        await act(async () => {
          screen.getByText("getToken").click();
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
        expect(screen.getByTestId("error")).toHaveTextContent("Your session expired. Please sign in again.");
        expect(screen.getByTestId("token-result")).toHaveTextContent("ERROR: Session expired");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
