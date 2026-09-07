import { useState, type FormEvent } from "react";
import { KINDLE_ADDRESS_RE, KINDLE_HELP_URL, MAX_LABEL } from "../kindle/limits";

interface Props {
  sender: string;
  submitLabel: string;
  onSubmit(label: string, address: string): Promise<void>;
  onCancel?(): void;
  showHelp?: boolean;
  disabled?: boolean;
}

// Shared by the book dialog (first send) and the Settings device list (add a device).
// Messages match the server's so a client-side and a server-side rejection read alike.
export default function KindleDeviceForm({ sender, submitLabel, onSubmit, onCancel, showHelp = true, disabled = false }: Props) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The caller (e.g. the device list) can disable the form while its own mutation is in
  // flight, on top of this form's own busy flag, so the two compose.
  const locked = busy || disabled;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = label.trim();
    const email = address.trim().toLowerCase();
    if (!name || name.length > MAX_LABEL) { setError("Give the device a name of 30 characters or fewer"); return; }
    if (!KINDLE_ADDRESS_RE.test(email)) { setError("Enter your @kindle.com address"); return; }
    setError(undefined); setBusy(true);
    try {
      await onSubmit(name, email);
      setLabel(""); setAddress("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="kindle-form" onSubmit={(e) => void submit(e)}>
      <label>Name
        <input type="text" value={label} disabled={locked} placeholder="Scribe" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>Your Kindle email
        <input type="email" value={address} disabled={locked} placeholder="name_123@kindle.com" onChange={(e) => setAddress(e.target.value)} />
      </label>
      {showHelp && (
        <p className="meta">
          <a href={KINDLE_HELP_URL} target="_blank" rel="noreferrer">Where do I find this?</a>{" "}
          Then add <code>{sender}</code> to your approved personal-document senders on that page.
        </p>
      )}
      {error && <div className="notif-error" role="alert">{error}</div>}
      <div className="suggest-form">
        <button type="submit" className="btn" disabled={locked}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
