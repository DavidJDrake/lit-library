import { describe, expect, it } from "vitest";
import type { Catalog } from "../lambda/download/download";
import { buildOpdsFeed, OPDS_MEDIA_TYPE } from "../lambda/download/opds-feed";

const links = {
  self: "/api/opds?token=tok",
  acquisitionOf: (bookId: string, format: string) => `/api/opds/download/${bookId}/${format}?token=tok`,
};

describe("buildOpdsFeed", () => {
  it("produces a valid OPDS 2.0 JSON shape: metadata, a self link, and publications", () => {
    const catalog: Catalog = {
      books: [{ id: "b1", title: "Attacking Network Protocols", authors: ["James Forshaw"], formats: [
        { type: "epub", size: 10, s3Key: "k1" },
      ] }],
    };
    const feed = buildOpdsFeed(catalog, "My Library", links);
    expect(feed.metadata).toEqual({ title: "My Library" });
    expect(feed.links).toEqual([{ rel: "self", href: "/api/opds?token=tok", type: OPDS_MEDIA_TYPE }]);
    expect(feed.publications).toEqual([{
      metadata: { "@type": "http://schema.org/Book", title: "Attacking Network Protocols", author: [{ name: "James Forshaw" }] },
      links: [{ rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/b1/epub?token=tok", type: "application/epub+zip" }],
    }]);
  });

  it("lists every book in the catalogue", () => {
    const catalog: Catalog = {
      books: [
        { id: "b1", title: "One", formats: [{ type: "epub", size: 1, s3Key: "k1" }] },
        { id: "b2", title: "Two", formats: [{ type: "pdf", size: 2, s3Key: "k2" }] },
      ],
    };
    const feed = buildOpdsFeed(catalog, "Lib", links);
    expect(feed.publications).toHaveLength(2);
    expect(feed.publications.map((p) => p.metadata.title)).toEqual(["One", "Two"]);
  });

  it("emits one acquisition link per available format, with the right media type", () => {
    const catalog: Catalog = {
      books: [{ id: "b1", title: "Both", formats: [
        { type: "epub", size: 1, s3Key: "k1" }, { type: "pdf", size: 2, s3Key: "k2" },
      ] }],
    };
    const feed = buildOpdsFeed(catalog, "Lib", links);
    expect(feed.publications[0].links).toEqual([
      { rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/b1/epub?token=tok", type: "application/epub+zip" },
      { rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/b1/pdf?token=tok", type: "application/pdf" },
    ]);
  });

  it("tolerates a book with no authors field rather than throwing", () => {
    const catalog: Catalog = { books: [{ id: "b1", title: "Anon", formats: [] }] };
    const feed = buildOpdsFeed(catalog, "Lib", links);
    expect(feed.publications[0].metadata.author).toEqual([]);
  });

  it("an empty catalogue yields an empty publications list, not an error", () => {
    const feed = buildOpdsFeed({ books: [] }, "Lib", links);
    expect(feed.publications).toEqual([]);
  });
});

describe("buildOpdsFeed with editions", () => {
  it("lists one publication per edition, linking each format to its most recently added copy", () => {
    const catalog: Catalog = {
      books: [
        { id: "old", editionId: "old", addedAt: "2026-09-04", title: "The Works, Volume 1", authors: ["Edgar Allan Poe"],
          formats: [{ type: "epub", size: 1, s3Key: "k-old-epub" }, { type: "pdf", size: 2, s3Key: "k-old-pdf" }] },
        { id: "new", editionId: "old", addedAt: "2026-09-13", title: "The Works, Volume 1", authors: ["Edgar Allan Poe"],
          formats: [{ type: "epub", size: 1, s3Key: "k-new-epub" }] },
        { id: "solo", editionId: "solo", addedAt: "2026-09-13", title: "Eureka", formats: [{ type: "epub", size: 3, s3Key: "k" }] },
      ],
    };
    const feed = buildOpdsFeed(catalog, "Lit Library", links);
    expect(feed.publications).toHaveLength(2);
    expect(feed.publications[0].metadata.title).toBe("The Works, Volume 1");
    expect(feed.publications[0].links).toEqual([
      { rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/new/epub?token=tok", type: "application/epub+zip" },
      { rel: "http://opds-spec.org/acquisition", href: "/api/opds/download/old/pdf?token=tok", type: "application/pdf" },
    ]);
    expect(feed.publications[1].metadata.title).toBe("Eureka");
  });

  it("breaks a copy tie on the smallest id", () => {
    const catalog: Catalog = {
      books: [
        { id: "b", editionId: "a", addedAt: "2026-09-13", title: "T", formats: [{ type: "epub", size: 1, s3Key: "kb" }] },
        { id: "a", editionId: "a", addedAt: "2026-09-13", title: "T", formats: [{ type: "epub", size: 1, s3Key: "ka" }] },
      ],
    };
    expect(buildOpdsFeed(catalog, "L", links).publications[0].links[0].href).toBe("/api/opds/download/a/epub?token=tok");
  });

  it("treats entries without editionId as editions of their own", () => {
    const catalog: Catalog = {
      books: [
        { id: "x", title: "Same", formats: [{ type: "epub", size: 1, s3Key: "kx" }] },
        { id: "y", title: "Same", formats: [{ type: "epub", size: 1, s3Key: "ky" }] },
      ],
    };
    expect(buildOpdsFeed(catalog, "L", links).publications).toHaveLength(2);
  });
});
