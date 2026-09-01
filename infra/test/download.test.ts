import { describe, expect, it } from "vitest";
import { Catalog, downloadFilename, findFormat, parseRequest } from "../lambda/download/download";

const catalog: Catalog = {
  books: [
    { id: "abc", title: "Attacking Network Protocols", formats: [
      { type: "epub", size: 10, s3Key: "books/B/EPUB/anp.epub" },
      { type: "pdf", size: 20, s3Key: "books/B/PDF/anp.pdf" },
    ] },
  ],
};

describe("parseRequest", () => {
  it("accepts a well-formed body and lowercases the format", () => {
    expect(parseRequest('{"bookId":"abc","format":"EPUB"}')).toEqual({ bookId: "abc", format: "epub" });
  });
  it("rejects missing, malformed, and incomplete bodies", () => {
    expect(parseRequest(undefined)).toBeUndefined();
    expect(parseRequest("not json")).toBeUndefined();
    expect(parseRequest('{"bookId":"abc"}')).toBeUndefined();
    expect(parseRequest('{"bookId":"","format":"epub"}')).toBeUndefined();
    expect(parseRequest('{"bookId":123,"format":"epub"}')).toBeUndefined();
  });
});

describe("findFormat", () => {
  it("returns the book and the requested format", () => {
    const hit = findFormat(catalog, { bookId: "abc", format: "pdf" });
    expect(hit?.format.s3Key).toBe("books/B/PDF/anp.pdf");
    expect(hit?.book.title).toBe("Attacking Network Protocols");
  });
  it("returns undefined for unknown book or format", () => {
    expect(findFormat(catalog, { bookId: "zzz", format: "pdf" })).toBeUndefined();
    expect(findFormat(catalog, { bookId: "abc", format: "cbz" })).toBeUndefined();
  });
});

describe("downloadFilename", () => {
  it("strips unsafe characters, collapses whitespace, and appends the extension", () => {
    expect(downloadFilename('Hack: The "Art" of Exploitation / 2e', "pdf", "abc")).toBe("Hack The Art of Exploitation 2e.pdf");
  });
  it("falls back to 'book-<bookId>' and caps length", () => {
    expect(downloadFilename("///", "epub", "abc")).toBe("book-abc.epub");
    expect(downloadFilename("x".repeat(500), "epub", "abc")).toBe("x".repeat(100) + ".epub");
  });
});
