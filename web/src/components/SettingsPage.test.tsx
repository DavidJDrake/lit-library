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

// The Kindle device list and the OPDS section load independently on mount. These tests
// exercise the device list only, so the OPDS endpoint always answers "no token yet"
// here — OpdsSection has its own dedicated test file.
function withOpdsStub(kindleFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/opds/token")) return json(200, { exists: false, createdAt: null });
    return kindleFetch(input, init);
  }) as unknown as typeof fetch;
}

const mount = (fetchFn: typeof fetch) => {
  const stubbed = withOpdsStub(fetchFn);
  return render(
    <KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={stubbed} sender="library@lit.example.com">
      <SettingsPage apiUrl="/api" getIdToken={async () => "tok"} fetchFn={stubbed} />
    </KindleProvider>,
  );
};

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

  it("shows the OPDS feed link section beneath the Kindle devices", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [], defaultDeviceId: null })) as unknown as typeof fetch;
    mount(fetchFn);
    expect(screen.getByRole("heading", { name: "E-reader feed (OPDS)" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No feed link yet.")).toBeInTheDocument());
  });
});
