import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface InfraConfig {
  account: string;
  region: string;
  siteDomain: string;
  hostedZoneName: string;
  hostedZoneId: string;
  cognitoDomainPrefix: string;
  googleOAuthSecretName: string;
  signingKeySecretName: string;
  allowedEmailsParam: string;
  seedAllowedEmail: string;
  localDevOrigin: string;
  cloudfrontPublicKeyPem: string;
  alarmEmail: string;
}

const KEYS: (keyof InfraConfig)[] = [
  "account", "region", "siteDomain", "hostedZoneName", "hostedZoneId", "cognitoDomainPrefix",
  "googleOAuthSecretName", "signingKeySecretName", "allowedEmailsParam", "seedAllowedEmail",
  "localDevOrigin", "cloudfrontPublicKeyPem", "alarmEmail",
];

export const EXAMPLE_CONFIG_PATH = path.join(__dirname, "../config.example.json");
export const LOCAL_CONFIG_PATH = path.join(__dirname, "../config.local.json");

export function loadConfig(file: string = process.env.EBOOK_SHARE_CONFIG ?? LOCAL_CONFIG_PATH): InfraConfig {
  if (!existsSync(file)) {
    throw new Error(`Config file not found: ${file} — copy config.example.json to config.local.json and fill it in`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<InfraConfig>;
  const missing = KEYS.filter((k) => !raw[k]);
  if (missing.length) throw new Error(`Missing config keys: ${missing.join(", ")}`);
  if (path.resolve(file) !== path.resolve(EXAMPLE_CONFIG_PATH)) {
    const example = JSON.parse(readFileSync(EXAMPLE_CONFIG_PATH, "utf8")) as Partial<InfraConfig>;
    if (raw.cloudfrontPublicKeyPem === example.cloudfrontPublicKeyPem) {
      throw new Error("config.local.json still contains the EXAMPLE public key — run scripts/make-signing-key.sh first");
    }
  }
  return raw as InfraConfig;
}
