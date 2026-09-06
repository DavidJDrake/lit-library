import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider, useKindle } from "./KindleProvider";

function server(address: string | null) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).replace(/^https?:\/\/[^/]+/, "")} ${init?.body ?? ""}`.trim());
    if (init?.method === "PUT") return { ok: true, status: 204, headers: new Headers() };
    if (init?.method === "POST") return { ok: true, status: 202, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ sentTo: "jay_abc@kindle.com", format: "epub" }) };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ kindleAddress: address }) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
function Probe() {
  const k = useKindle();
  return (
    <div>
      <span data-testid="addr">{k.address === undefined ? "loading" : String(k.address)}</span>
      <span data-testid="sender">{k.sender}</span>
      <button onClick={() => void k.save("jay_abc@kindle.com")}>save</button>
      <button onClick={() => void k.send("b1")}>send</button>
    </div>
  );
}

describe("KindleProvider", () => {
  it("loads the address on mount, exposes the sender, saves, and sends", async () => {
    const { fetchFn, calls } = server(null);
    render(<KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><Probe /></KindleProvider>);
    expect(screen.getByTestId("addr")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("addr")).toHaveTextContent("null"));
    expect(screen.getByTestId("sender")).toHaveTextContent("library@lit.example.com");
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("addr")).toHaveTextContent("jay_abc@kindle.com"));
    await userEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST /api/kindle/send"))).toBe(true));
    expect(calls[0]).toBe("GET /api/kindle/address");
  });
  it("treats a failed initial load as no address (the API's no_address path still guards)", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({}) })) as unknown as typeof fetch;
    render(<KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="s@x"><Probe /></KindleProvider>);
    await waitFor(() => expect(screen.getByTestId("addr")).toHaveTextContent("null"));
  });
});
