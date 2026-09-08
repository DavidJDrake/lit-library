import { describe, expect, it } from "vitest";
import { callerEmail } from "../lambda/shared/caller";

describe("callerEmail", () => {
  it("lowercases, so one reader cannot end up under two partition keys", () => {
    expect(callerEmail({ email: "Jay@Example.com" })).toBe("jay@example.com");
    expect(callerEmail({ email: "JAY@EXAMPLE.COM" })).toBe("jay@example.com");
  });

  it("trims, so a stray space cannot become an invisible part of a key", () => {
    expect(callerEmail({ email: "  jay@example.com " })).toBe("jay@example.com");
    expect(callerEmail({ email: " Jay@Example.com" })).toBe("jay@example.com");
  });

  it("returns an empty string when the claim is missing or not a string, leaving the caller's own rejection in charge", () => {
    expect(callerEmail({})).toBe("");
    expect(callerEmail(undefined)).toBe("");
    expect(callerEmail({ email: null })).toBe("");
    expect(callerEmail({ email: "" })).toBe("");
    expect(callerEmail({ email: "   " })).toBe("");
  });

  it("is idempotent, so re-normalising a stored value cannot change it", () => {
    const once = callerEmail({ email: "Jay@Example.com" });
    expect(callerEmail({ email: once })).toBe(once);
  });
});
