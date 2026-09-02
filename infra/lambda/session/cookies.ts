import { getSignedCookies } from "@aws-sdk/cloudfront-signer";

export const SESSION_SECONDS = 12 * 60 * 60;
export const COOKIE_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax";
const NAMES = ["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id"] as const;

export function buildPolicy(siteDomain: string, expiresEpochSeconds: number): string {
  return JSON.stringify({
    Statement: [{ Resource: `https://${siteDomain}/*`, Condition: { DateLessThan: { "AWS:EpochTime": expiresEpochSeconds } } }],
  });
}

export function signSessionCookies(p: { siteDomain: string; keyPairId: string; privateKeyPem: string; now?: Date }): string[] {
  const now = p.now ?? new Date();
  const expires = Math.floor(now.getTime() / 1000) + SESSION_SECONDS;
  const signed = getSignedCookies({ keyPairId: p.keyPairId, privateKey: p.privateKeyPem, policy: buildPolicy(p.siteDomain, expires) });
  return NAMES.map((name) => `${name}=${signed[name]}; ${COOKIE_ATTRS}; Max-Age=${SESSION_SECONDS}`);
}

export function expiredCookies(): string[] {
  return NAMES.map((name) => `${name}=; ${COOKIE_ATTRS}; Max-Age=0`);
}
