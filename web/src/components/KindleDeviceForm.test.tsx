import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import KindleDeviceForm from "./KindleDeviceForm";

const setup = (onSubmit = vi.fn(async () => {}), onCancel?: () => void) => {
  render(<KindleDeviceForm sender="library@lit.example.com" submitLabel="Add device" onSubmit={onSubmit} onCancel={onCancel} />);
  return onSubmit;
};
const name = () => screen.getByRole("textbox", { name: "Name" });
const email = () => screen.getByRole("textbox", { name: "Your Kindle email" });

describe("KindleDeviceForm", () => {
  it("submits a trimmed name and a lowercased address", async () => {
    const onSubmit = setup();
    await userEvent.type(name(), "  Scribe  ");
    await userEvent.type(email(), "  Me_X@Kindle.com ");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Scribe", "me_x@kindle.com"));
  });

  it("rejects a missing name without calling onSubmit", async () => {
    const onSubmit = setup();
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give the device a name of 30 characters or fewer");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects a name over thirty characters", async () => {
    const onSubmit = setup();
    await userEvent.type(name(), "x".repeat(31));
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give the device a name of 30 characters or fewer");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects an address that is not @kindle.com", async () => {
    const onSubmit = setup();
    await userEvent.type(name(), "Scribe");
    await userEvent.type(email(), "me@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your @kindle.com address");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a rejection from the server and keeps what was typed", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("You already have a device with that name"); });
    setup(onSubmit);
    await userEvent.type(name(), "Scribe");
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a device with that name");
    expect(name()).toHaveValue("Scribe");
  });

  it("clears both fields after a successful submit", async () => {
    setup();
    await userEvent.type(name(), "Scribe");
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(name()).toHaveValue(""));
    expect(email()).toHaveValue("");
  });

  it("offers Cancel only when a handler is given", async () => {
    const onCancel = vi.fn();
    setup(vi.fn(async () => {}), onCancel);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
