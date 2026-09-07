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
    const { container } = render(<BookCard book={book} onOpen={onOpen} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/covers/1.webp");
    expect(screen.getByText("Attacking Network Protocols")).toBeInTheDocument();
    expect(screen.getByText("James Forshaw")).toBeInTheDocument();
    expect(screen.getByText("epub")).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(book);
  });
  it("renders a text placeholder when there is no cover", () => {
    const { container } = render(<BookCard book={{ ...book, coverUrl: null }} onOpen={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("Attacking Network Protocols")).toHaveLength(2); // placeholder + title
  });
  it("still renders the (empty) authors line when a book has no authors, to keep card height uniform", () => {
    const { container } = render(<BookCard book={{ ...book, authors: [] }} onOpen={() => {}} />);
    expect(container.querySelector(".authors")).not.toBeNull();
    expect(container.querySelector(".authors")).toHaveTextContent("");
  });

  describe("reading status and downloaded indication", () => {
    it("shows nothing when neither is set", () => {
      const { container } = render(<BookCard book={book} onOpen={() => {}} />);
      expect(container.querySelector(".status-chip")).toBeNull();
      expect(container.querySelector(".downloaded-chip")).toBeNull();
    });
    it("shows a status chip with a readable label when a status is set", () => {
      const { container } = render(<BookCard book={{ ...book, readingStatus: "want to read" }} onOpen={() => {}} />);
      const chip = container.querySelector(".status-chip");
      expect(chip).toHaveTextContent("Want to read");
      expect(chip).toHaveAttribute("data-status", "want to read");
    });
    it("shows a downloaded chip, distinct from the status chip, marked as automatic", () => {
      const { container } = render(<BookCard book={{ ...book, downloaded: true }} onOpen={() => {}} />);
      const chip = container.querySelector(".downloaded-chip");
      expect(chip).toHaveTextContent("Downloaded");
      expect(chip).toHaveAttribute("title", expect.stringMatching(/automatically/i));
    });
    it("shows both at once for a book that is downloaded and also finished, since they are independent facts", () => {
      const { container } = render(<BookCard book={{ ...book, readingStatus: "finished", downloaded: true }} onOpen={() => {}} />);
      expect(container.querySelector(".status-chip")).toHaveTextContent("Finished");
      expect(container.querySelector(".downloaded-chip")).toHaveTextContent("Downloaded");
    });
    it("keeps both chips inside the fixed-aspect-ratio cover, out of the card's normal document flow", () => {
      // The chips must live inside .cover (sized purely by aspect-ratio, via CSS position:
      // absolute) rather than as new flow siblings in .meta/.badges, which is what would
      // change the card's height. This is a structural proxy for that CSS contract, since
      // jsdom (vitest's `css: false` config) never computes real layout.
      const { container } = render(<BookCard book={{ ...book, readingStatus: "reading", downloaded: true }} onOpen={() => {}} />);
      const cover = container.querySelector(".cover")!;
      expect(cover.querySelector(".status-chip")).not.toBeNull();
      expect(cover.querySelector(".downloaded-chip")).not.toBeNull();
      expect(container.querySelector(".meta .status-chip, .badges .status-chip")).toBeNull();
      expect(container.querySelector(".meta .downloaded-chip, .badges .downloaded-chip")).toBeNull();
    });
  });
});
