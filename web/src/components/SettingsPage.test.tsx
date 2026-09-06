import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider } from "../kindle/KindleProvider";
import SettingsPage from "./SettingsPage";

function server(address: string | null) {
  const puts: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { puts.push(String(init.body)); return { ok: true, status: 204, headers: new Headers() }; }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ kindleAddress: address }) };
  }) as unknown as typeof fetch;
  return { fetchFn, puts };
}
const mount = (fetchFn: typeof fetch) => render(
  <KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><SettingsPage /></KindleProvider>,
);

describe("SettingsPage", () => {
  it("shows the saved address, the sender, and the checklist; saves changes", async () => {
    const { fetchFn, puts } = server("jay_abc@kindle.com");
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue("jay_abc@kindle.com"));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getAllByText(/library@lit\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Personal Document Settings/)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "Your Kindle email" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "new_1@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([JSON.stringify({ kindleAddress: "new_1@kindle.com" })]));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
  it("shows the empty state while loading and for no address", async () => {
    mount(server(null).fetchFn);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue(""));
  });
  it("clears the Saved status after a later save fails", async () => {
    let fail = false;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        if (fail) return { ok: false, status: 500, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) };
        return { ok: true, status: 204, headers: new Headers() };
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ kindleAddress: "jay_abc@kindle.com" }) };
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue("jay_abc@kindle.com"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    fail = true;
    await userEvent.clear(screen.getByRole("textbox", { name: "Your Kindle email" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "new_2@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
