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

  it("caps expanded options at 50 and narrows them with a type-to-filter box", async () => {
    const manyOptions = Array.from({ length: 60 }, (_, i) => ({ value: `Author ${i}`, count: 60 - i }));
    render(<FacetGroup title="Author" options={manyOptions} selected={new Set()} onToggle={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /show all \(60\)/i }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(50);
    const filterInput = screen.getByRole("searchbox", { name: /filter author/i });
    await userEvent.type(filterInput, "Author 5");
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const cb of checkboxes) {
      const label = cb.closest("label")!;
      expect(label.textContent!.toLowerCase()).toContain("author 5");
    }
  });

  it("renders the footer after the options, even when there are no options", () => {
    const { rerender } = render(<FacetGroup title="Category" options={[{ value: "Fiction", count: 1 }]} selected={new Set()} onToggle={() => {}} footer={<span>FOOT</span>} />);
    expect(screen.getByText("FOOT")).toBeInTheDocument();
    rerender(<FacetGroup title="Category" options={[]} selected={new Set()} onToggle={() => {}} footer={<span>FOOT</span>} />);
    expect(screen.getByText("FOOT")).toBeInTheDocument();
    rerender(<FacetGroup title="Category" options={[]} selected={new Set()} onToggle={() => {}} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
