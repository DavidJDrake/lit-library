import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getKindleAddress, saveKindleAddress, sendToKindle } from "./api";

export interface KindleState {
  address: string | null | undefined; // undefined while loading
  sender: string;
  save(address: string): Promise<void>;
  send(bookId: string, format?: string): Promise<{ sentTo: string; format: string }>;
}

const Ctx = createContext<KindleState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; sender: string; children: ReactNode }

export function KindleProvider({ apiUrl, getIdToken, fetchFn = fetch, sender, children }: Props) {
  const [address, setAddress] = useState<string | null | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const a = await getKindleAddress(apiUrl, await getIdToken(), fetchFn);
        if (!cancelled) setAddress(a);
      } catch {
        if (!cancelled) setAddress(null); // the send endpoint's no_address response still guards
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, getIdToken, fetchFn]);

  const save = useCallback(async (a: string) => {
    await saveKindleAddress(apiUrl, await getIdToken(), a, fetchFn);
    if (mounted.current) setAddress(a.trim() ? a.trim().toLowerCase() : null);
  }, [apiUrl, getIdToken, fetchFn]);

  const send = useCallback((bookId: string, format?: string) => getIdToken().then((t) => sendToKindle(apiUrl, t, bookId, format, fetchFn)),
    [apiUrl, getIdToken, fetchFn]);

  const value = useMemo<KindleState>(() => ({ address, sender, save, send }), [address, sender, save, send]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKindle(): KindleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKindle must be used inside <KindleProvider>");
  return ctx;
}
