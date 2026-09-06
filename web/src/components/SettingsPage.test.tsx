import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider } from "../kindle/KindleProvider";
import SettingsPage from "./SettingsPage";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

const mount = (fetchFn: typeof fetch) => render(
  <KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><SettingsPage /></KindleProvider>,
);

describe("SettingsPage", () => {
  it("shows the saved devices and the sender", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your devices" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getAllByText(/library@lit\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Personal Document Settings/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Scribe")).toBeInTheDocument();
  });

  it("shows a loading state before the list arrives", () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    mount(fetchFn);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
