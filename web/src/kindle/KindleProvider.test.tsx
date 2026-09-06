import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider, useKindle } from "./KindleProvider";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

function Probe() {
  const k = useKindle();
  return (
    <div>
      <span data-testid="state">{k.devices === undefined ? "loading" : `${k.devices.length}:${k.defaultDeviceId ?? "-"}`}</span>
      <button onClick={() => void k.save([{ label: "Phone", address: "b@kindle.com" }], undefined)}>save</button>
    </div>
  );
}
const mount = (fetchFn: typeof fetch) => render(
  <KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><Probe /></KindleProvider>,
);

describe("KindleProvider", () => {
  it("loads the device list", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" })) as unknown as typeof fetch;
    mount(fetchFn);
    expect(screen.getByTestId("state")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:a1"));
  });

  it("treats a failed load as no devices, so the send path still guards", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("0:-"));
  });

  it("adopts the canonical list returned by a save", async () => {
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => init?.method === "PUT"
      ? json(200, { devices: [{ id: "srv1", label: "Phone", address: "b@kindle.com" }], defaultDeviceId: "srv1" })
      : json(200, { devices: [], defaultDeviceId: null })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("0:-"));
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:srv1"));
  });

  it("propagates a save failure to the caller", async () => {
    const errors: string[] = [];
    function Failing() {
      const k = useKindle();
      return <button onClick={() => void k.save([], undefined).catch((e: Error) => errors.push(e.message))}>go</button>;
    }
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => init?.method === "PUT"
      ? json(400, { error: "bad_label", message: "You already have a device with that name" })
      : json(200, { devices: [], defaultDeviceId: null })) as unknown as typeof fetch;
    render(<KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="s@x.com"><Failing /></KindleProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(errors).toEqual(["You already have a device with that name"]));
  });
});
