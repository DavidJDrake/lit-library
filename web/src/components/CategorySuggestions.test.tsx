import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CategorySuggestions from "./CategorySuggestions";

const suggestions = [
  { id: "s1", name: "Cookbooks", bookId: "b1", suggestedBy: "friend@example.com", createdAt: "2026-09-04T00:00:00Z" },
  { id: "s2", name: "Poetry", suggestedBy: "x@y", createdAt: "2026-09-04T00:00:01Z" },
];
const noop = async () => {};

describe("CategorySuggestions", () => {
  it("lists pending chips with the suggester's local part and hides admin controls", () => {
    render(<CategorySuggestions suggestions={suggestions} isAdmin={false} onSuggest={noop} onCreate={noop} onResolve={noop} />);
    expect(screen.getByText("Cookbooks · suggested by friend")).toBeInTheDocument();
    expect(screen.getByText("Poetry · suggested by x")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept Cookbooks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add category" })).toBeNull();
  });
  it("opens the suggest form and submits a free-standing suggestion", async () => {
    const onSuggest = vi.fn().mockResolvedValue(undefined);
    render(<CategorySuggestions suggestions={[]} isAdmin={false} onSuggest={onSuggest} onCreate={noop} onResolve={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest a category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Poetry");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSuggest).toHaveBeenCalledWith("Poetry");
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
  it("admins can accept, reject, and add directly", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CategorySuggestions suggestions={suggestions} isAdmin onSuggest={noop} onCreate={onCreate} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept Cookbooks" }));
    expect(onResolve).toHaveBeenCalledWith("s1", "accept");
    await userEvent.click(screen.getByRole("button", { name: "Reject Poetry" }));
    expect(onResolve).toHaveBeenCalledWith("s2", "reject");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Category name" }), "Essays");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onCreate).toHaveBeenCalledWith("Essays");
  });
  it("disables only the resolving chip's buttons while onResolve is in flight, then re-enables them", async () => {
    let resolveOnResolve!: () => void;
    const onResolve = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveOnResolve = resolve; }));
    render(<CategorySuggestions suggestions={suggestions} isAdmin onSuggest={noop} onCreate={noop} onResolve={onResolve} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept Cookbooks" }));
    expect(onResolve).toHaveBeenCalledWith("s1", "accept");
    expect(screen.getByRole("button", { name: "Accept Cookbooks" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject Cookbooks" })).toBeDisabled();
    // The other, unrelated chip stays interactive.
    expect(screen.getByRole("button", { name: "Accept Poetry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject Poetry" })).toBeEnabled();

    resolveOnResolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept Cookbooks" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Reject Cookbooks" })).toBeEnabled();
  });
});
