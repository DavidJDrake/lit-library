import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { decodeJwtPayload, exchangeCode, isExpired, refreshTokens, type Tokens } from "./tokens";

const cfg: AppConfig = {
  cognitoDomain: "https://lit-x.auth.us-east-1.amazoncognito.com",
  clientId: "client123", apiUrl: "https://api.example.com", redirectUri: "http://localhost:5173/",
};

function jwt(payload: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

function fakeFetch(body: object, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 300, status, json: async () => body });
}

describe("decodeJwtPayload", () => {
  it("decodes base64url payloads", () => {
    expect(decodeJwtPayload(jwt({ email: "a@b.c", exp: 1 }))).toEqual({ email: "a@b.c", exp: 1 });
  });
});

describe("isExpired", () => {
  const t: Tokens = { idToken: "x", accessToken: "y", expiresAt: 10_000 };
  it("is expired within the skew window", () => {
    expect(isExpired(t, 9_000, 60_000)).toBe(true);
    expect(isExpired(t, 9_000, 500)).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("posts the code grant and maps the response", async () => {
    const id = jwt({ email: "a@b.c" });
    const fetchFn = fakeFetch({ id_token: id, access_token: "acc", refresh_token: "ref", expires_in: 3600 });
    const before = Date.now();
    const t = await exchangeCode(cfg, "thecode", "theverifier", fetchFn);
    expect(t).toMatchObject({ idToken: id, accessToken: "acc", refreshToken: "ref" });
    expect(t.expiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://lit-x.auth.us-east-1.amazoncognito.com/oauth2/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: "authorization_code", client_id: "client123", code: "thecode",
      redirect_uri: "http://localhost:5173/", code_verifier: "theverifier",
    });
  });
  it("throws on a non-2xx response", async () => {
    await expect(exchangeCode(cfg, "c", "v", fakeFetch({ error: "invalid_grant" }, 400)))
      .rejects.toThrow("Token request failed: 400");
  });
});

describe("refreshTokens", () => {
  it("posts the refresh grant and keeps the refresh token", async () => {
    const fetchFn = fakeFetch({ id_token: jwt({}), access_token: "acc2", expires_in: 3600 });
    const t = await refreshTokens(cfg, "ref", fetchFn);
    expect(t.refreshToken).toBe("ref");
    expect(t.accessToken).toBe("acc2");
    expect(Object.fromEntries(new URLSearchParams(fetchFn.mock.calls[0][1].body))).toEqual({
      grant_type: "refresh_token", client_id: "client123", refresh_token: "ref",
    });
  });
});
