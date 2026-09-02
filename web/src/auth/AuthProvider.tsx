import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppConfig } from "../config";
import { buildAuthorizeUrl, buildLogoutUrl, codeChallenge, parseCallback, randomString } from "./pkce";
import { clearTokens, loadTokens, savePkce, saveTokens, takePkce } from "./storage";
import { decodeJwtPayload, exchangeCode, isExpired, refreshTokens, type Tokens } from "./tokens";

export interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  email?: string;
  error?: string;
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

function emailOf(t: Tokens): string | undefined {
  const email = decodeJwtPayload(t.idToken).email;
  return typeof email === "string" ? email : undefined;
}

export function AuthProvider({ config, children, fetchFn = fetch, navigate = (u) => window.location.assign(u) }: Props) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [email, setEmail] = useState<string>();
  const [error, setError] = useState<string>();
  const tokensRef = useRef<Tokens | undefined>(undefined);

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
    (async () => {
      const cb = parseCallback(window.location.search);
      if (cb.error) {
        window.history.replaceState({}, "", window.location.pathname);
        return drop(cb.error);
      }
      if (cb.code) {
        const pkce = takePkce();
        window.history.replaceState({}, "", window.location.pathname);
        if (!pkce || pkce.state !== cb.state) return drop("Sign-in could not be verified (state mismatch). Please try again.");
        try {
          const t = await exchangeCode(config, cb.code, pkce.verifier, fetchFn);
          if (!cancelled) adopt(t);
        } catch (e) {
          if (!cancelled) drop(`Sign-in failed: ${(e as Error).message}`);
        }
        return;
      }
      const stored = loadTokens();
      if (!stored) return drop();
      if (!isExpired(stored)) return adopt(stored);
      if (!stored.refreshToken) return drop();
      try {
        const t = await refreshTokens(config, stored.refreshToken, fetchFn);
        if (!cancelled) adopt(t);
      } catch {
        if (!cancelled) drop();
      }
    })();
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

  const value = useMemo<AuthState>(() => ({ status, email, error, signIn, signOut, getIdToken }),
    [status, email, error, signIn, signOut, getIdToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
