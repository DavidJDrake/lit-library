import type { AppConfig } from "../config";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(cfg: AppConfig, p: { state: string; challenge: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    identity_provider: "Google",
  });
  return `${cfg.cognitoDomain}/oauth2/authorize?${q}`;
}

export function buildLogoutUrl(cfg: AppConfig): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
  return `${cfg.cognitoDomain}/logout?${q}`;
}

const PRESIGNUP_PREFIX = "PreSignUp failed with error ";

export function parseCallback(search: string): { code?: string; state?: string; error?: string } {
  const q = new URLSearchParams(search);
  const description = q.get("error_description");
  const error = q.get("error");
  if (description || error) {
    let msg = (description ?? error ?? "").trim();
    if (msg.startsWith(PRESIGNUP_PREFIX)) msg = msg.slice(PRESIGNUP_PREFIX.length);
    return { error: msg.replace(/\.\s*$/, "").trim() };
  }
  const code = q.get("code"), state = q.get("state");
  return code ? { code, state: state ?? undefined } : {};
}
