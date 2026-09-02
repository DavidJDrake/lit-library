import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppConfig } from "../config";
import { buildAuthorizeUrl, buildLogoutUrl, codeChallenge, parseCallback, randomString } from "./pkce";
import { clearTokens, loadTokens, savePkce, saveTokens, takePkce } from "./storage";
import { decodeJwtPayload, exchangeCode, isExpired, refreshTokens, type Tokens } from "./tokens";

export interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  email?: string;
  error?: string;
  apiUrl: string;
  signIn(): Promise<void>;
  signOut(): void;
  getIdToken(): Promise<string>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

interface Props {
  config: AppConfig;
  children: ReactNode;
  fetchFn?: typeof fetch;
  navigate?: (url: string) => void;
}

type InitResult = { tokens: Tokens } | { error?: string };

function emailOf(t: Tokens): string | undefined {
  const email = decodeJwtPayload(t.idToken).email;
  return typeof email === "string" ? email : undefined;
}

const defaultNavigate = (u: string) => window.location.assign(u);

async function initialize(config: AppConfig, fetchFn: typeof fetch): Promise<InitResult> {
  const cb = parseCallback(window.location.search);
  if (cb.error) {
    window.history.replaceState({}, "", window.location.pathname);
    return { error: cb.error };
  }
  if (cb.code) {
    const pkce = takePkce();
    window.history.replaceState({}, "", window.location.pathname);
    if (!pkce || pkce.state !== cb.state) return { error: "Sign-in could not be verified (state mismatch). Please try again." };
    try {
      const t = await exchangeCode(config, cb.code, pkce.verifier, fetchFn);
      return { tokens: t };
    } catch (e) {
      return { error: `Sign-in failed: ${(e as Error).message}` };
    }
  }
  const stored = loadTokens();
  if (!stored) return { error: undefined };
  if (!isExpired(stored)) return { tokens: stored };
  if (!stored.refreshToken) return { error: undefined };
  try {
    const t = await refreshTokens(config, stored.refreshToken, fetchFn);
    return { tokens: t };
  } catch {
    return { error: undefined };
  }
}

export function AuthProvider({ config, children, fetchFn = fetch, navigate = defaultNavigate }: Props) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [email, setEmail] = useState<string>();
  const [error, setError] = useState<string>();
  const tokensRef = useRef<Tokens | undefined>(undefined);
  const initRef = useRef<Promise<InitResult> | null>(null);

  const adopt = useCallback((t: Tokens) => {
    tokensRef.current = t;
    saveTokens(t);
    setEmail(emailOf(t));
    setStatus("signedIn");
  }, []);

  const drop = useCallback((message?: string) => {
    tokensRef.current = undefined;
    clearTokens();
    setEmail(undefined);
    setError(message);
    setStatus("signedOut");
  }, []);

  useEffect(() => {
    let cancelled = false;
    initRef.current ??= initialize(config, fetchFn);
    void initRef.current.then((r) => {
      if (cancelled) return;
      if ("tokens" in r) adopt(r.tokens); else drop(r.error);
    });
    return () => { cancelled = true; };
  }, [config, fetchFn, adopt, drop]);

  const signIn = useCallback(async () => {
    const verifier = randomString(), state = randomString(16);
    savePkce({ verifier, state });
    navigate(buildAuthorizeUrl(config, { state, challenge: await codeChallenge(verifier) }));
  }, [config, navigate]);

  const signOut = useCallback(() => {
    drop();
    navigate(buildLogoutUrl(config));
  }, [config, navigate, drop]);

  const getIdToken = useCallback(async () => {
    const t = tokensRef.current;
    if (!t) throw new Error("Not signed in");
    if (!isExpired(t)) return t.idToken;
    if (!t.refreshToken) { drop("Your session expired. Please sign in again."); throw new Error("Session expired"); }
    try {
      const fresh = await refreshTokens(config, t.refreshToken, fetchFn);
      adopt(fresh);
      return fresh.idToken;
    } catch {
      drop("Your session expired. Please sign in again.");
      throw new Error("Session expired");
    }
  }, [config, fetchFn, adopt, drop]);

  const value = useMemo<AuthState>(() => ({ status, email, error, apiUrl: config.apiUrl, signIn, signOut, getIdToken }),
    [status, email, error, config.apiUrl, signIn, signOut, getIdToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
