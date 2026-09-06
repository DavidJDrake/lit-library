import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import KindleAddressForm from "./KindleAddressForm";

describe("KindleAddressForm", () => {
  it("validates client-side, submits the trimmed address, and shows the help link and sender", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<KindleAddressForm sender="library@lit.example.com" onSubmit={onSubmit} />);
    expect(screen.getByRole("link", { name: "Where do I find this?" })).toHaveAttribute("href", "https://www.amazon.com/hz/mycd/myx#/home/settings/payment");
    expect(screen.getByText(/library@lit\.example\.com/)).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Your Kindle email" });
    await userEvent.type(input, "jay@gmail.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your @kindle.com address");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "  Jay_ABC@Kindle.com ");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    expect(onSubmit).toHaveBeenCalledWith("Jay_ABC@Kindle.com");
  });
  it("requires a non-empty address when onCancel is present (send flow), but allows empty to clear on Settings", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(<KindleAddressForm sender="library@lit.example.com" onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your @kindle.com address");
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("supports an initial value, a custom submit label, cancel, and stays open when onSubmit rejects", async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error("nope"));
    render(<KindleAddressForm sender="s@x" initial="jay_abc@kindle.com" submitLabel="Save" onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByRole("textbox")).toHaveValue("jay_abc@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
