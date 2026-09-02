import { useState } from "react";

interface Props {
  title: string;
  options: Array<{ value: string; count: number }>;
  selected: Set<string>;
  onToggle: (value: string) => void;
  initialLimit?: number;
}

const EXPANDED_CAP = 50;

export default function FacetGroup({ title, options, selected, onToggle, initialLimit = 8 }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filterText, setFilterText] = useState("");
  if (options.length === 0) return null;

  const needsFilter = expanded && options.length > EXPANDED_CAP;
  const expandedOptions = needsFilter
    ? options.filter((o) => o.value.toLowerCase().includes(filterText.trim().toLowerCase())).slice(0, EXPANDED_CAP)
    : options;
  const shown = expanded ? expandedOptions : options.slice(0, initialLimit);

  return (
    <section className="facet">
      <h3>{title}</h3>
      {needsFilter && (
        <input type="search" placeholder="Filter…" value={filterText}
          onChange={(e) => setFilterText(e.target.value)} aria-label={`Filter ${title}`} />
      )}
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
