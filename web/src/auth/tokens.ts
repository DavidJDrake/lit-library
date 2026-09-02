import type { AppConfig } from "../config";

export interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}

export function isExpired(t: Tokens, now = Date.now(), skewMs = 60_000): boolean {
  return now + skewMs >= t.expiresAt;
}

type FetchFn = typeof fetch;

interface TokenResponse { id_token: string; access_token: string; refresh_token?: string; expires_in: number }

async function tokenRequest(cfg: AppConfig, params: Record<string, string>, fetchFn: FetchFn): Promise<TokenResponse> {
  const res = await fetchFn(`${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }).toString(),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}

function toTokens(r: TokenResponse, refreshToken?: string): Tokens {
  return {
    idToken: r.id_token,
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? refreshToken,
    expiresAt: Date.now() + r.expires_in * 1000,
  };
}

export async function exchangeCode(cfg: AppConfig, code: string, verifier: string, fetchFn: FetchFn = fetch): Promise<Tokens> {
  const r = await tokenRequest(cfg, {
    grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier,
  }, fetchFn);
  return toTokens(r);
}

export async function refreshTokens(cfg: AppConfig, refreshToken: string, fetchFn: FetchFn = fetch): Promise<Tokens> {
  const r = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn);
  return toTokens(r, refreshToken);
}
