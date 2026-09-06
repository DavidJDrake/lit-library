import { describe, expect, it, vi } from "vitest";
import { logEvent } from "../lambda/shared/log";

describe("logEvent", () => {
  it("prints one JSON line with event, at, and the fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("kindle.sent", { email: "a@example.com", bytes: 12 }, () => new Date("2026-09-05T10:00:00.000Z"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ event: "kindle.sent", at: "2026-09-05T10:00:00.000Z", email: "a@example.com", bytes: 12 });
    spy.mockRestore();
  });
  it("does not let fields override event or at", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("x", { event: "nope", at: "nope" }, () => new Date("2026-09-05T10:00:00.000Z"));
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ event: "x", at: "2026-09-05T10:00:00.000Z" });
    spy.mockRestore();
  });
});
