import { describe, expect, it } from "vitest";
import { ADMIN_ROUTES, isAdmin, matchRoute, NAME_MAX, normalizeName, parseJsonBody } from "../lambda/library/lib";

describe("normalizeName", () => {
  it("trims and lowercases for comparison", () => {
    expect(normalizeName("  Cookbooks ")).toEqual({ name: "Cookbooks", nameLower: "cookbooks" });
  });
  it("rejects empty, non-string, too long, and control characters", () => {
    expect(normalizeName("")).toBeUndefined();
    expect(normalizeName("   ")).toBeUndefined();
    expect(normalizeName(42)).toBeUndefined();
    expect(normalizeName("x".repeat(NAME_MAX + 1))).toBeUndefined();
    expect(normalizeName("x".repeat(NAME_MAX))).toBeDefined();
    expect(normalizeName("bad\u0000name")).toBeUndefined();
    expect(normalizeName("bad\nname")).toBeUndefined();
  });
});

describe("isAdmin", () => {
  it("accepts the array and the bracketed-string claim forms", () => {
    expect(isAdmin({ "cognito:groups": ["admins"] })).toBe(true);
    expect(isAdmin({ "cognito:groups": ["readers", "admins"] })).toBe(true);
    expect(isAdmin({ "cognito:groups": "[admins]" })).toBe(true);
    expect(isAdmin({ "cognito:groups": "[readers admins]" })).toBe(true);
    expect(isAdmin({ "cognito:groups": "[readers, admins]" })).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isAdmin({})).toBe(false);
    expect(isAdmin({ "cognito:groups": ["readers"] })).toBe(false);
    expect(isAdmin({ "cognito:groups": "[administrators]" })).toBe(false);
    expect(isAdmin({ "cognito:groups": "admins-not-really" })).toBe(false);
  });
});

describe("parseJsonBody", () => {
  it("returns an object for a JSON object body, otherwise undefined", () => {
    expect(parseJsonBody('{"name":"x"}')).toEqual({ name: "x" });
    expect(parseJsonBody(undefined)).toBeUndefined();
    expect(parseJsonBody("nope")).toBeUndefined();
    expect(parseJsonBody("[1]")).toBeUndefined();
    expect(parseJsonBody("null")).toBeUndefined();
  });
});

describe("matchRoute", () => {
  it("matches the seven routes", () => {
    expect(matchRoute("GET", "/api/library")).toEqual({ kind: "overlay" });
    expect(matchRoute("PUT", "/api/books/abc123/category")).toEqual({ kind: "setBookCategory", bookId: "abc123" });
    expect(matchRoute("PUT", "/api/books/abc123/status")).toEqual({ kind: "setReadingStatus", bookId: "abc123" });
    expect(matchRoute("POST", "/api/suggestions")).toEqual({ kind: "suggest" });
    expect(matchRoute("POST", "/api/categories")).toEqual({ kind: "createCategory" });
    expect(matchRoute("POST", "/api/suggestions/s1/accept")).toEqual({ kind: "accept", id: "s1" });
    expect(matchRoute("POST", "/api/suggestions/s1/reject")).toEqual({ kind: "reject", id: "s1" });
  });
  it("rejects other methods and paths and decodes path segments", () => {
    expect(matchRoute("POST", "/api/library")).toBeUndefined();
    expect(matchRoute("GET", "/api/books/abc/category")).toBeUndefined();
    expect(matchRoute("PUT", "/api/books//category")).toBeUndefined();
    expect(matchRoute("GET", "/api/books/abc/status")).toBeUndefined();
    expect(matchRoute("POST", "/api/suggestions/s1/approve")).toBeUndefined();
    expect(matchRoute("PUT", "/api/books/a%20b/category")).toEqual({ kind: "setBookCategory", bookId: "a b" });
    expect(matchRoute("PUT", "/api/books/a%20b/status")).toEqual({ kind: "setReadingStatus", bookId: "a b" });
  });
  it("doesn't throw on a malformed percent-encoded segment", () => {
    expect(matchRoute("PUT", "/api/books/%/category")).toBeUndefined();
    expect(matchRoute("PUT", "/api/books/%/status")).toBeUndefined();
  });
  it("names the admin-only routes", () => {
    expect([...ADMIN_ROUTES].sort()).toEqual(["accept", "createCategory", "reject"]);
  });
});
