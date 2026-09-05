// Fan-out per recipient: one row per (user, event). Shared by the library Lambda
// (suggestion/category events) and the notifications Lambda (inbox + books_added).
import { ListUsersCommand, ListUsersInGroupCommand, type UserType } from "@aws-sdk/client-cognito-identity-provider";
import { BatchWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type NotificationType = "suggestion_pending" | "suggestion_resolved" | "books_added" | "category_created";
export type Recipients = "everyone" | "admins" | string[];

export interface NotificationRow {
  pk: string; sk: string; type: NotificationType; payload: Record<string, unknown>;
  read: boolean; createdAt: string; expiresAt: number;
}
export interface UserDirectory { listEveryone(): Promise<string[]>; listAdmins(): Promise<string[]> }
export interface NotificationWriter { putAll(rows: NotificationRow[]): Promise<void> }
export interface NotifyDeps { directory: UserDirectory; writer: NotificationWriter; now: () => Date; newId: () => string }
export type NotifyFn = (type: NotificationType, payload: Record<string, unknown>, recipients: Recipients) => Promise<number>;

export const TTL_DAYS = 90;
export const ADMIN_GROUP = "admins";
const PAGE = 60;
const BATCH = 25;
const ACTIVE_STATUSES = new Set(["CONFIRMED", "EXTERNAL_PROVIDER"]);

export function buildRows(
  type: NotificationType, payload: Record<string, unknown>, emails: string[], now: Date, newId: () => string,
): NotificationRow[] {
  const createdAt = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + TTL_DAYS * 86_400;
  const seen = new Set<string>();
  const rows: NotificationRow[] = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ pk: `USER#${key}`, sk: `${createdAt}#${newId()}`, type, payload, read: false, createdAt, expiresAt });
  }
  return rows;
}

export async function notify(
  type: NotificationType, payload: Record<string, unknown>, recipients: Recipients, deps: NotifyDeps,
): Promise<number> {
  const emails = recipients === "everyone" ? await deps.directory.listEveryone()
    : recipients === "admins" ? await deps.directory.listAdmins()
    : recipients;
  const rows = buildRows(type, payload, emails, deps.now(), deps.newId);
  if (rows.length === 0) return 0;
  await deps.writer.putAll(rows);
  return rows.length;
}

interface SdkClient { send(cmd: unknown): Promise<unknown> }

function emailOf(u: UserType): string | undefined {
  if (!u.Enabled || !ACTIVE_STATUSES.has(u.UserStatus ?? "")) return undefined;
  return u.Attributes?.find((a) => a.Name === "email")?.Value;
}

export class CognitoDirectory implements UserDirectory {
  private cache: { everyone?: { at: number; v: string[] }; admins?: { at: number; v: string[] } } = {};
  constructor(
    private readonly client: SdkClient, private readonly userPoolId: string,
    private readonly cacheMs = 60_000, private readonly nowMs: () => number = Date.now,
  ) {}

  private async cached(key: "everyone" | "admins", load: () => Promise<string[]>): Promise<string[]> {
    const hit = this.cache[key];
    if (hit && this.nowMs() - hit.at < this.cacheMs) return hit.v;
    const v = await load();
    this.cache[key] = { at: this.nowMs(), v };
    return v;
  }

  listEveryone() {
    return this.cached("everyone", async () => {
      const out: string[] = [];
      let PaginationToken: string | undefined;
      do {
        const page = (await this.client.send(new ListUsersCommand({
          UserPoolId: this.userPoolId, Limit: PAGE, ...(PaginationToken ? { PaginationToken } : {}),
        }))) as { Users?: UserType[]; PaginationToken?: string };
        for (const u of page.Users ?? []) { const e = emailOf(u); if (e) out.push(e); }
        PaginationToken = page.PaginationToken;
      } while (PaginationToken);
      return out;
    });
  }

  listAdmins() {
    return this.cached("admins", async () => {
      const out: string[] = [];
      let NextToken: string | undefined;
      do {
        const page = (await this.client.send(new ListUsersInGroupCommand({
          UserPoolId: this.userPoolId, GroupName: ADMIN_GROUP, Limit: PAGE, ...(NextToken ? { NextToken } : {}),
        }))) as { Users?: UserType[]; NextToken?: string };
        for (const u of page.Users ?? []) { const e = emailOf(u); if (e) out.push(e); }
        NextToken = page.NextToken;
      } while (NextToken);
      return out;
    });
  }
}

export class DynamoNotificationWriter implements NotificationWriter {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async putAll(rows: NotificationRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      let pending = rows.slice(i, i + BATCH).map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
        const out = await this.ddb.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending } }));
        pending = (out.UnprocessedItems?.[this.table] ?? []) as typeof pending;
      }
      if (pending.length > 0) throw new Error(`${pending.length} notification row(s) could not be written`);
    }
  }
}
