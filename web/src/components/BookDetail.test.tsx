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
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} />);
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
    render(<BookDetail book={book} onClose={() => {}} onDownload={onDownload} />);
    await userEvent.click(screen.getByRole("button", { name: "Download EPUB (12.3 MB)" }));
    expect(onDownload).toHaveBeenCalledWith(book, "epub");
    expect(screen.getByRole("button", { name: /Download PDF/ })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: /Download PDF/ })).toBeEnabled());
  });
  it("closes via the close button", async () => {
    const onClose = vi.fn();
    render(<BookDetail book={book} onClose={onClose} onDownload={async () => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
