import { describe, expect, it, vi } from "vitest";
import { getKindleAddress, KindleError, saveKindleAddress, sendToKindle } from "./api";

function fetchWith(status: number, body?: unknown) {
  return vi.fn(async () => ({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body })) as unknown as typeof fetch;
}
const call = (f: typeof fetch) => { const m = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]; return { url: String(m[0]), init: m[1] as RequestInit }; };

describe("kindle api", () => {
  it("gets and saves the address", async () => {
    const g = fetchWith(200, { kindleAddress: "jay_abc@kindle.com" });
    expect(await getKindleAddress("/api", "tok", g)).toBe("jay_abc@kindle.com");
    expect(call(g).url).toBe("/api/kindle/address");
    const s = fetchWith(204);
    await saveKindleAddress("/api", "tok", "Jay_ABC@Kindle.com", s);
    expect(call(s).init.method).toBe("PUT");
    expect(call(s).init.body).toBe(JSON.stringify({ kindleAddress: "Jay_ABC@Kindle.com" }));
    await expect(saveKindleAddress("/api", "tok", "x@gmail.com", fetchWith(400, { error: "bad_address", message: "Enter your @kindle.com address" }))).rejects.toThrow("Enter your @kindle.com address");
  });
  it("sends and maps every error status to a KindleError code", async () => {
    const f = fetchWith(202, { sentTo: "jay_abc@kindle.com", format: "epub" });
    expect(await sendToKindle("/api", "tok", "b1", undefined, f)).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub" });
    expect(call(f).init.body).toBe(JSON.stringify({ bookId: "b1" }));
    const g = fetchWith(202, { sentTo: "x", format: "pdf" });
    await sendToKindle("/api", "tok", "b1", "pdf", g);
    expect(call(g).init.body).toBe(JSON.stringify({ bookId: "b1", format: "pdf" }));
    const cases: Array<[number, unknown, string]> = [
      [409, { error: "no_address" }, "no_address"],
      [413, { error: "too_large", bytes: 30, limit: 28 }, "too_large"],
      [400, { error: "unsupported", message: "Only EPUB and PDF" }, "unsupported"],
      [502, { error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" }, "not_enabled"],
      [502, { error: "failed", message: "SES down" }, "failed"],
      [500, { error: "internal" }, "failed"],
    ];
    for (const [status, body, code] of cases) {
      const err = await sendToKindle("/api", "tok", "b1", undefined, fetchWith(status, body)).catch((e) => e as KindleError);
      expect(err).toBeInstanceOf(KindleError);
      expect((err as KindleError).code).toBe(code);
    }
    const big = await sendToKindle("/api", "tok", "b1", undefined, fetchWith(413, { error: "too_large", bytes: 30, limit: 28 })).catch((e) => e as KindleError);
    expect((big as KindleError).details).toEqual({ bytes: 30, limit: 28 });
    const ne = await sendToKindle("/api", "tok", "b1", undefined, fetchWith(502, { error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" })).catch((e) => e as KindleError);
    expect((ne as KindleError).message).toBe("Kindle delivery isn't enabled for everyone yet");
  });
});
