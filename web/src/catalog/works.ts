import type { Book, BookFormat, Edition, EditionFormat, ReadingStatus } from "./types";

// Groups catalog copies into work cards. See docs/superpowers/specs/2026-09-14-works-and-editions-design.md.

export interface CatalogEntryRef { id: string; addedAt: string; editionId?: string; workId?: string; workLinks?: string[] }

// The overlay fields grouping needs. Structurally a subset of library.ts's Overlay.
export interface WorkOverlay {
  bookCategories: Record<string, string>;
  readingStatuses: Record<string, ReadingStatus>;
  downloaded: string[];
  workEdits?: Record<string, string>;
}

const editionOf = (e: CatalogEntryRef) => e.editionId ?? e.id;
const catalogWorkOf = (e: CatalogEntryRef) => e.workId ?? e.id;
// Plain string comparison, not localeCompare, to order ids and dates exactly as the indexer does.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byAddedThenId = (a: { addedAt: string; id: string }, b: { addedAt: string; id: string }) =>
  compare(a.addedAt, b.addedAt) || compare(a.id, b.id);

// groupWorks runs on every overlay change; say each problem with the corrections once.
const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

// Every edition's card under the indexer's own model (works.py group_copies), so a publish of the
// folded rows gives exactly these cards and ids. Rows map through copy id -> edition id; when
// several map to one edition the edition-id key wins, otherwise the smallest key. Managed editions
// take no automatic links; each joins its row's target; a card is named after its earliest-added
// edition (ties: smallest id). Mirrors scripts/gen-work-corrections-fixture.py, which the tests replay.
function editionCards(entries: CatalogEntryRef[], workEdits: Record<string, string>) {
  const edition = new Map<string, string>();
  const added = new Map<string, string>();
  for (const e of entries) {
    const ed = editionOf(e);
    edition.set(e.id, ed);
    edition.set(ed, ed);
    const at = added.get(ed);
    if (at === undefined || e.addedAt < at) added.set(ed, e.addedAt);
  }

  const chosen = new Map<string, string>();
  for (const key of Object.keys(workEdits).sort()) {
    const ed = edition.get(key);
    if (ed === undefined) { warnOnce(`work correction on unknown id ${key}; ignored`); continue; }
    if (!chosen.has(ed) || key === ed) chosen.set(ed, key);
  }
  const managed = new Map<string, string | undefined>();
  for (const [ed, key] of chosen) {
    const target = edition.get(workEdits[key]);
    if (target === undefined) warnOnce(`work correction on ${key} names unknown id ${workEdits[key]}; it stays its own card`);
    managed.set(ed, target);
  }

  const parent = new Map([...added.keys()].map((ed) => [ed, ed]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      const up = parent.get(parent.get(x)!)!;
      parent.set(x, up);
      x = up;
    }
    return x;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const e of entries) {
    const a = editionOf(e);
    for (const link of e.workLinks ?? []) {
      const b = edition.get(link);
      if (b !== undefined && !managed.has(a) && !managed.has(b)) union(a, b);
    }
  }
  for (const [ed, target] of managed) if (target !== undefined) union(ed, target);

  const before = (a: string, b: string) => byAddedThenId({ addedAt: added.get(a)!, id: a }, { addedAt: added.get(b)!, id: b }) < 0;
  const earliest = new Map<string, string>();
  for (const ed of added.keys()) {
    const best = earliest.get(find(ed));
    if (best === undefined || before(ed, best)) earliest.set(find(ed), ed);
  }
  return { edition, cardOf: (ed: string) => earliest.get(find(ed))! };
}

// Each entry's card id. Until the overlay has loaded (workEdits null) that is the catalog workId,
// which the last publish computed with the same model and the rows of that moment.
export function effectiveWorkIds(entries: CatalogEntryRef[], workEdits: Record<string, string> | null): Map<string, string> {
  if (workEdits === null) return new Map(entries.map((e) => [e.id, catalogWorkOf(e)]));
  const { cardOf } = editionCards(entries, workEdits);
  return new Map(entries.map((e) => [e.id, cardOf(editionOf(e))]));
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

// Split edition S out of card C. The whole remainder gets explicit rows, the remainder's own card
// id included: without them, a split of an edition that was the only automatic link between two
// others would leave them apart, and a remainder edition whose row pointed at S would stay with it.
export function splitEdits(cardId: string, cardEditions: EditionRef[], editionId: string): Record<string, string> {
  const rest = cardEditions.filter((e) => e.id !== editionId);
  if (rest.length === 0) return {};
  const remainderId = editionId !== cardId ? cardId : [...rest].sort(byAddedThenId)[0].id;
  const rows: Record<string, string> = { [editionId]: editionId };
  for (const e of rest) rows[e.id] = remainderId;
  return rows;
}

// Reset card C: every row whose edition lies in the automatic work (links only, ignoring rows) of
// one of C's editions, including rows keyed by a non-canonical copy. Afterwards those editions are
// unmanaged, so each of C's editions is back on a card with its whole automatic work.
export function resetEditionIds(entries: CatalogEntryRef[], cardEditionIds: string[], workEdits: Record<string, string>): string[] {
  const { edition, cardOf } = editionCards(entries, {});
  const scope = new Set(cardEditionIds.filter((id) => edition.has(id)).map((id) => cardOf(edition.get(id)!)));
  return Object.keys(workEdits).filter((key) => {
    const ed = edition.get(key);
    return ed !== undefined && scope.has(cardOf(ed));
  }).sort();
}

export function groupWorks(entries: Book[], overlay: WorkOverlay | null): Book[] {
  const workOf = effectiveWorkIds(entries, overlay ? overlay.workEdits ?? {} : null);
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
