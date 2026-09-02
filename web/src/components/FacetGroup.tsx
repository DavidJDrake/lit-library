import { useState } from "react";

interface Props {
  title: string;
  options: Array<{ value: string; count: number }>;
  selected: Set<string>;
  onToggle: (value: string) => void;
  initialLimit?: number;
}

export default function FacetGroup({ title, options, selected, onToggle, initialLimit = 8 }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (options.length === 0) return null;
  const shown = expanded ? options : options.slice(0, initialLimit);
  return (
    <section className="facet">
      <h3>{title}</h3>
      {shown.map((o) => (
        <label key={o.value}>
          <span>
            <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(o.value)} /> {o.value}
          </span>
          <span className="count">{o.count}</span>
        </label>
      ))}
      {options.length > initialLimit && (
        <button className="more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all (${options.length})`}
        </button>
      )}
    </section>
  );
}
