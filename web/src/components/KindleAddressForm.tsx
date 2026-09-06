import { useState, type FormEvent } from "react";
import { KINDLE_ADDRESS_RE, KINDLE_HELP_URL } from "../kindle/limits";

interface Props { sender: string; initial?: string; submitLabel?: string; onSubmit(address: string): Promise<void>; onCancel?(): void }

// Used inline in the book dialog (first send) and on the Settings page.
export default function KindleAddressForm({ sender, initial = "", submitLabel = "Save and send", onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = value.trim();
    // On Settings (no onCancel) an empty value clears the saved address. In the send flow
    // (onCancel present) empty would just re-trigger the same 409, so require a real address.
    const invalid = address === "" ? Boolean(onCancel) : !KINDLE_ADDRESS_RE.test(address);
    if (invalid) { setError("Enter your @kindle.com address"); return; }
    setError(undefined); setBusy(true);
    try {
      await onSubmit(address);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="kindle-form" onSubmit={(e) => void submit(e)}>
      <label>Your Kindle email
        <input type="email" value={value} disabled={busy} placeholder="name_123@kindle.com" onChange={(e) => setValue(e.target.value)} />
      </label>
      <p className="meta">
        <a href={KINDLE_HELP_URL} target="_blank" rel="noreferrer">Where do I find this?</a>{" "}
        Then add <code>{sender}</code> to your approved personal-document senders on that page.
      </p>
      {error && <div className="notif-error" role="alert">{error}</div>}
      <div className="suggest-form">
        <button type="submit" className="btn" disabled={busy}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
