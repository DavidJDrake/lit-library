import type { PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCacheForTests, decide, loadAllowlist } from "../lambda/pre-signup/index";

function event(email: string | undefined): PreSignUpTriggerEvent {
  return {
    version: "1", region: "us-east-1", userPoolId: "pool", userName: "google_123",
    callerContext: { awsSdkVersion: "x", clientId: "client" },
    triggerSource: "PreSignUp_ExternalProvider",
    request: { userAttributes: email ? { email } : {}, validationData: {} },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  } as PreSignUpTriggerEvent;
}

describe("decide", () => {
  it("auto-confirms allowlisted users", () => {
    const out = decide(event("Friend@Example.com"), ["friend@example.com"]);
    expect(out.response.autoConfirmUser).toBe(true);
    expect(out.response.autoVerifyEmail).toBe(true);
  });
  it("rejects everyone else with the invite-only message", () => {
    expect(() => decide(event("nope@example.com"), ["friend@example.com"]))
      .toThrow("This library is invite-only. Ask Jay to add your email address.");
    expect(() => decide(event(undefined), ["friend@example.com"])).toThrow(/invite-only/);
  });
});

describe("loadAllowlist", () => {
  beforeEach(() => _resetCacheForTests());
  it("fetches once and serves from cache afterwards", async () => {
    const fetchRaw = vi.fn().mockResolvedValue("a@x.com,b@y.com");
    expect(await loadAllowlist(fetchRaw)).toEqual(["a@x.com", "b@y.com"]);
    expect(await loadAllowlist(fetchRaw)).toEqual(["a@x.com", "b@y.com"]);
    expect(fetchRaw).toHaveBeenCalledTimes(1);
  });
});
