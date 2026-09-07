import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { KindleDevice } from "../kindle/api";
import SendToKindleButton from "./SendToKindleButton";

const TWO: KindleDevice[] = [
  { id: "a1", label: "Scribe", address: "a@kindle.com" },
  { id: "b2", label: "Phone", address: "b@kindle.com" },
];
const mount = (devices: KindleDevice[], defaultDeviceId: string | null, extra: Partial<Parameters<typeof SendToKindleButton>[0]> = {}) => {
  const onSend = vi.fn();
  render(<SendToKindleButton devices={devices} defaultDeviceId={defaultDeviceId} disabled={false} sending={false} onSend={onSend} {...extra} />);
  return onSend;
};

describe("SendToKindleButton", () => {
  it("names the only device and offers no menu", async () => {
    const onSend = mount([TWO[0]], "a1");
    expect(screen.queryByRole("button", { name: "Choose a device" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to Scribe" }));
    expect(onSend).toHaveBeenCalledWith("a1");
  });

  it("says Send to Kindle when there are no devices or the one device is unnamed", () => {
    mount([], null);
    expect(screen.getByRole("button", { name: "Send to Kindle" })).toBeInTheDocument();
    render(<SendToKindleButton devices={[{ id: "z", label: "", address: "z@kindle.com" }]} defaultDeviceId="z" disabled={false} sending={false} onSend={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Send to Kindle" })).toHaveLength(2);
  });

  it("sends to the default from the main half and names it", async () => {
    const onSend = mount(TWO, "b2");
    await userEvent.click(screen.getByRole("button", { name: "Send to Phone" }));
    expect(onSend).toHaveBeenCalledWith("b2");
  });

  it("opens the menu, marks the default, and sends to the chosen device", async () => {
    const onSend = mount(TWO, "b2");
    const caret = screen.getByRole("button", { name: "Choose a device" });
    expect(caret).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(caret);
    expect(caret).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Phone" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitem", { name: "Scribe" }));
    expect(onSend).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("closes the menu on Escape without sending", async () => {
    const onSend = mount(TWO, "b2");
    await userEvent.click(screen.getByRole("button", { name: "Choose a device" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the sending state and hides the caret while a send is in flight", () => {
    mount(TWO, "b2", { sending: true });
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Choose a device" })).not.toBeInTheDocument();
  });

  it("renders the PDF wording and honours disabled with a tooltip", () => {
    mount(TWO, "b2", { pdf: true, disabled: true, title: "Too large for Kindle delivery — download instead" });
    const btn = screen.getByRole("button", { name: "Send PDF to Phone" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Too large for Kindle delivery — download instead");
  });
});
