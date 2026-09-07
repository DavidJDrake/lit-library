import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpdsSection from "./OpdsSection";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

const noContent = () => ({ ok: true, status: 204, headers: new Headers(), json: async () => ({}) }) as unknown as Response;

function mount(fetchFn: typeof fetch) {
  return render(<OpdsSection apiUrl="/api" getIdToken={async () => "id-tok"} fetchFn={fetchFn} />);
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("OpdsSection", () => {
  it("shows no feed link before one has been generated", async () => {
    const fetchFn = vi.fn(async () => json(200, { exists: false, createdAt: null })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByText("No feed link yet.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Generate feed link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows an existing token's creation date, with regenerate and revoke, but never the token itself", async () => {
    const fetchFn = vi.fn(async () => json(200, { exists: true, createdAt: "2026-09-06T12:00:00.000Z" })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByText(/A feed link was created on/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/token=/)).toBeNull();
  });

  it("says plainly that the link should be treated like a password", async () => {
    const fetchFn = vi.fn(async () => json(200, { exists: false, createdAt: null })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByText(/treat it like a password/i)).toBeInTheDocument());
  });

  it("generating shows the full URL once, with a copy control", async () => {
    let posted = false;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") { posted = true; return json(201, { token: "the-plaintext-token", createdAt: "2026-09-07T00:00:00.000Z" }); }
      return json(200, posted ? { exists: true, createdAt: "2026-09-07T00:00:00.000Z" } : { exists: false, createdAt: null });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate feed link" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate feed link" }));
    await waitFor(() => expect(screen.getByDisplayValue(/token=the-plaintext-token/)).toBeInTheDocument());
    expect(screen.getByText(/won't be shown again/)).toBeInTheDocument();
  });

  it("copies the link to the clipboard", async () => {
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(201, { token: "copy-me-token", createdAt: "2026-09-07T00:00:00.000Z" });
      return json(200, { exists: false, createdAt: null });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate feed link" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate feed link" }));
    await waitFor(() => expect(screen.getByDisplayValue(/copy-me-token/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("copy-me-token"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument());
  });

  it("revoking clears the token and shows no feed link", async () => {
    let revoked = false;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { revoked = true; return noContent(); }
      return json(200, revoked ? { exists: false, createdAt: null } : { exists: true, createdAt: "2026-09-06T12:00:00.000Z" });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByText("No feed link yet.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("does not render the token again after a reload, even if one was just generated", async () => {
    let posted = false;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") { posted = true; return json(201, { token: "ephemeral-token", createdAt: "2026-09-07T00:00:00.000Z" }); }
      return json(200, posted ? { exists: true, createdAt: "2026-09-07T00:00:00.000Z" } : { exists: false, createdAt: null });
    }) as unknown as typeof fetch;
    const { unmount } = mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate feed link" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate feed link" }));
    await waitFor(() => expect(screen.getByDisplayValue(/ephemeral-token/)).toBeInTheDocument());
    unmount();
    // A fresh mount is what "reload" means here: a new component instance reading only
    // the server's status, which never carries the plaintext token.
    mount(fetchFn);
    await waitFor(() => expect(screen.getByText(/A feed link was created on/)).toBeInTheDocument());
    expect(screen.queryByDisplayValue(/ephemeral-token/)).toBeNull();
    expect(screen.queryByText(/won't be shown again/)).toBeNull();
  });

  it("shows a retry control when the initial status load fails, and does not claim there is no token", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("No feed link yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows an error and keeps existing state when generating fails", async () => {
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(500, { error: "internal" });
      return json(200, { exists: false, createdAt: null });
    }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate feed link" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate feed link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("No feed link yet.")).toBeInTheDocument();
  });
});
