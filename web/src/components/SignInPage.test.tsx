import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SignInPage from "./SignInPage";

describe("SignInPage", () => {
  it("shows the Google button and calls onSignIn", async () => {
    const onSignIn = vi.fn();
    render(<SignInPage onSignIn={onSignIn} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(onSignIn).toHaveBeenCalled();
  });
  it("shows the error banner when given", () => {
    render(<SignInPage onSignIn={() => {}} error="This library is invite-only. Ask Jay to add your email address" />);
    expect(screen.getByRole("alert")).toHaveTextContent("invite-only");
  });
});
