import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getKindleDevices, saveKindleDevices, sendToKindle, type DeviceInput, type KindleDevice } from "./api";

/** Shown wherever a whole-list save is refused because the list was never read. */
export const LOAD_FAILED_MESSAGE = "Couldn't load your devices — reload the page and try again";

export interface KindleState {
  devices: KindleDevice[] | undefined; // undefined while loading, and after a failed load
  defaultDeviceId: string | null;
  loadFailed: boolean; // true only once a load has actually failed; devices stays undefined
  sender: string;
  /** Re-reads the list; resolves with it, rejects if the read fails. */
  reload(): Promise<KindleDevice[]>;
  save(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
  send(bookId: string, format?: string, deviceId?: string): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }>;
}

const Ctx = createContext<KindleState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; sender: string; children: ReactNode }

export function KindleProvider({ apiUrl, getIdToken, fetchFn = fetch, sender, children }: Props) {
  const [devices, setDevices] = useState<KindleDevice[] | undefined>(undefined);
  const [defaultDeviceId, setDefaultDeviceId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const mounted = useRef(true);
  // Every request that will write state (the initial load and each save) claims the
  // next generation before it awaits anything. A response is applied only if its
  // generation is still the latest, so a slow load resolving after a save can't
  // clobber the save's fresher result, and overlapping saves settle in start order.
  const generation = useRef(0);
  // Read synchronously by save(), which must refuse before a caller can compose a
  // whole-list replacement out of a list the server never gave us.
  const failed = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const reload = useCallback(async (): Promise<KindleDevice[]> => {
    const gen = ++generation.current;
    try {
      const list = await getKindleDevices(apiUrl, await getIdToken(), fetchFn);
      if (mounted.current && gen === generation.current) {
        failed.current = false;
        setDevices(list.devices);
        setDefaultDeviceId(list.defaultDeviceId);
        setLoadFailed(false);
      }
      return list.devices;
    } catch (e) {
      // A failed load is not an empty list. PUT /api/kindle/devices replaces the whole
      // list, so reading a failure as "no devices" would let the next save delete every
      // device the reader has stored. Stay unknown instead and say so.
      if (mounted.current && gen === generation.current) {
        failed.current = true;
        setDevices(undefined);
        setDefaultDeviceId(null);
        setLoadFailed(true);
      }
      throw e;
    }
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => { void reload().catch(() => {}); }, [reload]);

  const save = useCallback(async (next: DeviceInput[], nextDefault?: string) => {
    if (failed.current) throw new Error(LOAD_FAILED_MESSAGE);
    const gen = ++generation.current;
    const list = await saveKindleDevices(apiUrl, await getIdToken(), next, nextDefault, fetchFn);
    if (mounted.current && gen === generation.current) { setDevices(list.devices); setDefaultDeviceId(list.defaultDeviceId); }
  }, [apiUrl, getIdToken, fetchFn]);

  const send = useCallback(
    (bookId: string, format?: string, deviceId?: string) =>
      getIdToken().then((t) => sendToKindle(apiUrl, t, bookId, format, deviceId, fetchFn)),
    [apiUrl, getIdToken, fetchFn],
  );

  const value = useMemo<KindleState>(
    () => ({ devices, defaultDeviceId, loadFailed, sender, reload, save, send }),
    [devices, defaultDeviceId, loadFailed, sender, reload, save, send],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKindle(): KindleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKindle must be used inside <KindleProvider>");
  return ctx;
}
