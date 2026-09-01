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
  if (!isAllowed(event.request.userAttributes.email, allowlist)) {
    throw new Error(REJECT_MESSAGE);
  }
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
}

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> =>
  decide(event, await loadAllowlist());
