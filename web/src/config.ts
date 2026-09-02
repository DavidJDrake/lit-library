export interface AppConfig {
  cognitoDomain: string;
  clientId: string;
  apiUrl: string;
  redirectUri: string;
}

const KEYS = {
  cognitoDomain: "VITE_COGNITO_DOMAIN",
  clientId: "VITE_CLIENT_ID",
  apiUrl: "VITE_API_URL",
  redirectUri: "VITE_REDIRECT_URI",
} as const;

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = Object.values(KEYS).filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
  const strip = (s: string) => s.replace(/\/+$/, "");
  return {
    cognitoDomain: strip(env[KEYS.cognitoDomain]!),
    clientId: env[KEYS.clientId]!,
    apiUrl: strip(env[KEYS.apiUrl]!),
    redirectUri: env[KEYS.redirectUri]!,
  };
}

export const CONFIG: AppConfig = readConfig(import.meta.env as Record<string, string | undefined>);
