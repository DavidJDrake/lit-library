import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { expiredCookies, signSessionCookies } from "./cookies";

export interface Deps {
  loadPrivateKey: () => Promise<string>;
  now: () => Date;
}
export interface Env { siteDomain: string; keyPairId: string }

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps, env: Env): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  if (method === "DELETE") return { statusCode: 204, cookies: expiredCookies() };
  if (method !== "GET") return { statusCode: 405, body: "" };
  let privateKeyPem: string;
  try {
    privateKeyPem = await deps.loadPrivateKey();
  } catch (e) {
    // Never log the key/secret value itself — only the error's name and message.
    console.error("signing key load failed:", (e as Error).name, (e as Error).message);
    return { statusCode: 502, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Session unavailable" }) };
  }
  return {
    statusCode: 204,
    cookies: signSessionCookies({ siteDomain: env.siteDomain, keyPairId: env.keyPairId, privateKeyPem, now: deps.now() }),
  };
}

// ---- production wiring ----
let secrets: SecretsManagerClient | undefined;
let cachedKey: string | undefined;

async function loadPrivateKeyFromSecrets(): Promise<string> {
  if (cachedKey) return cachedKey;
  secrets ??= new SecretsManagerClient({});
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SIGNING_KEY_SECRET_NAME }));
  if (!out.SecretString) throw new Error("signing key secret is empty");
  cachedKey = out.SecretString;
  return cachedKey;
}

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) =>
  handle(event, { loadPrivateKey: loadPrivateKeyFromSecrets, now: () => new Date() },
    { siteDomain: process.env.SITE_DOMAIN ?? "", keyPairId: process.env.KEY_PAIR_ID ?? "" });
