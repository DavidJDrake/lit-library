import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COOKIE_ATTRS, SESSION_SECONDS, buildPolicy, expiredCookies, signSessionCookies } from "../lambda/session/cookies";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function cookieValue(cookies: string[], name: string): string {
  const c = cookies.find((s) => s.startsWith(`${name}=`))!;
  return c.slice(name.length + 1).split(";")[0];
}
// CloudFront's URL-safe base64: '+' -> '-', '=' -> '_', '/' -> '~'
function fromCloudFrontBase64(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");
}

describe("buildPolicy", () => {
  it("is a CloudFront custom policy for the whole site with an epoch expiry", () => {
    expect(JSON.parse(buildPolicy("lit.example.com", 1700000000))).toEqual({
      Statement: [{ Resource: "https://lit.example.com/*", Condition: { DateLessThan: { "AWS:EpochTime": 1700000000 } } }],
    });
  });
});

describe("signSessionCookies", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  const cookies = signSessionCookies({ siteDomain: "lit.example.com", keyPairId: "K2EXAMPLE", privateKeyPem, now });

  it("returns the three CloudFront cookies with the required attributes", () => {
    expect(cookies).toHaveLength(3);
    for (const c of cookies) expect(c).toContain(`; ${COOKIE_ATTRS}; Max-Age=${SESSION_SECONDS}`);
    expect(cookieValue(cookies, "CloudFront-Key-Pair-Id")).toBe("K2EXAMPLE");
  });

  it("embeds a policy that expires 12 hours from now", () => {
    const policy = JSON.parse(fromCloudFrontBase64(cookieValue(cookies, "CloudFront-Policy")).toString());
    expect(policy.Statement[0].Resource).toBe("https://lit.example.com/*");
    expect(policy.Statement[0].Condition.DateLessThan["AWS:EpochTime"]).toBe(now.getTime() / 1000 + SESSION_SECONDS);
  });

  it("signs the policy with RSA-SHA1 so CloudFront can verify it with the public key", () => {
    const policy = fromCloudFrontBase64(cookieValue(cookies, "CloudFront-Policy"));
    const signature = fromCloudFrontBase64(cookieValue(cookies, "CloudFront-Signature"));
    const verify = createVerify("RSA-SHA1");
    verify.update(policy);
    expect(verify.verify(publicKey, signature)).toBe(true);
  });
});

describe("expiredCookies", () => {
  it("clears all three cookies", () => {
    const cookies = expiredCookies();
    expect(cookies.map((c) => c.split("=")[0]).sort()).toEqual(["CloudFront-Key-Pair-Id", "CloudFront-Policy", "CloudFront-Signature"]);
    for (const c of cookies) expect(c).toContain(`; ${COOKIE_ATTRS}; Max-Age=0`);
  });
});
