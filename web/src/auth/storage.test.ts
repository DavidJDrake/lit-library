import { describe, expect, it } from "vitest";
import { clearTokens, loadTokens, savePkce, saveTokens, takePkce } from "./storage";

describe("token storage", () => {
  it("round-trips and clears", () => {
    expect(loadTokens()).toBeUndefined();
    saveTokens({ idToken: "i", accessToken: "a", refreshToken: "r", expiresAt: 5 });
    expect(loadTokens()).toEqual({ idToken: "i", accessToken: "a", refreshToken: "r", expiresAt: 5 });
    clearTokens();
    expect(loadTokens()).toBeUndefined();
  });
  it("ignores corrupt entries", () => {
    window.sessionStorage.setItem("lit.tokens", "{not json");
    expect(loadTokens()).toBeUndefined();
  });
});

describe("pkce storage", () => {
  it("takePkce returns once then removes", () => {
    savePkce({ verifier: "v", state: "s" });
    expect(takePkce()).toEqual({ verifier: "v", state: "s" });
    expect(takePkce()).toBeUndefined();
  });
});
