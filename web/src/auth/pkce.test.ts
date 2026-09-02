import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import { buildAuthorizeUrl, buildLogoutUrl, codeChallenge, parseCallback, randomString } from "./pkce";

const cfg: AppConfig = {
  cognitoDomain: "https://lit-x.auth.us-east-1.amazoncognito.com",
  clientId: "client123",
  apiUrl: "https://api.example.com",
  redirectUri: "http://localhost:5173/",
};

describe("randomString", () => {
  it("is base64url without padding and differs per call", () => {
    const a = randomString(), b = randomString();
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
});

describe("codeChallenge", () => {
  it("computes the RFC 7636 S256 example", async () => {
    // Verifier and expected challenge from RFC 7636 Appendix B
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("buildAuthorizeUrl", () => {
  it("targets the hosted UI with PKCE, Google, and the exact scopes", () => {
    const url = new URL(buildAuthorizeUrl(cfg, { state: "st", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://lit-x.auth.us-east-1.amazoncognito.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", client_id: "client123", redirect_uri: "http://localhost:5173/",
      scope: "openid email profile", state: "st", code_challenge: "ch",
      code_challenge_method: "S256", identity_provider: "Google",
    });
  });
});

describe("buildLogoutUrl", () => {
  it("uses the logout endpoint with client_id and logout_uri", () => {
    const url = new URL(buildLogoutUrl(cfg));
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe("client123");
    expect(url.searchParams.get("logout_uri")).toBe("http://localhost:5173/");
  });
});

describe("parseCallback", () => {
  it("extracts code and state", () => {
    expect(parseCallback("?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it("turns Cognito's PreSignUp error into the human message", () => {
    const s = "?error=invalid_request&error_description=PreSignUp+failed+with+error+This+is+a+private+library.+Access+is+limited+to+authorized+accounts.+";
    expect(parseCallback(s)).toEqual({ error: "This is a private library. Access is limited to authorized accounts" });
  });
  it("falls back to the error code", () => {
    expect(parseCallback("?error=access_denied")).toEqual({ error: "access_denied" });
  });
  it("returns empty for a plain visit", () => {
    expect(parseCallback("")).toEqual({});
  });
});
