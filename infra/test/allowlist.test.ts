import { describe, expect, it } from "vitest";
import { isAllowed, parseAllowlist } from "../lambda/pre-signup/allowlist";

describe("parseAllowlist", () => {
  it("splits on commas, trims, lowercases, drops empties", () => {
    expect(parseAllowlist(" A@X.com, b@y.org ,,")).toEqual(["a@x.com", "b@y.org"]);
  });
  it("handles an empty parameter", () => {
    expect(parseAllowlist("")).toEqual([]);
  });
});

describe("isAllowed", () => {
  const list = ["jay@example.com"];
  it("matches case-insensitively", () => {
    expect(isAllowed("JAY@Example.COM", list)).toBe(true);
  });
  it("rejects unknown and missing emails", () => {
    expect(isAllowed("stranger@example.com", list)).toBe(false);
    expect(isAllowed(undefined, list)).toBe(false);
  });
});
