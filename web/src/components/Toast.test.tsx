import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Toast from "./Toast";

describe("Toast", () => {
  it("renders nothing when there is no message", () => {
    const { container } = render(<Toast onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("auto-dismisses after 6 seconds", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<Toast message="Something went wrong" onDismiss={onDismiss} />);
      expect(screen.getByRole("status")).toHaveTextContent("Something went wrong");
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5999);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses immediately when clicked", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Toast message="Download failed" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("status"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
