import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    unmount();
    window.history.replaceState({}, "", "/terms");
    render(<AuthProvider config={cfg}><App /></AuthProvider>);
    expect(screen.getByRole("heading", { name: "Terms" })).toBeInTheDocument();
  });
});
