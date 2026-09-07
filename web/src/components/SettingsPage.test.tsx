import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("shows a failure with a retry instead of an add form when the load fails", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your devices"));
    // The add form is what would compose a whole-list PUT, so it must not be reachable.
    expect(screen.queryByRole("heading", { name: "Add a device" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your devices" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("retrying a failed load shows the devices it finds", async () => {
    let attempt = 0;
    const fetchFn = vi.fn(async () => {
      if (attempt++ === 0) throw new Error("offline");
      return json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByDisplayValue("Scribe")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
