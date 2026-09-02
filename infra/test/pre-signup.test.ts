import type { PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCacheForTests, decide, loadAllowlist } from "../lambda/pre-signup/index";

function event(
  email: string | undefined,
  triggerSource: PreSignUpTriggerEvent["triggerSource"] = "PreSignUp_ExternalProvider",
): PreSignUpTriggerEvent {
  return {
    version: "1", region: "us-east-1", userPoolId: "pool", userName: "google_123",
    callerContext: { awsSdkVersion: "x", clientId: "client" },
    triggerSource,
    request: { userAttributes: email ? { email } : {}, validationData: {} },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  } as PreSignUpTriggerEvent;
}

describe("decide", () => {
  it("auto-confirms allowlisted users", () => {
    const out = decide(event("User@Example.com"), ["user@example.com"]);
    expect(out.response.autoConfirmUser).toBe(true);
    expect(out.response.autoVerifyEmail).toBe(true);
  });
  it("rejects everyone else with the private-library message", () => {
    expect(() => decide(event("nope@example.com"), ["user@example.com"]))
      .toThrow("This is a private library. Access is limited to authorized accounts.");
    expect(() => decide(event(undefined), ["user@example.com"])).toThrow(/private library/);
  });
  it("rejects native Cognito sign-up even for an allowlisted email", () => {
    expect(() => decide(event("user@example.com", "PreSignUp_SignUp"), ["user@example.com"]))
      .toThrow(/private library/);
  });
  it("rejects admin-created users even for an allowlisted email", () => {
    expect(() => decide(event("user@example.com", "PreSignUp_AdminCreateUser"), ["user@example.com"]))
      .toThrow(/private library/);
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
