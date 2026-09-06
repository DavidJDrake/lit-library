import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getKindleDevices, saveKindleDevices, sendToKindle, type DeviceInput, type KindleDevice } from "./api";

export interface KindleState {
  devices: KindleDevice[] | undefined; // undefined while loading
  defaultDeviceId: string | null;
  sender: string;
  save(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
  send(bookId: string, format?: string, deviceId?: string): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }>;
}

const Ctx = createContext<KindleState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; sender: string; children: ReactNode }

export function KindleProvider({ apiUrl, getIdToken, fetchFn = fetch, sender, children }: Props) {
  const [devices, setDevices] = useState<KindleDevice[] | undefined>(undefined);
  const [defaultDeviceId, setDefaultDeviceId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getKindleDevices(apiUrl, await getIdToken(), fetchFn);
        if (cancelled) return;
        setDevices(list.devices);
        setDefaultDeviceId(list.defaultDeviceId);
      } catch {
        // the send endpoint's no_address response still guards
        if (!cancelled) { setDevices([]); setDefaultDeviceId(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, getIdToken, fetchFn]);

  const save = useCallback(async (next: DeviceInput[], nextDefault?: string) => {
    const list = await saveKindleDevices(apiUrl, await getIdToken(), next, nextDefault, fetchFn);
    if (mounted.current) { setDevices(list.devices); setDefaultDeviceId(list.defaultDeviceId); }
  }, [apiUrl, getIdToken, fetchFn]);

  const send = useCallback(
    (bookId: string, format?: string, deviceId?: string) =>
      getIdToken().then((t) => sendToKindle(apiUrl, t, bookId, format, deviceId, fetchFn)),
    [apiUrl, getIdToken, fetchFn],
  );

  const value = useMemo<KindleState>(
    () => ({ devices, defaultDeviceId, sender, save, send }),
    [devices, defaultDeviceId, sender, save, send],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKindle(): KindleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKindle must be used inside <KindleProvider>");
  return ctx;
}
