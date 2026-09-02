import { describe, expect, it, vi } from "vitest";
import { requestDownload, startDownload } from "./download";

describe("requestDownload", () => {
  it("posts the book and format with the ID token", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: "https://s3/x", filename: "Book.epub", expiresIn: 900 }) });
    const r = await requestDownload("https://api.example.com", "tok", "abc", "epub", fetchFn);
    expect(r).toEqual({ url: "https://s3/x", filename: "Book.epub", expiresIn: 900 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.example.com/download");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ bookId: "abc", format: "epub" });
  });
  it("surfaces the server's error message", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "Unknown book or format" }) });
    await expect(requestDownload("https://api", "t", "x", "pdf", fetchFn)).rejects.toThrow("Unknown book or format");
  });
  it("falls back to a status message when the body is not JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("nope"); } });
    await expect(requestDownload("https://api", "t", "x", "pdf", fetchFn)).rejects.toThrow("Download failed: 502");
  });
});

describe("startDownload", () => {
  it("navigates via the injected navigate function when provided", () => {
    const navigate = vi.fn();
    startDownload("https://s3/x?sig=1", navigate);
    expect(navigate).toHaveBeenCalledWith("https://s3/x?sig=1");
  });

  it("defaults to appending a hidden iframe pointed at the url", () => {
    vi.useFakeTimers();
    try {
      startDownload("https://s3/x?sig=1");
      const iframe = document.querySelector("iframe[src='https://s3/x?sig=1']");
      expect(iframe).not.toBeNull();
      expect((iframe as HTMLIFrameElement).style.display).toBe("none");
      expect(document.body.contains(iframe)).toBe(true);

      vi.advanceTimersByTime(60_000);
      expect(document.body.contains(iframe)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
