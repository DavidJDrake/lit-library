import { logEvent } from "../shared/log";

export interface ScanPage {
  Items: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}
export type ScanFn = (table: string, startKey?: Record<string, unknown>) => Promise<ScanPage>;
export type PutFn = (key: string, body: string) => Promise<void>;
export interface BackupDeps { scan: ScanFn; put: PutFn; now: () => Date }
/** `table` is the physical table name; `name` is the filename prefix in the bucket. */
export interface TableTarget { table: string; name: string }

/** "2026-09-12T014530Z" — the format scripts/backup.sh writes, so both producers agree. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "");
}

/** A scan that stops at the first page is a backup that silently lies; follow every key. */
export async function scanAll(scan: ScanFn, table: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await scan(table, startKey);
    items.push(...page.Items);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export async function exportTables(targets: TableTarget[], deps: BackupDeps): Promise<Record<string, number>> {
  const at = stamp(deps.now());
  const counts: Record<string, number> = {};
  for (const target of targets) {
    const items = await scanAll(deps.scan, target.table);
    const key = `dynamodb/${target.name}-${at}.json`;
    // Same shape as `aws dynamodb scan --output json`, so one restore procedure
    // covers files written by this Lambda or by scripts/backup.sh.
    await deps.put(key, JSON.stringify({ Items: items, Count: items.length }));
    counts[target.name] = items.length;
    logEvent("backup.exported", { table: target.name, rows: items.length, key });
  }
  return counts;
}
