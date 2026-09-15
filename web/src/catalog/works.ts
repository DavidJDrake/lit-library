import type { Book, BookFormat, Edition, EditionFormat, ReadingStatus } from "./types";

// Groups catalog copies into work cards. See docs/superpowers/specs/2026-09-14-works-and-editions-design.md.

export interface CatalogEntryRef { id: string; editionId?: string; workId?: string }

// The overlay fields grouping needs. Structurally a subset of library.ts's Overlay.
export interface WorkOverlay {
  bookCategories: Record<string, string>;
  readingStatuses: Record<string, ReadingStatus>;
  downloaded: string[];
  workEdits?: Record<string, string>;
}

const editionOf = (e: CatalogEntryRef) => e.editionId ?? e.id;
const catalogWorkOf = (e: CatalogEntryRef) => e.workId ?? e.id;
const byAddedThenId = (a: { addedAt: string; id: string }, b: { addedAt: string; id: string }) =>
  a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id);

// Start from the edition's correction row, otherwise its catalog work; then keep moving to the
// current id's row, otherwise that id's catalog work, until the id stops changing. Mirrors the
// reference model in scripts/gen-work-corrections-fixture.py, which the tests replay.
export function effectiveWorkIds(entries: CatalogEntryRef[], workEdits: Record<string, string>): Map<string, string> {
  const catalogWork = new Map<string, string>();
  for (const e of entries) catalogWork.set(editionOf(e), catalogWorkOf(e));
  const out = new Map<string, string>();
  for (const e of entries) {
    const edition = editionOf(e);
    let w = workEdits[edition] ?? catalogWorkOf(e);
    const seen = new Set([edition]);
    let cycle = false;
    for (;;) {
      const next = workEdits[w] ?? catalogWork.get(w) ?? w;
      if (next === w) break;
      if (seen.has(next)) { cycle = true; break; }
      seen.add(w);
      w = next;
    }
    if (cycle) console.warn(`work corrections form a cycle at ${edition}; using its catalog grouping`);
    out.set(e.id, cycle ? catalogWorkOf(e) : w);
  }
  return out;
}

const ORDINAL = String.raw`\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth`;
const EDITION_MARKER = new RegExp(
  String.raw`\(([^)]*\bedition\b[^)]*)\)|\b(?:${ORDINAL}|revised|updated|expanded)\s+edition\b|\bedition\s+\d+\b|\b\d+(?:st|nd|rd|th)\s+ed\b\.?`,
  "i",
);

export function editionMarker(title: string): string | null {
  const m = title.match(EDITION_MARKER);
  if (!m) return null;
  return (m[1] ?? m[0]).trim();
}

const yearOf = (e: Edition) => e.year ?? Number.NEGATIVE_INFINITY;

export function displayOrder(editions: Edition[]): Edition[] {
  return [...editions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .sort((a, b) => (yearOf(a) === yearOf(b) ? 0 : yearOf(b) > yearOf(a) ? 1 : -1));
}

function toEdition(id: string, copies: Book[], downloaded: Set<string>): Edition {
  const byAdded = [...copies].sort(byAddedThenId);
  const canonical = copies.find((c) => c.id === id) ?? byAdded[0];
  const newestFirst = [...copies].sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
  const types = [...new Set([...canonical.formats.map((f) => f.type), ...copies.flatMap((c) => c.formats.map((f) => f.type))])];
  const formats: EditionFormat[] = types.map((type) => {
    const source = newestFirst.find((c) => c.formats.some((f) => f.type === type))!;
    return { ...source.formats.find((f) => f.type === type)!, copyId: source.id };
  });
  return {
    id, title: canonical.title, authors: canonical.authors, description: canonical.description,
    publisher: canonical.publisher, year: canonical.year, coverUrl: canonical.coverUrl, subjects: canonical.subjects,
    category: canonical.category, formats, bundles: [...new Set(copies.map((c) => c.bundle))].sort(),
    copyIds: byAdded.map((c) => c.id), addedAt: byAdded[0].addedAt, downloaded: copies.some((c) => downloaded.has(c.id)),
  };
}

function toWork(workId: string, byEdition: Map<string, Book[]>, overlay: WorkOverlay | null, downloaded: Set<string>): Book {
  const editions = displayOrder([...byEdition].map(([id, copies]) => toEdition(id, copies, downloaded)));
  const shown = editions[0];
  const shownCopies = [...byEdition.get(shown.id)!].sort(byAddedThenId);
  const otherCopies = editions.slice(1).flatMap((e) => byEdition.get(e.id)!).sort(byAddedThenId);
  const preference = [workId, ...shownCopies.map((c) => c.id), ...otherCopies.map((c) => c.id)];
  function firstIn<T>(map: Record<string, T> | undefined): T | undefined {
    if (!map) return undefined;
    for (const id of preference) if (map[id] !== undefined) return map[id];
    return undefined;
  }
  const formats: BookFormat[] = [];
  const seen = new Set<string>();
  for (const e of editions) {
    for (const { copyId: _copyId, ...f } of e.formats) {
      if (!seen.has(f.type)) { seen.add(f.type); formats.push(f); }
    }
  }
  const bundles = [...new Set(editions.flatMap((e) => e.bundles))].sort();
  return {
    id: workId, editionId: workId, workId,
    title: shown.title, authors: shown.authors, description: shown.description,
    category: firstIn(overlay?.bookCategories) ?? shown.category,
    subjects: shown.subjects, publisher: shown.publisher, bundle: bundles[0] ?? "", year: shown.year, formats,
    coverUrl: shown.coverUrl, addedAt: editions.map((e) => e.addedAt).sort().at(-1)!,
    bundles, editions,
    ...(overlay ? { readingStatus: firstIn(overlay.readingStatuses) ?? null, downloaded: editions.some((e) => e.downloaded) } : {}),
  };
}

export interface EditionRef { id: string; addedAt: string }

// Merge card X into card W: every edition of X is assigned to W.
export function mergeEdits(fromEditionIds: string[], intoWorkId: string): Record<string, string> {
  return Object.fromEntries(fromEditionIds.map((id) => [id, intoWorkId]));
}

// Split edition S out of card C. The remainder gets explicit rows too: without them, a split of
// the card's earliest edition would do nothing (the rest still resolve to it through their
// catalog workId), and a split of an edition that was the only automatic link between two
// others would come apart differently at the next publish.
export function splitEdits(cardId: string, cardEditions: EditionRef[], editionId: string): Record<string, string> {
  const rest = cardEditions.filter((e) => e.id !== editionId);
  if (rest.length === 0) return {};
  const remainderId = editionId !== cardId ? cardId : [...rest].sort(byAddedThenId)[0].id;
  const rows: Record<string, string> = { [editionId]: editionId };
  if (editionId === cardId) rows[remainderId] = remainderId;
  for (const e of rest) if (e.id !== remainderId) rows[e.id] = remainderId;
  return rows;
}

// Reset card C: the rows of C's editions and of every edition sharing an automatic work with
// one of them. Clearing whole automatic groups keeps the site and the folded overrides in step.
export function resetEditionIds(entries: CatalogEntryRef[], cardEditionIds: string[], workEdits: Record<string, string>): string[] {
  const catalogWork = new Map(entries.map((e) => [editionOf(e), catalogWorkOf(e)]));
  const autos = new Set(cardEditionIds.map((id) => catalogWork.get(id) ?? id));
  const drop = new Set(cardEditionIds);
  for (const [edition, work] of catalogWork) if (autos.has(work)) drop.add(edition);
  return [...drop].filter((id) => id in workEdits).sort();
}

export function groupWorks(entries: Book[], overlay: WorkOverlay | null): Book[] {
  const workOf = effectiveWorkIds(entries, overlay?.workEdits ?? {});
  const downloaded = new Set(overlay?.downloaded ?? []);
  const works = new Map<string, Map<string, Book[]>>();
  for (const entry of entries) {
    const w = workOf.get(entry.id)!;
    const byEdition = works.get(w) ?? new Map<string, Book[]>();
    works.set(w, byEdition);
    const edition = editionOf(entry);
    byEdition.set(edition, [...(byEdition.get(edition) ?? []), entry]);
  }
  return [...works].map(([workId, byEdition]) => toWork(workId, byEdition, overlay, downloaded));
}
