import { useState } from "react";
import { suggesterLabel, type Suggestion } from "../catalog/library";
import SuggestForm from "./SuggestForm";

interface Props {
  suggestions: Suggestion[];
  isAdmin: boolean;
  onSuggest: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onResolve: (id: string, action: "accept" | "reject") => Promise<void>;
}

type Mode = "idle" | "suggest" | "create";

// Footer of the Category facet: pending suggestions (so nobody duplicates one),
// a free-standing "suggest" form, and — for admins — accept/reject and add-directly.
export default function CategorySuggestions({ suggestions, isAdmin, onSuggest, onCreate, onResolve }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [resolving, setResolving] = useState<string>();

  async function resolve(id: string, action: "accept" | "reject") {
    setResolving(id);
    try {
      await onResolve(id, action);
    } finally {
      setResolving(undefined);
    }
  }

  return (
    <div className="category-footer">
      {suggestions.length > 0 && (
        <ul className="chips" aria-label="Pending category suggestions">
          {suggestions.map((s) => (
            <li key={s.id} className="chip">
              <span>{s.name} · suggested by {suggesterLabel(s.suggestedBy)}</span>
              {isAdmin && (
                <span className="chip-actions">
                  <button type="button" aria-label={`Accept ${s.name}`} title="Accept" disabled={resolving === s.id}
                    onClick={() => void resolve(s.id, "accept")}>✓</button>
                  <button type="button" aria-label={`Reject ${s.name}`} title="Reject" disabled={resolving === s.id}
                    onClick={() => void resolve(s.id, "reject")}>✗</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {mode === "idle" && (
        <div className="footer-links">
          <button type="button" className="more" onClick={() => setMode("suggest")}>Suggest a category</button>
          {isAdmin && <button type="button" className="more" onClick={() => setMode("create")}>Add category</button>}
        </div>
      )}
      {mode === "suggest" && <SuggestForm label="New category name" onSubmit={onSuggest} onCancel={() => setMode("idle")} />}
      {mode === "create" && <SuggestForm label="Category name" onSubmit={onCreate} onCancel={() => setMode("idle")} />}
    </div>
  );
}
