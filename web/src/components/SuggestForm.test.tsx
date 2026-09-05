import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SuggestForm from "./SuggestForm";

describe("SuggestForm", () => {
  it("submits the trimmed name, then calls onCancel", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(<SuggestForm label="New category name" onSubmit={onSubmit} onCancel={onCancel} />);
    const input = screen.getByRole("textbox", { name: "New category name" });
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await userEvent.type(input, "  Cookbooks ");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith("Cookbooks");
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(input).toHaveAttribute("maxlength", "40");
  });
  it("stays open and re-enables when onSubmit rejects; Cancel calls onCancel", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("dup"));
    const onCancel = vi.fn();
    render(<SuggestForm label="New category name" onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.type(screen.getByRole("textbox"), "Fiction");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
