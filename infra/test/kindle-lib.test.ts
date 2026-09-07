import { describe, expect, it } from "vitest";
import type { CatalogBook } from "../lambda/download/download";
import { buildMime, chooseFormat, classifySesError, CONTENT_TYPES, KINDLE_MAX_BYTES } from "../lambda/kindle/lib";

const book: CatalogBook = { id: "b1", title: "Attacking Network Protocols", formats: [
  { type: "pdf", size: 10, s3Key: "books/x.pdf" }, { type: "epub", size: 20, s3Key: "books/x.epub" }, { type: "cbz", size: 5, s3Key: "books/x.cbz" },
] };

describe("chooseFormat", () => {
  it("prefers epub, then pdf, honours an explicit request, and ignores unsupported types", () => {
    expect(chooseFormat(book)?.type).toBe("epub");
    expect(chooseFormat(book, "pdf")?.type).toBe("pdf");
    expect(chooseFormat(book, "cbz")).toBeUndefined();
    expect(chooseFormat({ ...book, formats: [book.formats[0]] })?.type).toBe("pdf");
    expect(chooseFormat({ ...book, formats: [book.formats[2]] })).toBeUndefined();
    expect(KINDLE_MAX_BYTES).toBe(28 * 1024 * 1024);
    expect(CONTENT_TYPES.epub).toBe("application/epub+zip");
  });
});

describe("buildMime", () => {
  it("builds a multipart message with one base64 attachment and CRLF endings", () => {
    const body = new TextEncoder().encode("PKhello");
    const raw = buildMime({ from: "library@lit.example.com", to: "jay@kindle.com", subject: "Attacking Network Protocols", filename: "Attacking Network Protocols.epub", contentType: "application/epub+zip", body, date: new Date("2026-09-05T10:00:00.000Z") });
    expect(raw.startsWith("From: library@lit.example.com\r\n")).toBe(true);
    expect(raw).toContain("To: jay@kindle.com\r\n");
    expect(raw).toContain("Subject: Attacking Network Protocols\r\n");
    expect(raw).toContain("MIME-Version: 1.0\r\n");
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="[^"]+"\r\n/);
    expect(raw).toContain('Content-Type: application/epub+zip; name="Attacking Network Protocols.epub"\r\n');
    expect(raw).toContain('Content-Disposition: attachment; filename="Attacking Network Protocols.epub"\r\n');
    expect(raw).toContain("Content-Transfer-Encoding: base64\r\n");
    expect(raw).toContain(Buffer.from(body).toString("base64"));
    expect(raw.replace(/\r\n/g, "").includes("\n")).toBe(false); // CRLF only
    expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });
  it("wraps long base64 at 76 columns and strips quotes from the filename", () => {
    const raw = buildMime({ from: "a@x.example", to: "b@kindle.com", subject: "S", filename: 'Say "Hi".pdf', contentType: "application/pdf", body: new Uint8Array(200), date: new Date(0) });
    const b64Lines = raw.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]{60,}$/.test(l));
    expect(b64Lines.length).toBeGreaterThan(1);
    expect(b64Lines.every((l) => l.length <= 76)).toBe(true);
    expect(raw).toContain('filename="Say Hi.pdf"');
  });
  it("RFC 2047-encodes a non-ASCII subject and RFC 2231-encodes a non-ASCII filename", () => {
    const raw = buildMime({ from: "a@x.example", to: "b@kindle.com", subject: "The Gods of Pegāna", filename: "Pegāna.epub", contentType: "application/epub+zip", body: new Uint8Array(10), date: new Date(0) });
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("The Gods of Pegāna", "utf8").toString("base64")}?=\r\n`);
    expect(raw).toContain('name="Peg_na.epub"');
    expect(raw).toContain('filename="Peg_na.epub"');
    expect(raw).toContain("filename*=UTF-8''Peg%C4%81na.epub");
  });
});

describe("classifySesError", () => {
  it("maps the sandbox 'not verified' rejection to not_enabled", () => {
    expect(classifySesError(Object.assign(new Error("Email address is not verified. The following identities failed"), { name: "MessageRejected" }))).toBe("not_enabled");
    expect(classifySesError(Object.assign(new Error("Daily sending quota exceeded"), { name: "MessageRejected" }))).toBe("failed");
    expect(classifySesError(new Error("network"))).toBe("failed");
  });
});
