import type { Tokens } from "./tokens";

const TOKENS_KEY = "lit.tokens";
const PKCE_KEY = "lit.pkce";

function read<T>(key: string): T | undefined {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked (private mode etc.) — the session simply won't persist
  }
}

function remove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export const loadTokens = () => read<Tokens>(TOKENS_KEY);
export const saveTokens = (t: Tokens) => write(TOKENS_KEY, t);
export const clearTokens = () => remove(TOKENS_KEY);

export const savePkce = (p: { verifier: string; state: string }) => write(PKCE_KEY, p);
export function takePkce(): { verifier: string; state: string } | undefined {
  const p = read<{ verifier: string; state: string }>(PKCE_KEY);
  remove(PKCE_KEY);
  return p;
}
