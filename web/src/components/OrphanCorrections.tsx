import { useState } from "react";

interface Props {
  editionIds: string[];
  onRemove: (editionIds: string[]) => Promise<void>;
}

// Admin-only: work-correction rows whose edition no longer exists in the catalog. No book
// dialog can ever show one (there's no card to open it from), so pull-edits.py reports them
// as `orphan:` on every run until removed here.
export default function OrphanCorrections({ editionIds, onRemove }: Props) {
  const [removing, setRemoving] = useState<string>();
  if (editionIds.length === 0) return null;

  async function remove(id: string) {
    setRemoving(id);
    try {
      await onRemove([id]);
    } finally {
      setRemoving(undefined);
    }
  }

  return (
    <div className="panel orphan-corrections">
      <h3>Orphan corrections</h3>
      <p className="meta">
        {editionIds.length} correction{editionIds.length === 1 ? "" : "s"} on an edition no longer in the library.
      </p>
      <ul className="chips" aria-label="Orphan work corrections">
        {editionIds.map((id) => (
          <li key={id} className="chip">
            <span><code>{id}</code></span>
            <span className="chip-actions">
              <button type="button" aria-label={`Remove ${id}`} title="Remove" disabled={removing === id} onClick={() => void remove(id)}>
                ✗
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
