import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Book } from "../catalog/types";
import BookDetail from "./BookDetail";

const book: Book = {
  id: "1", title: "Attacking Network Protocols", authors: ["James Forshaw"], description: "Deep dive.",
  category: "Security & Hacking", subjects: [], publisher: "No Starch Press", bundle: "Hacking by No Starch Press", year: 2018,
  formats: [{ type: "epub", size: 12.3 * 1024 * 1024, s3Key: "a" }, { type: "pdf", size: 2 * 1024 * 1024, s3Key: "b" }],
  coverUrl: null, addedAt: "2026-01-01",
};

beforeAll(() => {
  // jsdom does not implement <dialog> methods
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
});

describe("BookDetail", () => {
  it("renders metadata and one download button per format with sizes", () => {
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    expect(screen.getByRole("heading", { name: "Attacking Network Protocols" })).toBeInTheDocument();
    expect(screen.getByText(/James Forshaw/)).toBeInTheDocument();
    expect(screen.getByText(/No Starch Press · 2018/)).toBeInTheDocument();
    expect(screen.getByText("Deep dive.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF (2.0 MB)" })).toBeInTheDocument();
  });
  it("calls onDownload and disables buttons while in flight", async () => {
    let resolve!: () => void;
    const onDownload = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<BookDetail book={book} onClose={() => {}} onDownload={onDownload} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
    expect(onDownload).toHaveBeenCalledWith(book, "epub");
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: /Download PDF/ })).toBeEnabled());
  });
  it("closes via the close button", async () => {
    const onClose = vi.fn();
    render(<BookDetail book={book} onClose={onClose} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
  it("resets busy state when book changes", async () => {
    let resolve!: () => void;
    const onDownload = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const bookB: Book = { ...book, id: "2", title: "Another Book" };
    const { rerender } = render(<BookDetail book={book} onClose={() => {}} onDownload={onDownload} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeDisabled();
    rerender(<BookDetail book={bookB} onClose={() => {}} onDownload={onDownload} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    expect(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" })).toBeEnabled();
  });
  const cats = ["Fiction", "Security & Hacking", "TTRPG"];
  it("renders the category as text when no categories are available", () => {
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    expect(screen.queryByRole("combobox", { name: "Category" })).toBeNull();
    expect(screen.getByText(/Security & Hacking · Hacking by No Starch Press/)).toBeInTheDocument();
  });
  it("moves the book via the category select", async () => {
    const onChangeCategory = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={onChangeCategory} onSuggest={async () => {}} />);
    const select = screen.getByRole("combobox", { name: "Category" });
    expect(select).toHaveValue("Security & Hacking");
    await userEvent.selectOptions(select, "TTRPG");
    expect(onChangeCategory).toHaveBeenCalledWith(book, "TTRPG");
  });
  it("shows the suggest form from the last option and submits with the book id", async () => {
    const onSuggest = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={async () => {}} onSuggest={onSuggest} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "__suggest__");
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Cookbooks");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSuggest).toHaveBeenCalledWith("Cookbooks", "1");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull());
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("Security & Hacking");
  });
  it("closes the suggest form when a real category is picked instead", async () => {
    const onChangeCategory = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={onChangeCategory} onSuggest={async () => {}} />);
    const select = screen.getByRole("combobox", { name: "Category" });
    await userEvent.selectOptions(select, "__suggest__");
    expect(screen.getByRole("textbox", { name: "New category name" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "TTRPG");
    expect(onChangeCategory).toHaveBeenCalledWith(book, "TTRPG");
    expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull();
    expect(select).toHaveValue("Security & Hacking");
  });
});
