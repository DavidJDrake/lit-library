import { useCallback, useEffect, useRef, useState } from "react";
import { generateOpdsToken, getOpdsTokenStatus, revokeOpdsToken, type OpdsTokenStatus } from "../opds/api";

interface Props {
  apiUrl: string;
  getIdToken(): Promise<string>;
  fetchFn?: typeof fetch;
}

// A freshly generated (or regenerated) token, held only in memory for as long as it
// takes the reader to copy it. Never round-tripped back to the server, never persisted,
// and gone the moment this component unmounts or reloads its status — the interface
// really cannot show it again, matching what the server itself no longer can either.
interface Revealed { url: string; createdAt: string }

function dateLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function OpdsSection({ apiUrl, getIdToken, fetchFn = fetch }: Props) {
  const [status, setStatus] = useState<OpdsTokenStatus | undefined>(undefined); // undefined while loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const s = await getOpdsTokenStatus(apiUrl, await getIdToken(), fetchFn);
      if (!mounted.current) return;
      setStatus(s);
      setLoadFailed(false);
    } catch {
      if (!mounted.current) return;
      setLoadFailed(true);
    }
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => { void load(); }, [load]);

  async function handleGenerate() {
    setError(undefined);
    setBusy(true);
    setCopied(false);
    try {
      const { token, createdAt } = await generateOpdsToken(apiUrl, await getIdToken(), fetchFn);
      const url = `${apiUrl}/opds?token=${encodeURIComponent(token)}`;
      if (!mounted.current) return;
      setRevealed({ url, createdAt });
      setStatus({ exists: true, createdAt });
    } catch (e) {
      if (mounted.current) setError((e as Error).message || "Could not generate a feed link");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function handleRevoke() {
    setError(undefined);
    setBusy(true);
    try {
      await revokeOpdsToken(apiUrl, await getIdToken(), fetchFn);
      if (!mounted.current) return;
      setRevealed(undefined);
      setStatus({ exists: false, createdAt: null });
    } catch (e) {
      if (mounted.current) setError((e as Error).message || "Could not revoke the feed link");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function handleCopy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.url);
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically — select and copy the link above");
    }
  }

  return (
    <section className="panel settings-section opds-section">
      <h3>E-reader feed (OPDS)</h3>
      <p className="meta">
        Generate a link your e-reader app can open directly to browse and download every book. Anyone who
        has this link can read your whole library without signing in — treat it like a password.
      </p>

      {loadFailed ? (
        <div className="notif-error" role="alert">
          <p>Couldn't load your feed link status.</p>
          <button type="button" className="btn secondary" onClick={() => void load()}>Try again</button>
        </div>
      ) : status === undefined ? (
        <p className="empty">Checking for a feed link…</p>
      ) : (
        <>
          {revealed ? (
            <div className="opds-url">
              <p className="meta">
                Copy this now — for your security, it won't be shown again. Paste it into your e-reader app
                as the OPDS catalog URL.
              </p>
              <div className="opds-url-row">
                <input type="text" readOnly aria-label="OPDS feed link" value={revealed.url} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn secondary" onClick={() => void handleCopy()}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          ) : status.exists ? (
            <p className="meta">A feed link was created on {dateLabel(status.createdAt!)}.</p>
          ) : (
            <p className="meta">No feed link yet.</p>
          )}

          {error && <div className="notif-error" role="alert">{error}</div>}

          <div className="opds-actions">
            {status.exists ? (
              <>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => void handleGenerate()}>Regenerate</button>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => void handleRevoke()}>Revoke</button>
              </>
            ) : (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void handleGenerate()}>Generate feed link</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
