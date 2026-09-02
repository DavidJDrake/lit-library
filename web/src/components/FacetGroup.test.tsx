import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FacetGroup from "./FacetGroup";

const options = Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, count: 10 - i }));

describe("FacetGroup", () => {
  it("renders the first N options with counts and toggles the rest", async () => {
    render(<FacetGroup title="Publisher" options={options} selected={new Set()} onToggle={() => {}} initialLimit={3} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show all \(10\)/i }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(10);
  });
  it("reflects selection and reports toggles", async () => {
    const onToggle = vi.fn();
    render(<FacetGroup title="Format" options={[{ value: "epub", count: 3 }]} selected={new Set(["epub"])} onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", { name: /epub/i });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith("epub");
  });
});
