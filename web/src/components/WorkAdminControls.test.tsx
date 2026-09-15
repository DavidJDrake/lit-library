import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Book, Edition } from "../catalog/types";
import WorkAdminControls from "./WorkAdminControls";

const edition = (id: string): Edition => ({
  id, title: "T", authors: [], description: null, publisher: null, year: null, coverUrl: null, subjects: [],
  category: "Fiction", formats: [], bundles: ["B"], copyIds: [id], addedAt: "2026-01-01", downloaded: false,
});
const work = (id: string, title: string, editions = [edition(id)]): Book => ({
  id, title, authors: ["Someone"], description: null, category: "Fiction", subjects: [], publisher: null, bundle: "B",
  year: 2020, formats: [], coverUrl: null, addedAt: "2026-01-01", editions,
});

const noop = async () => {};
const merged = async () => true;

describe("WorkAdminControls", () => {
  it("merges into a card found by search, never offering the card itself", async () => {
    const onMerge = vi.fn(merged);
    const card = work("a", "Learning DevOps");
    render(<WorkAdminControls card={card} works={[card, work("b", "Learning DevOps Second"), work("c", "Dune")]}
      selectedEditionId="a" canReset={false} busy={false} onMerge={onMerge} onSplit={noop} onReset={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Merge into…" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find the card to merge into" }), "Learning");
    expect(screen.queryByRole("button", { name: /^Learning DevOps — / })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Learning DevOps Second/ }));
    expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("keeps the merge picker open when the merge fails, and closes it when the merge succeeds", async () => {
    const onMerge = vi.fn(async () => false);
    const card = work("a", "Learning DevOps");
    render(<WorkAdminControls card={card} works={[card, work("b", "Learning DevOps Second")]}
      selectedEditionId="a" canReset={false} busy={false} onMerge={onMerge} onSplit={noop} onReset={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Merge into…" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find the card to merge into" }), "Learning");
    await userEvent.click(screen.getByRole("button", { name: /Learning DevOps Second/ }));
    expect(screen.getByRole("searchbox", { name: "Find the card to merge into" })).toBeInTheDocument();
    onMerge.mockImplementation(async () => true);
    await userEvent.click(screen.getByRole("button", { name: /Learning DevOps Second/ }));
    await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Find the card to merge into" })).toBeNull());
  });

  it("offers split only for a card with several editions, acting on the selected edition", async () => {
    const onSplit = vi.fn(noop);
    const { rerender } = render(<WorkAdminControls card={work("a", "T")} works={[]} selectedEditionId="a"
      canReset={false} busy={false} onMerge={merged} onSplit={onSplit} onReset={noop} />);
    expect(screen.queryByRole("button", { name: "Split this edition into its own card" })).toBeNull();
    rerender(<WorkAdminControls card={work("a", "T", [edition("a"), edition("b")])} works={[]} selectedEditionId="b"
      canReset={false} busy={false} onMerge={merged} onSplit={onSplit} onReset={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Split this edition into its own card" }));
    expect(onSplit).toHaveBeenCalledWith("b");
  });

  it("offers reset only when the card has corrections", async () => {
    const onReset = vi.fn(noop);
    const { rerender } = render(<WorkAdminControls card={work("a", "T")} works={[]} selectedEditionId="a"
      canReset={false} busy={false} onMerge={merged} onSplit={noop} onReset={onReset} />);
    expect(screen.queryByRole("button", { name: "Reset to automatic grouping" })).toBeNull();
    rerender(<WorkAdminControls card={work("a", "T")} works={[]} selectedEditionId="a"
      canReset busy={false} onMerge={merged} onSplit={noop} onReset={onReset} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset to automatic grouping" }));
    expect(onReset).toHaveBeenCalled();
  });
});
