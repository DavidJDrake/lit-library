import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { isAllowed, parseAllowlist } from "./allowlist";

const CACHE_TTL_MS = 60_000;
const REJECT_MESSAGE = "This library is invite-only. Ask Jay to add your email address.";

let cache: { list: string[]; at: number } | undefined;
let ssm: SSMClient | undefined;

async function fetchFromSsm(): Promise<string> {
  ssm ??= new SSMClient({});
  const out = await ssm.send(new GetParameterCommand({ Name: process.env.ALLOWED_EMAILS_PARAM }));
  return out.Parameter?.Value ?? "";
}

export async function loadAllowlist(fetchRaw: () => Promise<string> = fetchFromSsm): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.list;
  const list = parseAllowlist(await fetchRaw());
  cache = { list, at: Date.now() };
  return list;
}

export function _resetCacheForTests(): void {
  cache = undefined;
}

export function decide(event: PreSignUpTriggerEvent, allowlist: string[]): PreSignUpTriggerEvent {
  // Only federated (Google) sign-ins may reach this far. Native Cognito sign-up
  // (PreSignUp_SignUp) and admin-created users (PreSignUp_AdminCreateUser) must be
  // rejected outright, even for an allowlisted email — otherwise anyone who knows a
  // friend's email can self-register a password account and mint their own tokens,
  // bypassing the "Google sign-in only" intent of the allowlist entirely.
  if (event.triggerSource !== "PreSignUp_ExternalProvider") {
    throw new Error(REJECT_MESSAGE);
  }
  if (!isAllowed(event.request.userAttributes.email, allowlist)) {
    throw new Error(REJECT_MESSAGE);
  }
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
}

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> =>
  decide(event, await loadAllowlist());
