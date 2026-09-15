import { useMemo, useState } from "react";
import { searchBooks } from "../catalog/search";
import type { Book } from "../catalog/types";

interface Props {
  card: Book;
  works: Book[];
  selectedEditionId: string | null;
  canReset: boolean;
  busy: boolean;
  // Resolves to whether the merge was saved; the picker stays open when it was not.
  onMerge(target: Book): Promise<boolean>;
  onSplit(editionId: string): Promise<void>;
  onReset(): Promise<void>;
}

// Admin-only corrections to automatic grouping. The operations themselves are computed in
// catalog/works.ts; this component only chooses what to act on.
export default function WorkAdminControls({ card, works, selectedEditionId, canReset, busy, onMerge, onSplit, onReset }: Props) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () => (query.trim().length < 2 ? [] : searchBooks(works.filter((w) => w.id !== card.id), query).slice(0, 8)),
    [works, card.id, query],
  );
  const editions = card.editions ?? [];

  return (
    <div className="work-admin">
      {!picking && <button className="btn" disabled={busy} onClick={() => setPicking(true)}>Merge into…</button>}
      {editions.length > 1 && selectedEditionId && (
        <button className="btn" disabled={busy} onClick={() => void onSplit(selectedEditionId)}>
          Split this edition into its own card
        </button>
      )}
      {canReset && <button className="btn" disabled={busy} onClick={() => void onReset()}>Reset to automatic grouping</button>}
      {picking && (
        <div className="merge-picker">
          <input type="search" aria-label="Find the card to merge into" placeholder="Search titles or authors…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul>
            {candidates.map((w) => (
              <li key={w.id}>
                <button className="btn" disabled={busy}
                  onClick={() => void onMerge(w).then((merged) => { if (merged) { setPicking(false); setQuery(""); } })}>
                  {w.title}{w.authors[0] ? ` — ${w.authors[0]}` : ""}{w.year ? ` (${w.year})` : ""}
                </button>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => { setPicking(false); setQuery(""); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
