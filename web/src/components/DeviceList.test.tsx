import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { KindleDevice } from "../kindle/api";
import DeviceList from "./DeviceList";

const TWO: KindleDevice[] = [
  { id: "a1", label: "Scribe", address: "a@kindle.com" },
  { id: "b2", label: "Phone", address: "b@kindle.com" },
];
const mount = (devices: KindleDevice[], defaultDeviceId: string | null, onSave = vi.fn(async () => {})) => {
  render(<DeviceList devices={devices} defaultDeviceId={defaultDeviceId} sender="library@lit.example.com" onSave={onSave} />);
  return onSave;
};
const row = (label: string) => screen.getByRole("listitem", { name: label });

describe("DeviceList", () => {
  it("lists devices and marks the default", () => {
    mount(TWO, "b2");
    expect(screen.getByRole("heading", { name: "Your devices" })).toBeInTheDocument();
    expect(within(row("Phone")).getByText("default")).toBeInTheDocument();
    expect(within(row("Scribe")).queryByText("default")).not.toBeInTheDocument();
    expect(within(row("Scribe")).getByText("a@kindle.com")).toBeInTheDocument();
  });

  it("prompts for a name on an unnamed migrated device", () => {
    mount([{ id: "a1", label: "", address: "me_x@kindle.com" }], "a1");
    expect(screen.getByPlaceholderText("Name this device")).toBeInTheDocument();
    expect(screen.getByText("Name this device so you can tell it apart")).toBeInTheDocument();
  });

  it("saves a rename when the field is left", async () => {
    const onSave = mount(TWO, "b2");
    const field = within(row("Scribe")).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "Study Scribe");
    await userEvent.tab();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [{ id: "a1", label: "Study Scribe", address: "a@kindle.com" }, { id: "b2", label: "Phone", address: "b@kindle.com" }],
      "b2",
    ));
  });

  it("does not save when the name is unchanged", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.click(within(row("Scribe")).getByRole("textbox"));
    await userEvent.tab();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reverts and explains when a rename is rejected", async () => {
    const onSave = vi.fn(async () => { throw new Error("You already have a device with that name"); });
    mount(TWO, "b2", onSave);
    const field = within(row("Scribe")).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "Phone");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a device with that name");
    await waitFor(() => expect(field).toHaveValue("Scribe"));
  });

  it("makes another device the default", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.click(within(row("Scribe")).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [{ id: "a1", label: "Scribe", address: "a@kindle.com" }, { id: "b2", label: "Phone", address: "b@kindle.com" }],
      "a1",
    ));
  });

  it("removes a device", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.click(within(row("Scribe")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ id: "b2", label: "Phone", address: "b@kindle.com" }], "b2"));
  });

  it("promotes a new default when the current default is removed", async () => {
    const THREE: KindleDevice[] = [
      { id: "a1", label: "Scribe", address: "a@kindle.com" },
      { id: "b2", label: "Phone", address: "b@kindle.com" },
      { id: "c3", label: "Tablet", address: "c@kindle.com" },
    ];
    const onSave = vi.fn(async () => {});
    const { rerender } = render(
      <DeviceList devices={THREE} defaultDeviceId="a1" sender="library@lit.example.com" onSave={onSave} />,
    );
    await userEvent.click(within(row("Scribe")).getByRole("button", { name: "Remove" }));
    const remaining: KindleDevice[] = [
      { id: "b2", label: "Phone", address: "b@kindle.com" },
      { id: "c3", label: "Tablet", address: "c@kindle.com" },
    ];
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(remaining, undefined));
    // The server always assigns a default to a non-empty list; simulate its canonical
    // response (first remaining device promoted) reaching the list as new props.
    rerender(<DeviceList devices={remaining} defaultDeviceId="b2" sender="library@lit.example.com" onSave={onSave} />);
    expect(within(row("Phone")).getByText("default")).toBeInTheDocument();
  });

  it("disables the add form while a row mutation is in flight", async () => {
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    mount(TWO, "b2", onSave);
    await userEvent.click(within(row("Scribe")).getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add device" })).toBeDisabled();
    resolveSave();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).not.toBeDisabled());
  });

  it("adds a device through the form", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Tablet");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "c@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [...TWO, { label: "Tablet", address: "c@kindle.com" }],
      "b2",
    ));
  });

  it("shows an add failure only in the form and keeps the original devices", async () => {
    const onSave = vi.fn(async () => { throw new Error("That address is already saved"); });
    mount(TWO, "b2", onSave);
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Tablet");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That address is already saved");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Tablet");
    expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue("a@kindle.com");
    expect(within(row("Scribe")).getByText("a@kindle.com")).toBeInTheDocument();
    expect(within(row("Phone")).getByText("b@kindle.com")).toBeInTheDocument();
  });

  it("refuses an add while a migrated device is unnamed, and says so on that row", async () => {
    const migrated: KindleDevice[] = [
      { id: "a1", label: "", address: "me_x@kindle.com" },
    ];
    const onSave = mount(migrated, "a1");
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Phone");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "p@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    // The whole-list PUT would have been rejected for the *other* device's empty label.
    expect(onSave).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Name this device before adding another");
    expect(within(row("me_x@kindle.com")).getByRole("alert")).toBe(alert);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // The reader's own entry survives, ready to submit once the other device is named.
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Phone");
    expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue("p@kindle.com");
    expect(screen.getByPlaceholderText("Name this device")).toBeInTheDocument();
  });

  it("lets the add through once every device has a name", async () => {
    const onSave = vi.fn(async () => {});
    const { rerender } = render(
      <DeviceList devices={[{ id: "a1", label: "", address: "me_x@kindle.com" }]} defaultDeviceId="a1" sender="library@lit.example.com" onSave={onSave} />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Phone");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "p@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(onSave).not.toHaveBeenCalled();
    rerender(
      <DeviceList devices={[{ id: "a1", label: "Scribe", address: "me_x@kindle.com" }]} defaultDeviceId="a1" sender="library@lit.example.com" onSave={onSave} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [{ id: "a1", label: "Scribe", address: "me_x@kindle.com" }, { label: "Phone", address: "p@kindle.com" }],
      "a1",
    ));
  });

  it("hides the add form at the cap", () => {
    const five = Array.from({ length: 5 }, (_v, i) => ({ id: `i${i}`, label: `D${i}`, address: `d${i}@kindle.com` }));
    mount(five, "i0");
    expect(screen.queryByRole("button", { name: "Add device" })).not.toBeInTheDocument();
    expect(screen.getByText("You can save up to 5 devices")).toBeInTheDocument();
  });

  it("invites a first device when the list is empty", () => {
    mount([], null);
    expect(screen.getByRole("button", { name: "Add device" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
