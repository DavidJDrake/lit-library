import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { currentPath, navigate, useRoute } from "./route";

beforeEach(() => window.history.replaceState({}, "", "/"));

describe("currentPath", () => {
  it("normalizes trailing slashes", () => {
    window.history.replaceState({}, "", "/notifications/");
    expect(currentPath()).toBe("/notifications");
    window.history.replaceState({}, "", "/");
    expect(currentPath()).toBe("/");
  });
});

describe("useRoute", () => {
  it("tracks navigate() and browser back/forward, and exposes the query string", () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current.path).toBe("/");
    act(() => result.current.navigate("/notifications"));
    expect(result.current.path).toBe("/notifications");
    expect(window.location.pathname).toBe("/notifications");
    act(() => navigate("/?category=Fiction"));
    expect(result.current.path).toBe("/");
    expect(result.current.search).toBe("?category=Fiction");
    act(() => { window.history.replaceState({}, "", "/terms"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.path).toBe("/terms");
  });
});
