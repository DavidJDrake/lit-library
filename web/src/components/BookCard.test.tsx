import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../catalog/types";
import BookCard from "./BookCard";

const book: Book = {
  id: "1", title: "Attacking Network Protocols", authors: ["James Forshaw"], description: null,
  category: "Security & Hacking", subjects: [], publisher: null, bundle: "B", year: 2018,
  formats: [{ type: "epub", size: 1, s3Key: "a" }, { type: "pdf", size: 2, s3Key: "b" }],
  coverUrl: "/covers/1.webp", addedAt: "2026-01-01",
};

describe("BookCard", () => {
  it("shows cover, title, author, and format badges, and opens on click", async () => {
    const onOpen = vi.fn();
    render(<BookCard book={book} onOpen={onOpen} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", "/covers/1.webp");
    expect(screen.getByText("Attacking Network Protocols")).toBeInTheDocument();
    expect(screen.getByText("James Forshaw")).toBeInTheDocument();
    expect(screen.getByText("epub")).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(book);
  });
  it("renders a text placeholder when there is no cover", () => {
    render(<BookCard book={{ ...book, coverUrl: null }} onOpen={() => {}} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByText("Attacking Network Protocols")).toHaveLength(2); // placeholder + title
  });
});
