import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Link from "./Link";

beforeEach(() => window.history.replaceState({}, "", "/"));

describe("Link", () => {
  it("navigates in-app on a plain click and calls onClick", async () => {
    const onClick = vi.fn();
    render(<Link href="/notifications" onClick={onClick}>All</Link>);
    await userEvent.click(screen.getByRole("link", { name: "All" }));
    expect(window.location.pathname).toBe("/notifications");
    expect(onClick).toHaveBeenCalled();
  });
  it("leaves modifier clicks to the browser (default not prevented)", async () => {
    let prevented: boolean | undefined;
    render(<div onClick={(e) => { prevented = e.defaultPrevented; e.preventDefault(); }}><Link href="/notifications">All</Link></div>);
    const a = screen.getByRole("link", { name: "All" });
    const user = userEvent.setup();
    await user.keyboard("{Control>}");
    await user.click(a);
    await user.keyboard("{/Control}");
    expect(prevented).toBe(false);
    expect(window.location.pathname).toBe("/");
    await user.click(a);
    expect(prevented).toBe(true); // plain click: Link handled it
  });
});
