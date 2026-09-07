import { describe, expect, it } from "vitest";
import {
  generateOpdsToken, hashOpdsToken, isPlausibleOpdsToken, opdsReaderPk, opdsTokenPk, OPDS_READER_SK, OPDS_TOKEN_SK,
} from "../lambda/shared/opds-token";

describe("generateOpdsToken", () => {
  it("produces different values on each call", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateOpdsToken()));
    expect(seen.size).toBe(20);
  });

  it("produces a token that passes its own plausibility check", () => {
    for (let i = 0; i < 10; i++) expect(isPlausibleOpdsToken(generateOpdsToken())).toBe(true);
  });

  it("uses only URL-safe characters, so it drops into a query string unescaped", () => {
    const token = generateOpdsToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashOpdsToken", () => {
  it("is deterministic", () => {
    const token = generateOpdsToken();
    expect(hashOpdsToken(token)).toBe(hashOpdsToken(token));
  });

  it("gives different tokens different hashes", () => {
    expect(hashOpdsToken("a")).not.toBe(hashOpdsToken("b"));
  });

  it("never reproduces the token itself", () => {
    const token = generateOpdsToken();
    expect(hashOpdsToken(token)).not.toBe(token);
  });

  it("is a hex-encoded SHA-256 digest", () => {
    expect(hashOpdsToken("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("isPlausibleOpdsToken", () => {
  it("rejects missing, empty, malformed, and oversized values", () => {
    expect(isPlausibleOpdsToken(undefined)).toBe(false);
    expect(isPlausibleOpdsToken(null)).toBe(false);
    expect(isPlausibleOpdsToken("")).toBe(false);
    expect(isPlausibleOpdsToken(42)).toBe(false);
    expect(isPlausibleOpdsToken("has spaces")).toBe(false);
    expect(isPlausibleOpdsToken("has/slash")).toBe(false);
    expect(isPlausibleOpdsToken("a".repeat(201))).toBe(false);
  });

  it("accepts a well-formed token", () => {
    expect(isPlausibleOpdsToken("abcDEF123_-")).toBe(true);
  });
});

describe("table key helpers", () => {
  it("build the lookup key from a hash, and the reader key from a lowercased email", () => {
    expect(opdsTokenPk("deadbeef")).toBe("OPDSTOKEN#deadbeef");
    expect(OPDS_TOKEN_SK).toBe("TOKEN");
    expect(opdsReaderPk("Jay@Example.com")).toBe("USER#jay@example.com");
    expect(OPDS_READER_SK).toBe("OPDS");
  });
});
