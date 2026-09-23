import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import OrphanCorrections from "./OrphanCorrections";

describe("OrphanCorrections", () => {
  it("renders nothing when there are no orphan rows", () => {
    const { container } = render(<OrphanCorrections editionIds={[]} onRemove={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each orphan row with a count, and removes just the clicked one", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<OrphanCorrections editionIds={["abc123", "def456"]} onRemove={onRemove} />);
    expect(screen.getByText(/2 corrections/)).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByText("def456")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove abc123" }));
    expect(onRemove).toHaveBeenCalledWith(["abc123"]);
  });

  it("uses singular wording for exactly one orphan row", () => {
    render(<OrphanCorrections editionIds={["abc123"]} onRemove={vi.fn()} />);
    expect(screen.getByText(/1 correction\b/)).toBeInTheDocument();
  });

  it("disables only the removing row's button while onRemove is in flight, then re-enables it", async () => {
    let resolveOnRemove!: () => void;
    const onRemove = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveOnRemove = resolve; }));
    render(<OrphanCorrections editionIds={["abc123", "def456"]} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove abc123" }));
    expect(screen.getByRole("button", { name: "Remove abc123" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove def456" })).toBeEnabled();
    resolveOnRemove();
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove abc123" })).toBeEnabled());
  });
});
