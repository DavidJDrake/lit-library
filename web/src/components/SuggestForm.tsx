import { useState, type FormEvent } from "react";

interface Props {
  label: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

export const CATEGORY_NAME_MAX = 40;

// One-field inline form used for "suggest a category" (from a book or free-standing)
// and the admin "add category" action. The parent owns toasts; a rejected onSubmit
// simply leaves the form open.
export default function SuggestForm({ label, onSubmit, onCancel }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onCancel();
    } catch {
      setBusy(false);
    }
  }

  return (
    <form className="suggest-form" onSubmit={(e) => void submit(e)}>
      <input type="text" aria-label={label} placeholder={label} value={name} maxLength={CATEGORY_NAME_MAX}
        autoFocus disabled={busy} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn" disabled={!trimmed || busy}>Submit</button>
      <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </form>
  );
}
