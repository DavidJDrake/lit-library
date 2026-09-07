import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider, LOAD_FAILED_MESSAGE, useKindle } from "./KindleProvider";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

const saveErrors: string[] = [];
function Probe() {
  const k = useKindle();
  const state = k.loadFailed ? "failed" : k.devices === undefined ? "loading" : `${k.devices.length}:${k.defaultDeviceId ?? "-"}`;
  return (
    <div>
      <span data-testid="state">{state}</span>
      <button onClick={() => void k.save([{ label: "Phone", address: "b@kindle.com" }], undefined).catch((e: Error) => saveErrors.push(e.message))}>save</button>
      <button onClick={() => void k.reload().catch(() => {})}>reload</button>
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

  // Reversal of the old "a failed load is an empty list" behaviour: PUT replaces the whole
  // list, so an empty list read out of a failure is one add away from deleting every device.
  it("reports a failed load instead of pretending the list is empty", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("failed"));
  });

  it("refuses a save after a failed load, so no PUT can replace the stored list", async () => {
    saveErrors.length = 0;
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("failed"));
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(saveErrors).toEqual([LOAD_FAILED_MESSAGE]));
    const methods = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method);
    expect(methods).not.toContain("PUT");
  });

  it("reload recovers from a failed load and lets a save through again", async () => {
    saveErrors.length = 0;
    let attempt = 0;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json(200, { devices: [{ id: "srv1", label: "Phone", address: "b@kindle.com" }], defaultDeviceId: "srv1" });
      if (attempt++ === 0) throw new Error("offline");
      return json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("failed"));
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:a1"));
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:srv1"));
    expect(saveErrors).toEqual([]);
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

  it("keeps a save's result when a slower initial load resolves after it", async () => {
    let resolveLoad: (res: Response) => void = () => {};
    const loadPromise = new Promise<Response>((resolve) => { resolveLoad = resolve; });
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => init?.method === "PUT"
      ? json(200, { devices: [{ id: "srv1", label: "Phone", address: "b@kindle.com" }], defaultDeviceId: "srv1" })
      : loadPromise) as unknown as typeof fetch;
    mount(fetchFn);
    expect(screen.getByTestId("state")).toHaveTextContent("loading");

    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:srv1"));

    // The stale initial GET finally resolves, after the save already landed.
    resolveLoad(json(200, { devices: [], defaultDeviceId: null }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("state")).toHaveTextContent("1:srv1");
  });

  it("sends the version it last saw and adopts the one each save returns", async () => {
    const bodies: unknown[] = [];
    let put = 0;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return json(200, { devices: [], defaultDeviceId: null, version: "v1" });
      bodies.push(JSON.parse(String(init.body)));
      return json(200, { devices: [{ id: "srv1", label: "Phone", address: "b@kindle.com" }], defaultDeviceId: "srv1", version: `v${++put + 1}` });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("0:-"));
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:srv1"));
    // A second save in a row must carry the version the first one returned, not the stale one.
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect((bodies[0] as { version: string }).version).toBe("v1");
    expect((bodies[1] as { version: string }).version).toBe("v2");
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
