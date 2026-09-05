# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A header bell with an unread badge, a popover of the five most recent notifications, and a `/notifications` page — fed by a fan-out-per-recipient DynamoDB table that the library Lambda and the indexer write to.

**Architecture:** A new `notifications` table (`USER#<email>` / `<createdAt>#<uuid>`, TTL 90 days) is written by a shared `fanout.ts` module (recipients from Cognito) bundled into the existing `library` Lambda (suggestion/category events) and a new `notifications` Lambda (inbox API + a direct-invoke path used by `publish-new.sh` for "books added"). The SPA gains a tiny router, a `LibraryDataProvider` (session + catalog + overlay, extracted from `Library`), a `NotificationsProvider` (poll every 5 min), a per-type renderer table, the bell popover, and the page.

**Tech Stack:** AWS CDK v2 (TypeScript), Lambda Node 22 with `@aws-sdk/lib-dynamodb` and `@aws-sdk/client-cognito-identity-provider`, React 18 + Vite + vitest + Testing Library, bash + Python 3 glue.

**Spec:** `docs/superpowers/specs/2026-09-05-notifications-design.md`

## Global Constraints

- Notification types (exact strings): `suggestion_pending`, `suggestion_resolved`, `books_added`, `category_created`. Payloads carry ids only, never titles.
- Recipients: `suggestion_pending` → admins; `suggestion_resolved` → the suggester; `books_added` and `category_created` → everyone. "Everyone" = Cognito users with `Enabled` and `UserStatus ∈ {CONFIRMED, EXTERNAL_PROVIDER}`; admins = members of group `admins`. Recipient lists cached 60 s in module memory.
- Table `notifications`: `pk = USER#<email>`, `sk = <createdAt ISO>#<uuid>` (the id the client sends back), attributes `type`, `payload`, `read`, `createdAt`, `expiresAt` (epoch seconds, +90 days, DynamoDB TTL). `PAY_PER_REQUEST`, `RemovalPolicy.DESTROY`. Not backed up.
- Fan-out triggered by a user action is **best-effort**: the primary write happens first; a `notify` failure is logged and never changes the HTTP response.
- API: `GET /api/notifications?limit=50&before=<sk>` → 200 `{ items: [{id, type, payload, read, createdAt}], unread, next? }`, `limit` clamped 1–100, malformed `before` → 400; `suggestion_pending` items carry `payload.status` (+ `resolvedBy`) joined from the library table. `POST /api/notifications/read` body `{ids: string[]}` (≤ 100) or `{all: true}` → 204. Direct invoke accepts only `{source:"indexer", type:"books_added", count ≥ 1, bookIds ≤ 20 strings}` and returns `{ok, recipients}` / `{ok:false, error}`.
- Both routes sit behind the API's default JWT authorizer; the existing stack test asserting `AuthorizerId` on every `GET|PUT|POST /api/*` route must keep passing.
- Client: poll every 5 minutes + on `visibilitychange`; badge capped at "9+"; popover shows the 5 most recent and marks the shown unread rows read after render; `/notifications` pages 50 at a time with "Load more" and "Mark all as read". Bell hidden until at least one notification has ever been returned. Notifications failure never affects the library.
- All suites stay offline. Existing: `cd infra && npm test && npm run typecheck && npx cdk synth`; `cd web && npm test && npm run typecheck && npm run build`; `cd indexer && .venv/bin/pytest -q`. Baseline on this branch: infra 115, web 114, indexer 78.
- Never commit real identifiers; fixtures use `example.com` addresses.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## File map

| File | Responsibility |
|---|---|
| `infra/lambda/notifications/fanout.ts` | Types, `buildRows`, `notify`, `CognitoDirectory`, `DynamoNotificationWriter`. |
| `infra/lambda/notifications/index.ts` | `NotificationStore`/`SuggestionLookup`/`Deps`, `handle` for HTTP + direct invoke, production `handler`. |
| `infra/lambda/notifications/store.ts` | `DynamoNotificationStore implements NotificationStore`. |
| `infra/lib/notifications.ts` | `Notifications` construct: table (TTL, DESTROY), Lambda, two routes, Cognito grant, output. |
| `infra/lib/library.ts` | + notifications table write grant, Cognito grant, env. |
| `infra/lambda/library/index.ts` | + `notify` in `Deps`; emits after writes. |
| `infra/lib/ebook-share-stack.ts` | + `Notifications` wiring, `NotificationsFunctionName` output. |
| `scripts/notify-books-added.py` | Computes the new-book delta and invokes the notifications Lambda (`--dry-run`). |
| `scripts/publish-new.sh` | Snapshots `added.json` keys before publish; calls `notify-books-added.py` after. |
| `web/src/route.ts`, `web/src/components/Link.tsx` | `useRoute`, `navigate`, plain-click-aware `Link`. |
| `web/src/catalog/LibraryDataProvider.tsx` | Session + catalog + overlay + renewal, extracted from `Library`; `useLibraryData()`. |
| `web/src/notifications/api.ts` | `fetchNotifications`, `markNotificationsRead`, types. |
| `web/src/notifications/NotificationsProvider.tsx` | `useNotifications()`: items, unread, status, refresh, markRead, markAllRead, loadMore, poll. |
| `web/src/notifications/render.ts` | Per-type renderer table + `relativeTime`. |
| `web/src/components/NotificationItem.tsx` | One row (icon, text, time, unread dot, admin actions). |
| `web/src/components/NotificationBell.tsx` | Bell + badge + popover. |
| `web/src/components/NotificationsPage.tsx` | The `/notifications` page. |
| `web/src/components/Header.tsx`, `web/src/App.tsx`, `web/src/components/Library.tsx` | Wiring. |
| `README.md`, `infra/README.md` | Docs. |

---

### Task 1: Fan-out module

**Files:**
- Create: `infra/lambda/notifications/fanout.ts`
- Modify: `infra/package.json` (add dependency `"@aws-sdk/client-cognito-identity-provider": "^3.700.0"`, then `npm install`)
- Test: `infra/test/notifications-fanout.test.ts`

**Interfaces:**
- Produces:

```ts
export type NotificationType = "suggestion_pending" | "suggestion_resolved" | "books_added" | "category_created";
export type Recipients = "everyone" | "admins" | string[];
export interface NotificationRow { pk: string; sk: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string; expiresAt: number }
export interface UserDirectory { listEveryone(): Promise<string[]>; listAdmins(): Promise<string[]> }
export interface NotificationWriter { putAll(rows: NotificationRow[]): Promise<void> }
export interface NotifyDeps { directory: UserDirectory; writer: NotificationWriter; now: () => Date; newId: () => string }
export type NotifyFn = (type: NotificationType, payload: Record<string, unknown>, recipients: Recipients) => Promise<number>;
export const TTL_DAYS = 90;
export const ADMIN_GROUP = "admins";
export function buildRows(type, payload, emails: string[], now: Date, newId: () => string): NotificationRow[]
export async function notify(type, payload, recipients, deps: NotifyDeps): Promise<number>   // recipient count
export class CognitoDirectory implements UserDirectory { constructor(client: { send(cmd: unknown): Promise<unknown> }, userPoolId: string, cacheMs = 60_000, nowMs: () => number = Date.now) }
export class DynamoNotificationWriter implements NotificationWriter { constructor(ddb: DynamoDBDocumentClient, table: string) }
```

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/notifications-fanout.test.ts
import { BatchWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ListUsersCommand, ListUsersInGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it, vi } from "vitest";
import {
  buildRows, CognitoDirectory, DynamoNotificationWriter, notify, TTL_DAYS, type NotificationRow, type NotifyDeps,
} from "../lambda/notifications/fanout";

const NOW = new Date("2026-09-05T10:00:00.000Z");

function user(email: string, status = "EXTERNAL_PROVIDER", enabled = true) {
  return { Username: `Google_${email}`, Enabled: enabled, UserStatus: status, Attributes: [{ Name: "email", Value: email }] };
}

describe("buildRows", () => {
  it("keys rows by recipient, orders sk by time then id, and sets the TTL", () => {
    const rows = buildRows("books_added", { count: 2, bookIds: ["a", "b"] }, ["x@example.com", "y@example.com"], NOW, () => "id-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pk: "USER#x@example.com", sk: "2026-09-05T10:00:00.000Z#id-1", type: "books_added",
      payload: { count: 2, bookIds: ["a", "b"] }, read: false, createdAt: "2026-09-05T10:00:00.000Z",
      expiresAt: Math.floor(NOW.getTime() / 1000) + TTL_DAYS * 86_400,
    });
    expect(rows[1].pk).toBe("USER#y@example.com");
  });
  it("dedupes recipients case-insensitively", () => {
    expect(buildRows("category_created", { name: "X" }, ["A@example.com", "a@example.com"], NOW, () => "i")).toHaveLength(1);
  });
});

describe("notify", () => {
  function deps(over: Partial<NotifyDeps> = {}): NotifyDeps & { written: NotificationRow[] } {
    const written: NotificationRow[] = [];
    return {
      directory: { listEveryone: vi.fn().mockResolvedValue(["a@example.com", "b@example.com"]), listAdmins: vi.fn().mockResolvedValue(["a@example.com"]) },
      writer: { putAll: vi.fn(async (rows: NotificationRow[]) => { written.push(...rows); }) },
      now: () => NOW, newId: () => "id-1", written, ...over,
    };
  }
  it("resolves 'everyone', 'admins', and explicit lists", async () => {
    const d = deps();
    expect(await notify("books_added", { count: 1, bookIds: ["a"] }, "everyone", d)).toBe(2);
    expect(await notify("suggestion_pending", { suggestionId: "s", name: "N", suggestedBy: "b@example.com" }, "admins", d)).toBe(1);
    expect(await notify("suggestion_resolved", { suggestionId: "s", name: "N", status: "accepted", resolvedBy: "a@example.com" }, ["b@example.com"], d)).toBe(1);
    expect(d.written.map((r) => r.pk)).toEqual(["USER#a@example.com", "USER#b@example.com", "USER#a@example.com", "USER#b@example.com"]);
  });
  it("writes nothing and returns 0 when there are no recipients", async () => {
    const d = deps({ directory: { listEveryone: vi.fn().mockResolvedValue([]), listAdmins: vi.fn().mockResolvedValue([]) } });
    expect(await notify("category_created", { name: "X", createdBy: "a@example.com", source: "admin" }, "admins", d)).toBe(0);
    expect(d.writer.putAll).not.toHaveBeenCalled();
  });
});

describe("CognitoDirectory", () => {
  it("pages through ListUsers, keeps only enabled confirmed/external users, and caches for 60s", async () => {
    const pages = [
      { Users: [user("a@example.com"), user("b@example.com", "UNCONFIRMED"), user("c@example.com", "CONFIRMED", false)], PaginationToken: "t1" },
      { Users: [user("d@example.com", "CONFIRMED")] },
    ];
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListUsersCommand) return pages.shift();
      throw new Error("unexpected " + (cmd as { constructor: { name: string } }).constructor.name);
    });
    let t = 0;
    const dir = new CognitoDirectory({ send }, "pool-1", 60_000, () => t);
    expect(await dir.listEveryone()).toEqual(["a@example.com", "d@example.com"]);
    expect((send.mock.calls[0][0] as ListUsersCommand).input).toEqual({ UserPoolId: "pool-1", Limit: 60 });
    expect((send.mock.calls[1][0] as ListUsersCommand).input.PaginationToken).toBe("t1");
    t = 30_000;
    expect(await dir.listEveryone()).toEqual(["a@example.com", "d@example.com"]);
    expect(send).toHaveBeenCalledTimes(2); // cached
    pages.push({ Users: [user("z@example.com")] });
    t = 61_000;
    expect(await dir.listEveryone()).toEqual(["z@example.com"]);
  });
  it("lists admins via ListUsersInGroup with NextToken paging", async () => {
    const pages = [{ Users: [user("a@example.com")], NextToken: "n" }, { Users: [user("b@example.com")] }];
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListUsersInGroupCommand) return pages.shift();
      throw new Error("unexpected");
    });
    const dir = new CognitoDirectory({ send }, "pool-1");
    expect(await dir.listAdmins()).toEqual(["a@example.com", "b@example.com"]);
    expect((send.mock.calls[0][0] as ListUsersInGroupCommand).input).toEqual({ UserPoolId: "pool-1", GroupName: "admins", Limit: 60 });
    expect((send.mock.calls[1][0] as ListUsersInGroupCommand).input.NextToken).toBe("n");
  });
});

describe("DynamoNotificationWriter", () => {
  it("batches 25 rows per BatchWrite and retries unprocessed items once", async () => {
    const rows = buildRows("books_added", { count: 1, bookIds: ["a"] }, Array.from({ length: 30 }, (_, i) => `u${i}@example.com`), NOW, () => "id");
    let call = 0;
    const send = vi.fn(async (cmd: unknown) => {
      call += 1;
      const req = (cmd as BatchWriteCommand).input.RequestItems!["T"];
      if (call === 1) return { UnprocessedItems: { T: req.slice(0, 1) } };
      return { UnprocessedItems: {} };
    });
    await new DynamoNotificationWriter({ send } as unknown as DynamoDBDocumentClient, "T").putAll(rows);
    expect(send).toHaveBeenCalledTimes(3); // 25, 5, retry of 1
    const first = send.mock.calls[0][0] as BatchWriteCommand;
    expect(first).toBeInstanceOf(BatchWriteCommand);
    expect(first.input.RequestItems!["T"]).toHaveLength(25);
    expect(first.input.RequestItems!["T"][0]).toEqual({ PutRequest: { Item: rows[0] } });
  });
  it("gives up after one retry with an error naming the count", async () => {
    const rows = buildRows("books_added", { count: 1, bookIds: ["a"] }, ["a@example.com"], NOW, () => "id");
    const send = vi.fn(async (cmd: unknown) => ({ UnprocessedItems: { T: (cmd as BatchWriteCommand).input.RequestItems!["T"] } }));
    await expect(new DynamoNotificationWriter({ send } as unknown as DynamoDBDocumentClient, "T").putAll(rows)).rejects.toThrow(/1 notification/);
  });
});
```

- [ ] **Step 2: Add the dependency and run tests to verify they fail**

Run: `cd infra && npm install --save @aws-sdk/client-cognito-identity-provider@^3.700.0 && npx vitest run test/notifications-fanout.test.ts`
Expected: FAIL — `Cannot find module '../lambda/notifications/fanout'`. (`package-lock.json` changes are part of this task's commit.)

- [ ] **Step 3: Write the module**

```ts
// infra/lambda/notifications/fanout.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/notifications-fanout.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/notifications/fanout.ts infra/test/notifications-fanout.test.ts infra/package.json infra/package-lock.json
git commit -m "feat(notifications): fan-out module with Cognito recipient directory"
```

---

### Task 2: Notifications Lambda handler (HTTP + direct invoke)

**Files:**
- Create: `infra/lambda/notifications/index.ts`
- Test: `infra/test/notifications-handler.test.ts`

**Interfaces:**
- Consumes: `NotificationType`, `NotifyFn` from `./fanout`.
- Produces (exported from `index.ts`):

```ts
export interface NotificationRecord { id: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationStore {
  list(email: string, limit: number, before?: string): Promise<{ items: NotificationRecord[]; next?: string }>;
  countUnread(email: string): Promise<number>;
  markRead(email: string, ids: string[]): Promise<void>;
  markAllRead(email: string): Promise<void>;
}
export interface SuggestionLookup { getSuggestion(id: string): Promise<{ status: string; resolvedBy?: string } | undefined> }
export interface Deps { store: NotificationStore; suggestions: SuggestionLookup; notify: NotifyFn; now: () => Date }
export interface IndexerEvent { source: "indexer"; type: "books_added"; count: number; bookIds: string[] }
export type InvokeResult = { ok: true; recipients: number } | { ok: false; error: string };
export const DEFAULT_LIMIT = 50; export const MAX_LIMIT = 100; export const MAX_READ_IDS = 100; export const MAX_BOOK_IDS = 20;
export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer | Record<string, unknown>, deps: Deps): Promise<APIGatewayProxyResultV2 | InvokeResult>
```

  The production `handler` is wired in Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/notifications-handler.test.ts
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { handle, MAX_LIMIT, type Deps, type NotificationRecord, type NotificationStore } from "../lambda/notifications/index";

const NOW = "2026-09-05T10:00:00.000Z";
const rec = (id: string, type: NotificationRecord["type"], payload: Record<string, unknown>, read = false): NotificationRecord =>
  ({ id: `2026-09-05T09:00:00.000Z#${id}`, type, payload, read, createdAt: "2026-09-05T09:00:00.000Z" });

function store(over: Partial<NotificationStore> = {}): NotificationStore {
  return {
    list: vi.fn().mockResolvedValue({ items: [
      rec("n1", "suggestion_pending", { suggestionId: "s1", name: "Cookbooks", suggestedBy: "b@example.com" }),
      rec("n2", "books_added", { count: 3, bookIds: ["a", "b", "c"] }, true),
    ] }),
    countUnread: vi.fn().mockResolvedValue(1),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}
function deps(s: NotificationStore = store(), over: Partial<Deps> = {}): Deps {
  return {
    store: s,
    suggestions: { getSuggestion: vi.fn().mockResolvedValue({ status: "accepted", resolvedBy: "a@example.com" }) },
    notify: vi.fn().mockResolvedValue(4),
    now: () => new Date(NOW),
    ...over,
  };
}
function http(method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; claims?: Record<string, unknown> } = {}) {
  return {
    rawPath: path,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    queryStringParameters: opts.query,
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: opts.claims ?? { email: "a@example.com" }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
function parse(res: Awaited<ReturnType<typeof handle>>) {
  const r = res as { statusCode: number; body?: string };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined };
}

describe("GET /api/notifications", () => {
  it("lists items with unread count, joining suggestion status into pending rows", async () => {
    const d = deps();
    const { status, json } = parse(await handle(http("GET", "/api/notifications"), d));
    expect(status).toBe(200);
    expect(json.unread).toBe(1);
    expect(json.items[0].payload).toEqual({ suggestionId: "s1", name: "Cookbooks", suggestedBy: "b@example.com", status: "accepted", resolvedBy: "a@example.com" });
    expect(json.items[1].payload).toEqual({ count: 3, bookIds: ["a", "b", "c"] });
    expect(json).not.toHaveProperty("next");
    expect(d.store.list).toHaveBeenCalledWith("a@example.com", 50, undefined);
  });
  it("marks a pending row whose suggestion vanished as status 'unknown'", async () => {
    const d = deps(store(), { suggestions: { getSuggestion: vi.fn().mockResolvedValue(undefined) } });
    const { json } = parse(await handle(http("GET", "/api/notifications"), d));
    expect(json.items[0].payload.status).toBe("unknown");
  });
  it("clamps limit, passes the cursor, and echoes next", async () => {
    const s = store({ list: vi.fn().mockResolvedValue({ items: [], next: "2026-01-01T00:00:00.000Z#x" }) });
    const { json } = parse(await handle(http("GET", "/api/notifications", { query: { limit: "500", before: "2026-02-02T00:00:00.000Z#y" } }), deps(s)));
    expect(s.list).toHaveBeenCalledWith("a@example.com", MAX_LIMIT, "2026-02-02T00:00:00.000Z#y");
    expect(json.next).toBe("2026-01-01T00:00:00.000Z#x");
    await handle(http("GET", "/api/notifications", { query: { limit: "0" } }), deps(s));
    expect(s.list).toHaveBeenLastCalledWith("a@example.com", 1, undefined);
  });
  it("400s a malformed cursor and 401s a token without email", async () => {
    expect(parse(await handle(http("GET", "/api/notifications", { query: { before: "nope" } }), deps())).status).toBe(400);
    expect(parse(await handle(http("GET", "/api/notifications", { claims: {} }), deps())).status).toBe(401);
  });
});

describe("POST /api/notifications/read", () => {
  it("marks the given ids read for the caller", async () => {
    const d = deps();
    expect(parse(await handle(http("POST", "/api/notifications/read", { body: { ids: ["2026-09-05T09:00:00.000Z#n1"] } }), d)).status).toBe(204);
    expect(d.store.markRead).toHaveBeenCalledWith("a@example.com", ["2026-09-05T09:00:00.000Z#n1"]);
  });
  it("marks all read", async () => {
    const d = deps();
    expect(parse(await handle(http("POST", "/api/notifications/read", { body: { all: true } }), d)).status).toBe(204);
    expect(d.store.markAllRead).toHaveBeenCalledWith("a@example.com");
  });
  it("400s bad bodies: missing, too many ids, non-string ids, empty ids", async () => {
    for (const body of [undefined, { ids: Array.from({ length: 101 }, (_, i) => `2026-09-05T09:00:00.000Z#${i}`) }, { ids: [1] }, { ids: [] }, { all: false }]) {
      expect(parse(await handle(http("POST", "/api/notifications/read", { body }), deps())).status).toBe(400);
    }
  });
  it("404s unknown routes", async () => {
    expect(parse(await handle(http("DELETE", "/api/notifications"), deps())).status).toBe(404);
  });
});

describe("direct invoke from the indexer", () => {
  it("fans out books_added to everyone", async () => {
    const d = deps();
    const out = await handle({ source: "indexer", type: "books_added", count: 3, bookIds: ["a", "b", "c"] }, d);
    expect(out).toEqual({ ok: true, recipients: 4 });
    expect(d.notify).toHaveBeenCalledWith("books_added", { count: 3, bookIds: ["a", "b", "c"] }, "everyone");
  });
  it("rejects malformed events without writing", async () => {
    const d = deps();
    for (const ev of [
      { source: "cron", type: "books_added", count: 1, bookIds: ["a"] },
      { source: "indexer", type: "category_created", count: 1, bookIds: ["a"] },
      { source: "indexer", type: "books_added", count: 0, bookIds: [] },
      { source: "indexer", type: "books_added", count: 1.5, bookIds: ["a"] },
      { source: "indexer", type: "books_added", count: 1, bookIds: Array.from({ length: 21 }, (_, i) => `b${i}`) },
      { source: "indexer", type: "books_added", count: 1, bookIds: [7] },
    ]) {
      const out = await handle(ev, d);
      expect(out).toMatchObject({ ok: false });
    }
    expect(d.notify).not.toHaveBeenCalled();
  });
  it("reports a fan-out failure", async () => {
    const d = deps(store(), { notify: vi.fn().mockRejectedValue(new Error("cognito down")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handle({ source: "indexer", type: "books_added", count: 1, bookIds: ["a"] }, d)).toEqual({ ok: false, error: "cognito down" });
    spy.mockRestore();
  });
});

describe("failures", () => {
  it("500s with JSON when the store throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, json } = parse(await handle(http("GET", "/api/notifications"), deps(store({ list: vi.fn().mockRejectedValue(new Error("boom")) }))));
    expect(status).toBe(500);
    expect(json).toEqual({ error: "Internal error" });
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/notifications-handler.test.ts`
Expected: FAIL — `Cannot find module '../lambda/notifications/index'`.

- [ ] **Step 3: Write the handler**

```ts
// infra/lambda/notifications/index.ts
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import type { NotificationType, NotifyFn } from "./fanout";

export interface NotificationRecord { id: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationStore {
  list(email: string, limit: number, before?: string): Promise<{ items: NotificationRecord[]; next?: string }>;
  countUnread(email: string): Promise<number>;
  markRead(email: string, ids: string[]): Promise<void>;
  markAllRead(email: string): Promise<void>;
}
export interface SuggestionLookup { getSuggestion(id: string): Promise<{ status: string; resolvedBy?: string } | undefined> }
export interface Deps { store: NotificationStore; suggestions: SuggestionLookup; notify: NotifyFn; now: () => Date }
export interface IndexerEvent { source: "indexer"; type: "books_added"; count: number; bookIds: string[] }
export type InvokeResult = { ok: true; recipients: number } | { ok: false; error: string };

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_READ_IDS = 100;
export const MAX_BOOK_IDS = 20;
// "<ISO timestamp>#<id>" — what the store hands out as `id`/`next` (the id part is a uuid in production).
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[A-Za-z0-9-]{1,64}$/;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function parseIndexerEvent(ev: Record<string, unknown>): IndexerEvent | string {
  if (ev.source !== "indexer") return "source must be 'indexer'";
  if (ev.type !== "books_added") return "type must be 'books_added'";
  if (!Number.isInteger(ev.count) || (ev.count as number) < 1) return "count must be an integer >= 1";
  const ids = ev.bookIds;
  if (!Array.isArray(ids) || ids.length > MAX_BOOK_IDS || !ids.every((x) => typeof x === "string" && x.length > 0)) {
    return `bookIds must be up to ${MAX_BOOK_IDS} non-empty strings`;
  }
  return { source: "indexer", type: "books_added", count: ev.count as number, bookIds: ids as string[] };
}

async function handleInvoke(ev: Record<string, unknown>, deps: Deps): Promise<InvokeResult> {
  const parsed = parseIndexerEvent(ev);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  try {
    const recipients = await deps.notify("books_added", { count: parsed.count, bookIds: parsed.bookIds }, "everyone");
    return { ok: true, recipients };
  } catch (e) {
    console.error("books_added fan-out failed:", e);
    return { ok: false, error: (e as Error).message };
  }
}

async function withSuggestionStatus(items: NotificationRecord[], lookup: SuggestionLookup): Promise<NotificationRecord[]> {
  const ids = [...new Set(items.filter((n) => n.type === "suggestion_pending").map((n) => String(n.payload.suggestionId)))];
  const statuses = new Map(await Promise.all(ids.map(async (id) => [id, await lookup.getSuggestion(id)] as const)));
  return items.map((n) => {
    if (n.type !== "suggestion_pending") return n;
    const s = statuses.get(String(n.payload.suggestionId));
    return { ...n, payload: { ...n.payload, status: s?.status ?? "unknown", ...(s?.resolvedBy ? { resolvedBy: s.resolvedBy } : {}) } };
  });
}

async function handleHttp(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = String(claims.email ?? "").toLowerCase();
  if (!email) return json(401, { error: "Token has no email claim (send the ID token)" });

  if (method === "GET" && path === "/api/notifications") {
    const q = event.queryStringParameters ?? {};
    const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit))) : DEFAULT_LIMIT;
    const before = q.before;
    if (before !== undefined && !ID_RE.test(before)) return json(400, { error: "Malformed cursor" });
    const [page, unread] = await Promise.all([deps.store.list(email, limit, before), deps.store.countUnread(email)]);
    const items = await withSuggestionStatus(page.items, deps.suggestions);
    return json(200, { items, unread, ...(page.next ? { next: page.next } : {}) });
  }

  if (method === "POST" && path === "/api/notifications/read") {
    let body: unknown;
    try { body = event.body ? JSON.parse(event.body) : undefined; } catch { body = undefined; }
    const b = (typeof body === "object" && body !== null ? body : {}) as { ids?: unknown; all?: unknown };
    if (b.all === true) { await deps.store.markAllRead(email); return { statusCode: 204 }; }
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READ_IDS || !ids.every((x) => typeof x === "string" && ID_RE.test(x))) {
      return json(400, { error: `Body must be {ids: [1..${MAX_READ_IDS} notification ids]} or {all: true}` });
    }
    await deps.store.markRead(email, ids as string[]);
    return { statusCode: 204 };
  }

  return json(404, { error: "Not found" });
}

export async function handle(
  event: APIGatewayProxyEventV2WithJWTAuthorizer | Record<string, unknown>, deps: Deps,
): Promise<APIGatewayProxyResultV2 | InvokeResult> {
  // A direct `lambda invoke` (from scripts/notify-books-added.py) has no API Gateway context.
  if (!("requestContext" in event)) return handleInvoke(event as Record<string, unknown>, deps);
  try {
    return await handleHttp(event as APIGatewayProxyEventV2WithJWTAuthorizer, deps);
  } catch (e) {
    console.error("notifications handler failed:", e);
    return json(500, { error: "Internal error" });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/notifications-handler.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/notifications/index.ts infra/test/notifications-handler.test.ts
git commit -m "feat(notifications): inbox handler and indexer direct-invoke path"
```

---

### Task 3: DynamoDB notification store and production wiring

**Files:**
- Create: `infra/lambda/notifications/store.ts`
- Modify: `infra/lambda/notifications/index.ts` (append production wiring)
- Test: `infra/test/notifications-store.test.ts`

**Interfaces:**
- Consumes: `NotificationStore`, `NotificationRecord` from `./index`; `DynamoStore` from `../library/store` (for `getSuggestion`); `CognitoDirectory`, `DynamoNotificationWriter`, `notify` from `./fanout`.
- Produces: `class DynamoNotificationStore implements NotificationStore` with `constructor(ddb: DynamoDBDocumentClient, table: string)`; `export const handler` in `index.ts` reading `NOTIFICATIONS_TABLE`, `LIBRARY_TABLE`, `USER_POOL_ID`.

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/notifications-store.test.ts
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoNotificationStore } from "../lambda/notifications/store";

const row = (sk: string, read = false) => ({
  pk: "USER#a@example.com", sk, type: "books_added", payload: { count: 1, bookIds: ["x"] }, read, createdAt: sk.split("#")[0], expiresAt: 1,
});
function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}
function condFail() { const e = new Error("cond") as Error & { name: string }; e.name = "ConditionalCheckFailedException"; return e; }

describe("DynamoNotificationStore.list", () => {
  it("queries newest-first with the limit and cursor and maps rows to records", async () => {
    const { ddb, send } = client(() => ({ Items: [row("2026-09-05T10:00:00.000Z#b"), row("2026-09-05T09:00:00.000Z#a", true)], LastEvaluatedKey: { pk: "USER#a@example.com", sk: "2026-09-05T09:00:00.000Z#a" } }));
    const out = await new DynamoNotificationStore(ddb, "T").list("a@example.com", 2, "2026-09-05T11:00:00.000Z#c");
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input).toEqual({
      TableName: "T", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "USER#a@example.com" },
      ScanIndexForward: false, Limit: 2, ExclusiveStartKey: { pk: "USER#a@example.com", sk: "2026-09-05T11:00:00.000Z#c" },
    });
    expect(out.items).toEqual([
      { id: "2026-09-05T10:00:00.000Z#b", type: "books_added", payload: { count: 1, bookIds: ["x"] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" },
      { id: "2026-09-05T09:00:00.000Z#a", type: "books_added", payload: { count: 1, bookIds: ["x"] }, read: true, createdAt: "2026-09-05T09:00:00.000Z" },
    ]);
    expect(out.next).toBe("2026-09-05T09:00:00.000Z#a");
  });
  it("omits next on the last page and ExclusiveStartKey without a cursor", async () => {
    const { ddb, send } = client(() => ({ Items: [] }));
    const out = await new DynamoNotificationStore(ddb, "T").list("a@example.com", 50);
    expect(out).toEqual({ items: [] });
    expect((send.mock.calls[0][0] as QueryCommand).input).not.toHaveProperty("ExclusiveStartKey");
  });
});

describe("DynamoNotificationStore.countUnread", () => {
  it("sums COUNT queries across pages with the read=false filter", async () => {
    const pages = [{ Count: 3, LastEvaluatedKey: { pk: "p", sk: "s" } }, { Count: 2 }];
    const { ddb, send } = client(() => pages.shift());
    expect(await new DynamoNotificationStore(ddb, "T").countUnread("a@example.com")).toBe(5);
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd.input).toMatchObject({
      TableName: "T", Select: "COUNT", KeyConditionExpression: "pk = :pk", FilterExpression: "#read = :f",
      ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":pk": "USER#a@example.com", ":f": false },
    });
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: "p", sk: "s" });
  });
});

describe("DynamoNotificationStore.markRead / markAllRead", () => {
  it("updates each id under the caller's pk, ignoring ids that do not exist", async () => {
    let n = 0;
    const { ddb, send } = client(() => { n += 1; if (n === 2) throw condFail(); return {}; });
    await new DynamoNotificationStore(ddb, "T").markRead("a@example.com", ["2026-09-05T10:00:00.000Z#b", "2026-09-05T09:00:00.000Z#zz"]);
    expect(send).toHaveBeenCalledTimes(2);
    const cmd = send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input).toEqual({
      TableName: "T", Key: { pk: "USER#a@example.com", sk: "2026-09-05T10:00:00.000Z#b" },
      UpdateExpression: "SET #read = :t", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":t": true },
    });
  });
  it("markAllRead finds unread keys then updates them", async () => {
    const { ddb, send } = client((cmd) => (cmd instanceof QueryCommand ? { Items: [{ sk: "2026-09-05T10:00:00.000Z#b" }, { sk: "2026-09-05T09:00:00.000Z#a" }] } : {}));
    await new DynamoNotificationStore(ddb, "T").markAllRead("a@example.com");
    const q = send.mock.calls[0][0] as QueryCommand;
    expect(q.input).toMatchObject({ ProjectionExpression: "sk", FilterExpression: "#read = :f" });
    expect(send.mock.calls.slice(1).map((c) => (c[0] as UpdateCommand).input.Key)).toEqual([
      { pk: "USER#a@example.com", sk: "2026-09-05T10:00:00.000Z#b" }, { pk: "USER#a@example.com", sk: "2026-09-05T09:00:00.000Z#a" },
    ]);
  });
  it("rethrows unexpected errors", async () => {
    const { ddb } = client(() => { throw new Error("network"); });
    await expect(new DynamoNotificationStore(ddb, "T").markRead("a@example.com", ["2026-09-05T10:00:00.000Z#b"])).rejects.toThrow("network");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/notifications-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the store and wiring**

```ts
// infra/lambda/notifications/store.ts
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { NotificationRecord, NotificationStore } from "./index";

type Item = Record<string, unknown>;
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

function toRecord(i: Item): NotificationRecord {
  return {
    id: String(i.sk), type: i.type as NotificationRecord["type"], payload: (i.payload ?? {}) as Record<string, unknown>,
    read: i.read === true, createdAt: String(i.createdAt),
  };
}

export class DynamoNotificationStore implements NotificationStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async list(email: string, limit: number, before?: string) {
    const pk = pkOf(email);
    const out = await this.ddb.send(new QueryCommand({
      TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false, Limit: limit, ...(before ? { ExclusiveStartKey: { pk, sk: before } } : {}),
    }));
    const items = ((out.Items ?? []) as Item[]).map(toRecord);
    const next = out.LastEvaluatedKey?.sk as string | undefined;
    return next ? { items, next } : { items };
  }

  private async unreadPages(email: string, extra: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const pages: Array<Record<string, unknown>> = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      const out = await this.ddb.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk", FilterExpression: "#read = :f",
        ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":pk": pkOf(email), ":f": false },
        ...extra, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      pages.push(out as Record<string, unknown>);
      ExclusiveStartKey = out.LastEvaluatedKey as Item | undefined;
    } while (ExclusiveStartKey);
    return pages;
  }

  async countUnread(email: string) {
    const pages = await this.unreadPages(email, { Select: "COUNT" });
    return pages.reduce((n, p) => n + Number(p.Count ?? 0), 0);
  }

  async markRead(email: string, ids: string[]) {
    await Promise.all(ids.map(async (sk) => {
      try {
        await this.ddb.send(new UpdateCommand({
          TableName: this.table, Key: { pk: pkOf(email), sk }, UpdateExpression: "SET #read = :t",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":t": true },
        }));
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e; // a foreign or expired id is a no-op
      }
    }));
  }

  async markAllRead(email: string) {
    const pages = await this.unreadPages(email, { ProjectionExpression: "sk" });
    const ids = pages.flatMap((p) => ((p.Items ?? []) as Item[]).map((i) => String(i.sk)));
    if (ids.length > 0) await this.markRead(email, ids);
  }
}
```

Append to `infra/lambda/notifications/index.ts`:

```ts
// ---- production wiring (never exercised by tests) ----
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { DynamoStore } from "../library/store";
import { CognitoDirectory, DynamoNotificationWriter, notify } from "./fanout";
import { DynamoNotificationStore } from "./store";

let productionDeps: Deps | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer | Record<string, unknown>) => {
  if (!productionDeps) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const notifyDeps = {
      directory: new CognitoDirectory(new CognitoIdentityProviderClient({}), process.env.USER_POOL_ID ?? ""),
      writer: new DynamoNotificationWriter(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      now: () => new Date(), newId: () => randomUUID(),
    };
    productionDeps = {
      store: new DynamoNotificationStore(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      suggestions: new DynamoStore(ddb, process.env.LIBRARY_TABLE ?? ""),
      notify: (type, payload, recipients) => notify(type, payload, recipients, notifyDeps),
      now: () => new Date(),
    };
  }
  return handle(event, productionDeps);
};
```

(`DynamoStore.getSuggestion` returns the full `Suggestion`, which structurally satisfies `SuggestionLookup`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/notifications/store.ts infra/lambda/notifications/index.ts infra/test/notifications-store.test.ts
git commit -m "feat(notifications): DynamoDB inbox store and production handler"
```

---

### Task 4: `Notifications` CDK construct and stack wiring

**Files:**
- Create: `infra/lib/notifications.ts`
- Modify: `infra/lib/ebook-share-stack.ts`
- Test: `infra/test/notifications-construct.test.ts`, `infra/test/stack.test.ts`

**Interfaces:**
- Produces: `class Notifications extends Construct` with `readonly table: dynamodb.Table`, `readonly fn: NodejsFunction`, `constructor(scope, id, props: { httpApi: apigw.HttpApi; userPool: cognito.IUserPool })`; stack output `NotificationsFunctionName`. The library-table read grant and `LIBRARY_TABLE` env for this Lambda are applied **in the stack** (to avoid a construct-order cycle with `Library`, which Task 5 makes depend on this table).

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/notifications-construct.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { describe, it } from "vitest";
import { Notifications } from "../lib/notifications";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const httpApi = new apigw.HttpApi(stack, "HttpApi");
  const userPool = new cognito.UserPool(stack, "Pool");
  new Notifications(stack, "Notifications", { httpApi, userPool });
  return Template.fromStack(stack);
}

describe("Notifications", () => {
  it("creates a disposable on-demand table with a TTL on expiresAt", () => {
    const t = synth();
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    });
  });
  it("wires the Lambda with table read/write, Cognito list permissions on the pool, and two routes", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: Match.objectLike({ NOTIFICATIONS_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"],
        Resource: Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^Pool"), "Arn"] }),
      })]) },
    });
    for (const key of ["GET /api/notifications", "POST /api/notifications/read"]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
    t.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
  });
});
```

In `infra/test/stack.test.ts`: change `t.resourceCountIs("AWS::DynamoDB::Table", 2)` to `3`; add `"NotificationsFunctionName"` to the outputs list; change `expect(authorized.length).toBeGreaterThanOrEqual(8)` to `10`; and add:

```ts
  it("lets the notifications Lambda read the library table", () => {
    const t = synthStack();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ NOTIFICATIONS_TABLE: Match.anyValue(), LIBRARY_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue() }) },
    });
  });
```

(`Match` is already imported in that file; if not, add it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/notifications-construct.test.ts test/stack.test.ts`
Expected: FAIL — module missing; stack counts off.

- [ ] **Step 3: Write the construct and wire the stack**

```ts
// infra/lib/notifications.ts
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "node:path";

export interface NotificationsProps {
  httpApi: apigw.HttpApi;
  userPool: cognito.IUserPool;
}

export const COGNITO_LIST_ACTIONS = ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"];

// Per-recipient notification inbox. See docs/superpowers/specs/2026-09-05-notifications-design.md.
// The table is disposable (90-day TTL, not retained, not backed up).
export class Notifications extends Construct {
  readonly table: dynamodb.Table;
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: NotificationsProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/notifications/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: { NOTIFICATIONS_TABLE: this.table.tableName, USER_POOL_ID: props.userPool.userPoolId },
    });
    this.table.grantReadWriteData(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: COGNITO_LIST_ACTIONS, resources: [props.userPool.userPoolArn] }));

    const integration = new HttpLambdaIntegration("NotificationsIntegration", this.fn);
    props.httpApi.addRoutes({ path: "/api/notifications", methods: [apigw.HttpMethod.GET], integration });
    props.httpApi.addRoutes({ path: "/api/notifications/read", methods: [apigw.HttpMethod.POST], integration });

    new CfnOutput(this, "FunctionName", { value: this.fn.functionName });
  }
}
```

In `infra/lib/ebook-share-stack.ts`: import `Notifications`; after `api` and **before** `library`, add
`const notifications = new Notifications(this, "Notifications", { httpApi: api.httpApi, userPool: auth.userPool });`;
after `library` is created add
`library.table.grantReadData(notifications.fn); notifications.fn.addEnvironment("LIBRARY_TABLE", library.table.tableName);`;
and add the output `new CfnOutput(this, "NotificationsFunctionName", { value: notifications.fn.functionName });`.
(The construct's own `FunctionName` output is namespaced — the stack-level one is what `outputs.json` consumers read; keep both, or drop the construct-level one if `cdk synth` complains about duplicate export names — it will not, they are distinct logical ids.)

- [ ] **Step 4: Run tests, typecheck, synth**

Run: `cd infra && npm test && npm run typecheck && npx cdk synth > /dev/null`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/notifications.ts infra/lib/ebook-share-stack.ts infra/test/notifications-construct.test.ts infra/test/stack.test.ts
git commit -m "feat(infra): notifications table, Lambda, and routes"
```

---

### Task 5: Library Lambda emits notifications

**Files:**
- Modify: `infra/lambda/library/index.ts`
- Modify: `infra/lib/library.ts`
- Test: `infra/test/library-handler.test.ts`, `infra/test/library.test.ts`

**Interfaces:**
- Consumes: `notify`, `CognitoDirectory`, `DynamoNotificationWriter`, `NotifyFn` from `../notifications/fanout`; `COGNITO_LIST_ACTIONS` from `../../lib/notifications` is **not** importable from Lambda code — the CDK side imports it from `./notifications`.
- Produces: `Deps.notify: NotifyFn` on the library handler; `LibraryProps` gains `notificationsTable: dynamodb.ITable; userPool: cognito.IUserPool`; env `NOTIFICATIONS_TABLE`, `USER_POOL_ID`.

- [ ] **Step 1: Write the failing tests**

In `infra/test/library-handler.test.ts`, extend `deps()` to include `notify: vi.fn().mockResolvedValue(1)` and add:

```ts
describe("notifications", () => {
  it("suggest notifies admins with the suggestion payload", async () => {
    const d = deps();
    await handle(event("POST", "/api/suggestions", { name: "Cookery", bookId: "b1" }), d);
    expect(d.notify).toHaveBeenCalledWith("suggestion_pending", { suggestionId: "id-1", name: "Cookery", bookId: "b1", suggestedBy: "u@x" }, "admins");
  });
  it("accept notifies the suggester and everyone; reject notifies the suggester", async () => {
    const d = deps();
    await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin), d);
    expect(d.notify).toHaveBeenNthCalledWith(1, "suggestion_resolved", { suggestionId: "s1", name: "Cookbooks", status: "accepted", resolvedBy: "a@x", bookId: "b1" }, ["z@x"]);
    expect(d.notify).toHaveBeenNthCalledWith(2, "category_created", { name: "Cookbooks", createdBy: "a@x", source: "suggestion" }, "everyone");
    const r = deps();
    await handle(event("POST", "/api/suggestions/s1/reject", undefined, admin), r);
    expect(r.notify).toHaveBeenCalledWith("suggestion_resolved", { suggestionId: "s1", name: "Cookbooks", status: "rejected", resolvedBy: "a@x", bookId: "b1" }, ["z@x"]);
  });
  it("direct category creation notifies everyone", async () => {
    const d = deps();
    await handle(event("POST", "/api/categories", { name: "Essays" }, admin), d);
    expect(d.notify).toHaveBeenCalledWith("category_created", { name: "Essays", createdBy: "a@x", source: "admin" }, "everyone");
  });
  it("does not notify on failed writes, and a notify failure does not change the response", async () => {
    const dup = deps(store({ putCategory: vi.fn().mockResolvedValue(false) }));
    await handle(event("POST", "/api/categories", { name: "Fresh" }, admin), dup);
    expect(dup.notify).not.toHaveBeenCalled();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = deps(store(), { notify: vi.fn().mockRejectedValue(new Error("cognito down")) });
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "Cookery" }), broken)).status).toBe(201);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

(`deps()` in that file currently takes one argument; change its signature to `deps(s: Store = store(), over: Partial<Deps> = {})` and spread `over` last.)

In `infra/test/library.test.ts`, update `synth()` to pass the new props — create `const userPool = new cognito.UserPool(stack, "Pool")` and `const notificationsTable = new dynamodb.Table(stack, "Notif", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING } })` and pass `{ httpApi, notificationsTable, userPool }` — and add:

```ts
  it("may write notifications and list Cognito users", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ LIBRARY_TABLE: Match.anyValue(), NOTIFICATIONS_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"],
      })]) },
    });
  });
```

(The existing "read/write on the library table only" test still passes: its `arrayWith` matches the library-table statement; the notifications-table write grant is a separate statement. Adjust its `Resource` assertion only if it fails, keeping the intent that the library table statement exists.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/library-handler.test.ts test/library.test.ts`
Expected: FAIL — `notify` never called; construct props missing.

- [ ] **Step 3: Implement**

`infra/lambda/library/index.ts`:
- `import type { NotifyFn } from "../notifications/fanout";` and change `Deps` to `{ store: Store; now: () => Date; newId: () => string; notify: NotifyFn }`.
- Add above `dispatch`:

```ts
// Best-effort: the primary write has already succeeded; a fan-out failure is logged, never surfaced.
async function safeNotify(deps: Deps, ...args: Parameters<NotifyFn>): Promise<void> {
  try {
    await deps.notify(...args);
  } catch (e) {
    console.error("notify failed:", args[0], e);
  }
}
```

- In `case "suggest"`, after `await store.putSuggestion(...)` and before `return json(201, { id })`:
  `await safeNotify(deps, "suggestion_pending", { suggestionId: id, name: n.name, ...(bookId ? { bookId } : {}), suggestedBy: email }, "admins");`
- In `case "createCategory"`, after the `if (!created)` guard: `await safeNotify(deps, "category_created", { name: n.name, createdBy: email, source: "admin" }, "everyone");`
- In `case "accept"`, after the `if (!ok)` guard:
  ```ts
  await safeNotify(deps, "suggestion_resolved", { suggestionId: s.id, name: s.name, status: "accepted", resolvedBy: email, ...(s.bookId ? { bookId: s.bookId } : {}) }, [s.suggestedBy]);
  await safeNotify(deps, "category_created", { name: s.name, createdBy: email, source: "suggestion" }, "everyone");
  ```
- In `case "reject"`, after the `if (!ok)` guard:
  `await safeNotify(deps, "suggestion_resolved", { suggestionId: s.id, name: s.name, status: "rejected", resolvedBy: email, ...(s.bookId ? { bookId: s.bookId } : {}) }, [s.suggestedBy]);`
- Production wiring: build `notifyDeps` exactly as in Task 3 (`CognitoDirectory(new CognitoIdentityProviderClient({}), process.env.USER_POOL_ID ?? "")`, `DynamoNotificationWriter(ddb, process.env.NOTIFICATIONS_TABLE ?? "")`) and set `notify: (type, payload, recipients) => notify(type, payload, recipients, notifyDeps)`; reuse the one `ddb` client for both stores.

`infra/lib/library.ts`: add `notificationsTable: dynamodb.ITable; userPool: cognito.IUserPool;` to `LibraryProps` (import `cognito`, `iam`, and `COGNITO_LIST_ACTIONS` from `./notifications`); add `NOTIFICATIONS_TABLE: props.notificationsTable.tableName, USER_POOL_ID: props.userPool.userPoolId` to the environment; after `this.table.grantReadWriteData(fn)` add `props.notificationsTable.grantWriteData(fn);` and `fn.addToRolePolicy(new iam.PolicyStatement({ actions: COGNITO_LIST_ACTIONS, resources: [props.userPool.userPoolArn] }));`.

`infra/lib/ebook-share-stack.ts`: `new Library(this, "Library", { httpApi: api.httpApi, notificationsTable: notifications.table, userPool: auth.userPool })`.

- [ ] **Step 4: Run tests, typecheck, synth**

Run: `cd infra && npm test && npm run typecheck && npx cdk synth > /dev/null`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/library/index.ts infra/lib/library.ts infra/lib/ebook-share-stack.ts infra/test/library-handler.test.ts infra/test/library.test.ts
git commit -m "feat(library): emit suggestion and category notifications"
```

---

### Task 6: `notify-books-added.py` and the `publish-new.sh` hook

**Files:**
- Create: `scripts/notify-books-added.py`
- Modify: `scripts/publish-new.sh`
- Test: `indexer/tests/test_notify_books_added.py`

**Interfaces:**
- Produces: CLI `scripts/notify-books-added.py --before <keys.json> --added <added.json> [--outputs infra/outputs.json] [--region us-east-1] [--dry-run]`. Computes `new_ids = keys(added) − keys(before)`; with none, prints `no new books; nothing to notify` and exits 0; otherwise builds `{"source":"indexer","type":"books_added","count":N,"bookIds":<first 20, sorted>}`, and with `--dry-run` prints the payload as JSON; otherwise invokes `NotificationsFunctionName` from `outputs.json` via boto3 and prints the response. Any failure (missing output, invoke error, non-ok response) prints `warning: …` to stderr and **exits 0** — the publish already succeeded. Pure helpers `new_book_ids(before: dict, added: dict) -> list[str]` and `build_payload(new_ids: list[str]) -> dict` are importable for tests.

- [ ] **Step 1: Write the failing tests**

```python
# indexer/tests/test_notify_books_added.py
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "notify-books-added.py"


def load_module():
    spec = importlib.util.spec_from_file_location("notify_books_added", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_new_book_ids_and_payload_cap():
    m = load_module()
    before = {"a": "2026-01-01"}
    added = {"a": "2026-01-01", **{f"b{i:02d}": "2026-09-05" for i in range(25)}}
    ids = m.new_book_ids(before, added)
    assert len(ids) == 25 and ids == sorted(ids)
    payload = m.build_payload(ids)
    assert payload == {"source": "indexer", "type": "books_added", "count": 25, "bookIds": ids[:20]}


def run(tmp_path, before, added, *extra):
    b = tmp_path / "before.json"
    a = tmp_path / "added.json"
    b.write_text(json.dumps(before))
    a.write_text(json.dumps(added))
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--before", str(b), "--added", str(a), *extra],
        capture_output=True, text=True,
    )


def test_dry_run_prints_payload_and_no_delta_is_a_noop(tmp_path):
    r = run(tmp_path, {"a": "x"}, {"a": "x", "b": "y"}, "--dry-run")
    assert r.returncode == 0
    assert json.loads(r.stdout.strip().splitlines()[-1]) == {"source": "indexer", "type": "books_added", "count": 1, "bookIds": ["b"]}
    r = run(tmp_path, {"a": "x"}, {"a": "x"}, "--dry-run")
    assert r.returncode == 0 and "nothing to notify" in r.stdout


def test_missing_outputs_is_a_warning_not_a_failure(tmp_path):
    r = run(tmp_path, {}, {"b": "y"}, "--outputs", str(tmp_path / "missing.json"))
    assert r.returncode == 0
    assert "warning" in r.stderr
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd indexer && .venv/bin/pytest -q tests/test_notify_books_added.py`
Expected: FAIL — script not found.

- [ ] **Step 3: Write the script and hook**

```python
#!/usr/bin/env python3
"""Tell the site that new books were published.

Run by scripts/publish-new.sh after a successful publish. Computes which book ids
are new (added.json keys now vs. a snapshot taken before the run) and invokes the
notifications Lambda (stack output NotificationsFunctionName) so everyone gets a
"N new books added" notification. Never fails the publish: any problem is a
warning and exit 0.

Usage: scripts/notify-books-added.py --before before.json --added metadata/added.json
                                     [--outputs infra/outputs.json] [--region us-east-1] [--dry-run]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BOOK_IDS = 20


def new_book_ids(before: dict, added: dict) -> list[str]:
    return sorted(set(added) - set(before))


def build_payload(new_ids: list[str]) -> dict:
    return {"source": "indexer", "type": "books_added", "count": len(new_ids), "bookIds": new_ids[:MAX_BOOK_IDS]}


def warn(msg: str) -> int:
    print(f"warning: {msg}", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True)
    ap.add_argument("--added", required=True)
    ap.add_argument("--outputs", default=str(ROOT / "infra" / "outputs.json"))
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv[1:])

    before = json.loads(Path(args.before).read_text()) if Path(args.before).exists() else {}
    added = json.loads(Path(args.added).read_text())
    ids = new_book_ids(before, added)
    if not ids:
        print("no new books; nothing to notify")
        return 0
    payload = build_payload(ids)
    if args.dry_run:
        print(json.dumps(payload))
        return 0

    try:
        outputs = next(iter(json.loads(Path(args.outputs).read_text()).values()))
        fn = outputs["NotificationsFunctionName"]
    except (OSError, ValueError, KeyError, StopIteration) as e:
        return warn(f"could not find NotificationsFunctionName in {args.outputs} ({e}); books-added notification skipped")
    try:
        import boto3
        out = boto3.client("lambda", region_name=args.region).invoke(FunctionName=fn, Payload=json.dumps(payload).encode())
        result = json.loads(out["Payload"].read() or b"{}")
    except Exception as e:  # noqa: BLE001 — anything here is a warning by design
        return warn(f"invoke failed ({e}); books-added notification skipped")
    if not result.get("ok"):
        return warn(f"notifications Lambda refused the event: {result}")
    print(f"notified {result.get('recipients', '?')} recipient(s): {payload['count']} new books")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

`chmod +x scripts/notify-books-added.py`. Rewrite `scripts/publish-new.sh` as:

```bash
#!/usr/bin/env bash
# Index any new bundles and publish them: one command after dropping new folders into the library.
# Afterwards, tell the site which books are new so everyone gets a notification.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/indexer"
BEFORE=$(mktemp)
trap 'rm -f "$BEFORE"' EXIT
python3 -c "import json,os,sys;p='../metadata/added.json';json.dump(json.load(open(p)) if os.path.exists(p) else {}, open(sys.argv[1],'w'))" "$BEFORE"
.venv/bin/python -m ebook_indexer index --config ../config.yaml
after=$(python3 -c "import json;print(len(json.load(open('../metadata/added.json'))))")
before=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$BEFORE")
echo "new books: $((after - before))"
.venv/bin/python -m ebook_indexer publish --config ../config.yaml
echo "published — CloudFront invalidation requested for catalog.json"
REGION=$(python3 -c "import yaml;print(yaml.safe_load(open('../config.yaml')).get('aws_region','us-east-1'))" 2>/dev/null || echo us-east-1)
.venv/bin/python "$ROOT/scripts/notify-books-added.py" --before "$BEFORE" --added ../metadata/added.json --region "$REGION" || true
```

(`.venv/bin/python` has boto3 and PyYAML; the `|| true` is belt-and-braces — the script already exits 0 on warnings.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd indexer && .venv/bin/pytest -q && bash -n ../scripts/publish-new.sh`
Expected: PASS; `bash -n` silent.

- [ ] **Step 5: Commit**

```bash
git add scripts/notify-books-added.py scripts/publish-new.sh indexer/tests/test_notify_books_added.py
git commit -m "feat(scripts): notify everyone when publish-new adds books"
```

---

### Task 7: In-app router and `Link`

**Files:**
- Create: `web/src/route.ts`, `web/src/components/Link.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/Header.tsx`
- Test: `web/src/route.test.ts`, `web/src/components/Link.test.tsx`

**Interfaces:**
- Produces:

```ts
export function currentPath(): string                 // pathname with trailing slashes stripped, "/" for root
export function navigate(path: string): void          // pushState + dispatches "popstate" so every useRoute() updates
export function useRoute(): { path: string; search: string; navigate: (path: string) => void }
// Link: <a href> that calls navigate() on a plain left-click and lets modifier/middle clicks through
export default function Link(props: { href: string; className?: string; onClick?: () => void; children: ReactNode }): JSX.Element
```

  `Header` gains `bell?: ReactNode` (rendered before the email) and its `<h1>` becomes `<Link href="/">Lit Library</Link>`. `App` switches on `useRoute().path` instead of reading `window.location` directly.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/route.test.ts
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { currentPath, navigate, useRoute } from "./route";

beforeEach(() => window.history.replaceState({}, "", "/"));

describe("currentPath", () => {
  it("normalizes trailing slashes", () => {
    window.history.replaceState({}, "", "/notifications/");
    expect(currentPath()).toBe("/notifications");
    window.history.replaceState({}, "", "/");
    expect(currentPath()).toBe("/");
  });
});

describe("useRoute", () => {
  it("tracks navigate() and browser back/forward, and exposes the query string", () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current.path).toBe("/");
    act(() => result.current.navigate("/notifications"));
    expect(result.current.path).toBe("/notifications");
    expect(window.location.pathname).toBe("/notifications");
    act(() => navigate("/?category=Fiction"));
    expect(result.current.path).toBe("/");
    expect(result.current.search).toBe("?category=Fiction");
    act(() => { window.history.replaceState({}, "", "/terms"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.path).toBe("/terms");
  });
});
```

```tsx
// web/src/components/Link.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Link from "./Link";

beforeEach(() => window.history.replaceState({}, "", "/"));

describe("Link", () => {
  it("navigates in-app on a plain click and calls onClick", async () => {
    const onClick = vi.fn();
    render(<Link href="/notifications" onClick={onClick}>All</Link>);
    await userEvent.click(screen.getByRole("link", { name: "All" }));
    expect(window.location.pathname).toBe("/notifications");
    expect(onClick).toHaveBeenCalled();
  });
  it("leaves modifier clicks to the browser (default not prevented)", async () => {
    let prevented: boolean | undefined;
    render(<div onClick={(e) => { prevented = e.defaultPrevented; e.preventDefault(); }}><Link href="/notifications">All</Link></div>);
    const a = screen.getByRole("link", { name: "All" });
    const user = userEvent.setup();
    await user.keyboard("{Control>}");
    await user.click(a);
    await user.keyboard("{/Control}");
    expect(prevented).toBe(false);
    expect(window.location.pathname).toBe("/");
    await user.click(a);
    expect(prevented).toBe(true); // plain click: Link handled it
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/route.test.ts src/components/Link.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

```ts
// web/src/route.ts
import { useCallback, useEffect, useState } from "react";

// A deliberately tiny router: the app has three pages. Everything reads the
// URL through here so in-app navigation never reloads (and never re-runs sign-in).
export function currentPath(): string {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): { path: string; search: string; navigate: (path: string) => void } {
  const [state, setState] = useState(() => ({ path: currentPath(), search: window.location.search }));
  useEffect(() => {
    const onChange = () => setState({ path: currentPath(), search: window.location.search });
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  const go = useCallback((path: string) => navigate(path), []);
  return { path: state.path, search: state.search, navigate: go };
}
```

```tsx
// web/src/components/Link.tsx
import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../route";

interface Props { href: string; className?: string; onClick?: () => void; children: ReactNode }

export default function Link({ href, className, onClick, children }: Props) {
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onClick?.();
    navigate(href);
  }
  return <a href={href} className={className} onClick={handle}>{children}</a>;
}
```

`Header.tsx`:

```tsx
import type { ReactNode } from "react";
import Link from "./Link";

interface Props { email?: string; onSignOut: () => void; bell?: ReactNode }

export default function Header({ email, onSignOut, bell }: Props) {
  return (
    <header className="header">
      <h1><Link href="/">Lit Library</Link></h1>
      <div className="header-right">
        {bell}
        {email && <span className="who">{email}</span>}
        <button className="btn secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}
```

`App.tsx`: replace the `const path = window.location.pathname…` line with `const { path } = useRoute();` (import from `./route`); keep the `/privacy` and `/terms` branches. Append to `styles.css`: `.header h1 a { color: inherit; text-decoration: none; }` and `.header-right { display: flex; align-items: center; gap: 0.75rem; }` (and drop the `margin-right` from `.header .who`).

- [ ] **Step 4: Run tests, typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS (the App tests still pass — they set the path via `history.replaceState` before render).

- [ ] **Step 5: Commit**

```bash
git add web/src/route.ts web/src/route.test.ts web/src/components/Link.tsx web/src/components/Link.test.tsx web/src/components/Header.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat(web): minimal in-app router and Link"
```

---

### Task 8: `LibraryDataProvider` (session + catalog + overlay out of `Library`) and `?category=` seeding

**Files:**
- Create: `web/src/catalog/LibraryDataProvider.tsx`
- Modify: `web/src/components/Library.tsx`, `web/src/catalog/search.ts`, `web/src/App.tsx`
- Test: `web/src/catalog/LibraryDataProvider.test.tsx`, `web/src/components/Library.test.tsx`, `web/src/catalog/search.test.ts`

**Interfaces:**
- Produces:

```ts
export const SESSION_RENEW_MS = 90 * 60 * 1000;   // moves here; Library re-exports it
export interface LibraryData {
  books: Book[] | null; overlay: Overlay | null; loadError?: string; overlayError?: string;
  refreshOverlay(): Promise<void>; titleOf(bookId: string): string | undefined;
}
export function LibraryDataProvider(props: { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; children: ReactNode }): JSX.Element
export function useLibraryData(): LibraryData
// search.ts
export function filtersFromSearch(search: string): Filters   // ?category=A&category=B → category Set {A, B}; other keys ignored
```

  `Library` props become `{ apiUrl, getIdToken, fetchFn?, navigate?, isAdmin?, onChanged?: () => void }` — `onChanged` is called after every successful mutation (Task 12 wires it to `notifications.refresh`). `Library` reads `books/overlay/loadError/overlayError/refreshOverlay` from `useLibraryData()`, toasts `overlayError` once (`Category editing is unavailable right now (<message>)`), and seeds `filters` with `filtersFromSearch(window.location.search)`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/catalog/LibraryDataProvider.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LibraryDataProvider, useLibraryData } from "./LibraryDataProvider";
import type { Catalog } from "./types";

const catalog: Catalog = { generatedAt: "t", books: [
  { id: "1", title: "Attacking Network Protocols", authors: [], description: null, category: "Security & Hacking", subjects: [], publisher: null, bundle: "b", year: null, formats: [], coverUrl: null, addedAt: "2026-01-01" },
] };
const overlay = { categories: [{ name: "Fiction", source: "seed" }], bookCategories: { "1": "Fiction" }, suggestions: [] };

function fetchWith(overlayStatus = 200) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).replace(/^https?:\/\/[^/]+/, "")}`);
    if (String(url).endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
    if (String(url).endsWith("/library")) return { ok: overlayStatus < 300, status: overlayStatus, headers: new Headers({ "content-type": "application/json" }), json: async () => (overlayStatus < 300 ? overlay : { error: "down" }) };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => catalog };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function Probe() {
  const d = useLibraryData();
  return (
    <div>
      <span data-testid="books">{d.books?.length ?? "none"}</span>
      <span data-testid="cat">{d.overlay?.bookCategories["1"] ?? "-"}</span>
      <span data-testid="title">{d.titleOf("1") ?? "?"}{d.titleOf("zz") ?? "?"}</span>
      <span data-testid="err">{d.loadError ?? ""}|{d.overlayError ?? ""}</span>
      <button onClick={() => void d.refreshOverlay()}>refresh</button>
    </div>
  );
}

describe("LibraryDataProvider", () => {
  it("establishes the session, loads the catalog, then the overlay, and resolves titles", async () => {
    const { fetchFn, calls } = fetchWith();
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("cat")).toHaveTextContent("Fiction"));
    expect(screen.getByTestId("books")).toHaveTextContent("1");
    expect(screen.getByTestId("title")).toHaveTextContent("Attacking Network Protocols?");
    expect(calls.indexOf("GET /api/session")).toBeLessThan(calls.indexOf("GET /catalog.json"));
    expect(calls.indexOf("GET /catalog.json")).toBeLessThan(calls.indexOf("GET /api/library"));
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/library")).toHaveLength(2));
  });
  it("reports an overlay failure without touching the catalog", async () => {
    const { fetchFn } = fetchWith(502);
    render(<LibraryDataProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></LibraryDataProvider>);
    await waitFor(() => expect(screen.getByTestId("err")).toHaveTextContent("|down"));
    expect(screen.getByTestId("books")).toHaveTextContent("1");
    expect(screen.getByTestId("cat")).toHaveTextContent("-");
  });
});
```

Add to `web/src/catalog/search.test.ts`:

```ts
import { filtersFromSearch } from "./search";
describe("filtersFromSearch", () => {
  it("seeds the category facet from ?category= (repeatable) and ignores other keys", () => {
    const f = filtersFromSearch("?category=Fiction&category=Comics&sort=title");
    expect([...f.category]).toEqual(["Fiction", "Comics"]);
    expect(f.author.size).toBe(0);
    expect(filtersFromSearch("").category.size).toBe(0);
  });
});
```

In `web/src/components/Library.test.tsx`: add a `renderLibrary(props)` helper that renders `<LibraryDataProvider apiUrl={props.apiUrl} getIdToken={props.getIdToken} fetchFn={props.fetchFn}><Library {...props} /></LibraryDataProvider>` and use it in every test instead of bare `render(<Library …/>)`. The session-ordering, retry, and renewal tests keep their assertions (the provider performs those calls now). Add two tests:

```tsx
  it("seeds the category filter from the query string", async () => {
    window.history.replaceState({}, "", "/?category=Fiction");
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog) });
    await waitFor(() => expect(screen.getByRole("button", { name: /The Black Company/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Attacking Network Protocols/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Fiction/ })).toBeChecked();
    window.history.replaceState({}, "", "/");
  });
  it("calls onChanged after a successful mutation, not after a failed one", async () => {
    const onChanged = vi.fn();
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/1/category$": () => ({ ok: true, status: 204, headers: new Headers() }),
      "PUT /books/2/category$": () => ({ ok: false, status: 400, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "nope" }) }),
    });
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn, onChanged });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    await userEvent.selectOptions(within(screen.getByRole("dialog", { hidden: true })).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: /The Black Company/ }));
    await userEvent.selectOptions(within(screen.getByRole("dialog", { hidden: true })).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("nope"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/catalog/LibraryDataProvider.test.tsx src/catalog/search.test.ts src/components/Library.test.tsx`
Expected: FAIL — provider missing; `filtersFromSearch` missing.

- [ ] **Step 3: Implement**

```tsx
// web/src/catalog/LibraryDataProvider.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchOverlay, type Overlay } from "./library";
import { loadCatalog } from "./load";
import { establishSession } from "./session";
import type { Book } from "./types";

// The session cookie lasts 2h (SESSION_SECONDS); renew well within that
// window so a long-open tab never hits the stale-cookie fallback.
export const SESSION_RENEW_MS = 90 * 60 * 1000;

export interface LibraryData {
  books: Book[] | null;
  overlay: Overlay | null;
  loadError?: string;
  overlayError?: string;
  refreshOverlay(): Promise<void>;
  titleOf(bookId: string): string | undefined;
}

const Ctx = createContext<LibraryData | undefined>(undefined);

interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; children: ReactNode }

// Owns everything that has to be loaded once per signed-in session: the CloudFront
// session cookie, catalog.json, and the category overlay. Library renders from it;
// the notification bell resolves book titles through it.
export function LibraryDataProvider({ apiUrl, getIdToken, fetchFn = fetch, children }: Props) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [overlayError, setOverlayError] = useState<string>();

  const refreshOverlay = useCallback(async () => {
    setOverlay(await fetchOverlay(apiUrl, await getIdToken(), fetchFn));
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await establishSession(apiUrl, await getIdToken(), fetchFn);
        let catalog;
        try {
          catalog = await loadCatalog(fetchFn);
        } catch {
          // A stale/missing cookie makes CloudFront serve index.html instead; refresh once and retry.
          await establishSession(apiUrl, await getIdToken(), fetchFn);
          catalog = await loadCatalog(fetchFn);
        }
        if (!cancelled) setBooks(catalog.books);
        try {
          const o = await fetchOverlay(apiUrl, await getIdToken(), fetchFn);
          if (!cancelled) setOverlay(o);
        } catch (e) {
          // A broken library Lambda must not take the site down: consumers render read-only.
          if (!cancelled) setOverlayError((e as Error).message);
        }
      } catch (e) {
        if (!cancelled) setLoadError(`Could not load the catalog (${(e as Error).message}). Try reloading the page.`);
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, getIdToken, fetchFn]);

  useEffect(() => {
    const renew = () => {
      void getIdToken().then((t) => establishSession(apiUrl, t, fetchFn)).catch(() => { /* the next tick retries */ });
    };
    const id = setInterval(renew, SESSION_RENEW_MS);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") renew(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [apiUrl, getIdToken, fetchFn]);

  const titles = useMemo(() => new Map((books ?? []).map((b) => [b.id, b.title])), [books]);
  const titleOf = useCallback((id: string) => titles.get(id), [titles]);

  const value = useMemo<LibraryData>(() => ({ books, overlay, loadError, overlayError, refreshOverlay, titleOf }),
    [books, overlay, loadError, overlayError, refreshOverlay, titleOf]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibraryData(): LibraryData {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLibraryData must be used inside <LibraryDataProvider>");
  return ctx;
}
```

`search.ts` — append:

```ts
export function filtersFromSearch(search: string): Filters {
  const f = emptyFilters();
  for (const c of new URLSearchParams(search).getAll("category")) if (c) f.category.add(c);
  return f;
}
```

(import `emptyFilters` and `Filters` from `./types` if not already.)

`Library.tsx` — the extraction:
- Remove the `books`, `overlay`, `loadError` state, the `refreshOverlay` callback, and both `useEffect`s (load and renewal). Replace with `const { books, overlay, loadError, overlayError, refreshOverlay } = useLibraryData();`.
- `export { SESSION_RENEW_MS } from "../catalog/LibraryDataProvider";` at the top (keeps the existing test import working).
- `const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(window.location.search));`
- Toast the overlay failure once: `useEffect(() => { if (overlayError) fail(\`Category editing is unavailable right now (${overlayError})\`); }, [overlayError, fail]);`
- Add `onChanged?: () => void` to `Props`; in `mutate`, after `ok(success)`, call `onChanged?.()` (before the refresh try/catch); add `onChanged` to `mutate`'s dependency array.
- Remove now-unused imports (`loadCatalog`, `establishSession`, `fetchOverlay`).

`App.tsx`: wrap the signed-in tree: `<LibraryDataProvider apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn}><Header …/><Library …/></LibraryDataProvider>`.

- [ ] **Step 4: Run the suite, typecheck, build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS. Every pre-existing Library test passes through `renderLibrary`.

- [ ] **Step 5: Commit**

```bash
git add web/src/catalog/LibraryDataProvider.tsx web/src/catalog/LibraryDataProvider.test.tsx web/src/catalog/search.ts web/src/catalog/search.test.ts web/src/components/Library.tsx web/src/components/Library.test.tsx web/src/App.tsx
git commit -m "refactor(web): LibraryDataProvider owns session, catalog, and overlay; seed ?category="
```

---

### Task 9: Notifications client and `NotificationsProvider`

**Files:**
- Create: `web/src/catalog/apiCall.ts` (extracted), `web/src/notifications/api.ts`, `web/src/notifications/NotificationsProvider.tsx`
- Modify: `web/src/catalog/library.ts` (import `apiCall` from `./apiCall`; no behaviour change)
- Test: `web/src/notifications/api.test.ts`, `web/src/notifications/NotificationsProvider.test.tsx`

**Interfaces:**
- Produces:

```ts
// catalog/apiCall.ts — moved verbatim out of catalog/library.ts
export async function apiCall(apiUrl, idToken, path, init: RequestInit, expectStatus: number, fetchFn: typeof fetch): Promise<Response>
// notifications/api.ts
export type NotificationType = "suggestion_pending" | "suggestion_resolved" | "books_added" | "category_created";
export interface Notification { id: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationsPage { items: Notification[]; unread: number; next?: string }
export function fetchNotifications(apiUrl, idToken, opts?: { limit?: number; before?: string }, fetchFn?): Promise<NotificationsPage>
export function markNotificationsRead(apiUrl, idToken, target: string[] | "all", fetchFn?): Promise<void>
// notifications/NotificationsProvider.tsx
export const NOTIFICATIONS_POLL_MS = 5 * 60 * 1000; export const PAGE_SIZE = 50; export const POPOVER_COUNT = 5;
export interface NotificationsState {
  items: Notification[]; unread: number; status: "loading" | "ready" | "error"; error?: string; hasMore: boolean;
  seen: boolean;                       // true once any fetch has returned ≥ 1 item (bell visibility)
  refresh(): Promise<void>; loadMore(): Promise<void>; markRead(ids: string[]): Promise<void>; markAllRead(): Promise<void>;
}
export function NotificationsProvider(props: { apiUrl; getIdToken; fetchFn?; children }): JSX.Element
export function useNotifications(): NotificationsState
```

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/notifications/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { fetchNotifications, markNotificationsRead } from "./api";

function fetchWith(status: number, body?: unknown) {
  return vi.fn(async () => ({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body })) as unknown as typeof fetch;
}
const call = (f: typeof fetch, n = 0) => { const m = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[n]; return { url: String(m[0]), init: m[1] as RequestInit }; };

describe("fetchNotifications", () => {
  it("GETs with limit/before and validates the shape", async () => {
    const page = { items: [{ id: "2026-09-05T10:00:00.000Z#a", type: "books_added", payload: { count: 1, bookIds: ["x"] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" }], unread: 1, next: "2026-09-05T10:00:00.000Z#a" };
    const f = fetchWith(200, page);
    expect(await fetchNotifications("/api", "tok", { limit: 5, before: "2026-09-06T00:00:00.000Z#z" }, f)).toEqual(page);
    expect(call(f).url).toBe("/api/notifications?limit=5&before=2026-09-06T00%3A00%3A00.000Z%23z");
    expect((call(f).init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const g = fetchWith(200, page);
    await fetchNotifications("/api", "tok", {}, g);
    expect(call(g).url).toBe("/api/notifications");
    await expect(fetchNotifications("/api", "tok", {}, fetchWith(200, { items: "no" }))).rejects.toThrow(/malformed/);
    await expect(fetchNotifications("/api", "tok", {}, fetchWith(500, { error: "boom" }))).rejects.toThrow("boom");
  });
});

describe("markNotificationsRead", () => {
  it("POSTs ids or all and requires 204", async () => {
    const f = fetchWith(204);
    await markNotificationsRead("/api", "tok", ["2026-09-05T10:00:00.000Z#a"], f);
    expect(call(f).url).toBe("/api/notifications/read");
    expect(call(f).init.body).toBe(JSON.stringify({ ids: ["2026-09-05T10:00:00.000Z#a"] }));
    const g = fetchWith(204);
    await markNotificationsRead("/api", "tok", "all", g);
    expect(call(g).init.body).toBe(JSON.stringify({ all: true }));
    await expect(markNotificationsRead("/api", "tok", "all", fetchWith(400, { error: "bad" }))).rejects.toThrow("bad");
  });
});
```

```tsx
// web/src/notifications/NotificationsProvider.test.tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "./api";
import { NOTIFICATIONS_POLL_MS, NotificationsProvider, useNotifications } from "./NotificationsProvider";

const n = (i: number, read = false): Notification => ({
  id: `2026-09-05T10:00:0${i}.000Z#${i}`, type: "books_added", payload: { count: i, bookIds: [] }, read, createdAt: `2026-09-05T10:00:0${i}.000Z`,
});

function server(pages: Array<{ items: Notification[]; unread: number; next?: string }>, readStatus = 204) {
  const posted: string[] = [];
  let gets = 0;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(init.body)); return { ok: readStatus < 300, status: readStatus, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "x" }) }; }
    const page = pages[Math.min(gets, pages.length - 1)];
    gets += 1;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => page };
  }) as unknown as typeof fetch;
  return { fetchFn, posted, gets: () => gets };
}

function Probe() {
  const s = useNotifications();
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.items.length}</span>
      <span data-testid="unread">{s.unread}</span>
      <span data-testid="seen">{String(s.seen)}</span>
      <span data-testid="more">{String(s.hasMore)}</span>
      <button onClick={() => void s.markRead([s.items[0]?.id])}>read-first</button>
      <button onClick={() => void s.markAllRead()}>read-all</button>
      <button onClick={() => void s.loadMore()}>more</button>
      <button onClick={() => void s.refresh()}>refresh</button>
    </div>
  );
}
const mount = (fetchFn: typeof fetch) => render(<NotificationsProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}><Probe /></NotificationsProvider>);

afterEach(() => vi.useRealTimers());

describe("NotificationsProvider", () => {
  it("loads on mount, exposes unread/seen/hasMore, and appends on loadMore", async () => {
    const { fetchFn } = server([{ items: [n(1), n(2, true)], unread: 1, next: "2026-09-05T10:00:02.000Z#2" }, { items: [n(3)], unread: 1 }]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByTestId("seen")).toHaveTextContent("true");
    expect(screen.getByTestId("more")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("3"));
    expect(screen.getByTestId("more")).toHaveTextContent("false");
    expect(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain("before=2026-09-05T10%3A00%3A02.000Z%232");
  });
  it("markRead is optimistic and posts; a failed post refreshes from the server", async () => {
    const { fetchFn, posted } = server([{ items: [n(1), n(2)], unread: 2 }]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("2"));
    await userEvent.click(screen.getByRole("button", { name: "read-first" }));
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    await waitFor(() => expect(posted).toEqual([JSON.stringify({ ids: [n(1).id] })]));
    const failing = server([{ items: [n(1)], unread: 1 }], 500);
    mount(failing.fetchFn);
    await waitFor(() => expect(screen.getAllByTestId("unread")[1]).toHaveTextContent("1"));
    await userEvent.click(screen.getAllByRole("button", { name: "read-all" })[1]);
    await waitFor(() => expect(failing.gets()).toBe(2)); // refreshed after the failed POST
  });
  it("polls every NOTIFICATIONS_POLL_MS and on visibility, and reports errors without throwing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchFn, gets } = server([{ items: [], unread: 0 }]);
    mount(fetchFn);
    await waitFor(() => expect(gets()).toBe(1));
    expect(screen.getByTestId("seen")).toHaveTextContent("false");
    await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_MS + 10);
    expect(gets()).toBe(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(gets()).toBe(3));
    vi.useRealTimers();
    const broken = vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({ error: "down" }) })) as unknown as typeof fetch;
    mount(broken);
    await waitFor(() => expect(screen.getAllByTestId("status")[1]).toHaveTextContent("error"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/notifications`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

Move `errorMessage` and `apiCall` from `web/src/catalog/library.ts` into `web/src/catalog/apiCall.ts` (export `apiCall`; keep `errorMessage` private there) and `import { apiCall } from "./apiCall";` in `library.ts`. Behaviour unchanged; the library tests keep passing.

```ts
// web/src/notifications/api.ts
import { apiCall } from "../catalog/apiCall";

export type NotificationType = "suggestion_pending" | "suggestion_resolved" | "books_added" | "category_created";
export interface Notification { id: string; type: NotificationType; payload: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationsPage { items: Notification[]; unread: number; next?: string }

export async function fetchNotifications(
  apiUrl: string, idToken: string, opts: { limit?: number; before?: string } = {}, fetchFn: typeof fetch = fetch,
): Promise<NotificationsPage> {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const qs = q.toString();
  const res = await apiCall(apiUrl, idToken, `/notifications${qs ? `?${qs}` : ""}`, { method: "GET" }, 200, fetchFn);
  const body = (await res.json()) as Partial<NotificationsPage>;
  if (!Array.isArray(body?.items) || typeof body.unread !== "number") throw new Error("Notifications response is malformed");
  return body as NotificationsPage;
}

export async function markNotificationsRead(apiUrl: string, idToken: string, target: string[] | "all", fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/notifications/read",
    { method: "POST", body: JSON.stringify(target === "all" ? { all: true } : { ids: target }) }, 204, fetchFn);
}
```

```tsx
// web/src/notifications/NotificationsProvider.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchNotifications, markNotificationsRead, type Notification } from "./api";

export const NOTIFICATIONS_POLL_MS = 5 * 60 * 1000;
export const PAGE_SIZE = 50;
export const POPOVER_COUNT = 5;

export interface NotificationsState {
  items: Notification[]; unread: number; status: "loading" | "ready" | "error"; error?: string; hasMore: boolean; seen: boolean;
  refresh(): Promise<void>; loadMore(): Promise<void>; markRead(ids: string[]): Promise<void>; markAllRead(): Promise<void>;
}

const Ctx = createContext<NotificationsState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; children: ReactNode }

export function NotificationsProvider({ apiUrl, getIdToken, fetchFn = fetch, children }: Props) {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [next, setNext] = useState<string>();
  const [status, setStatus] = useState<NotificationsState["status"]>("loading");
  const [error, setError] = useState<string>();
  const [seen, setSeen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const page = await fetchNotifications(apiUrl, await getIdToken(), { limit: PAGE_SIZE }, fetchFn);
      if (!mounted.current) return;
      setItems(page.items); setUnread(page.unread); setNext(page.next); setStatus("ready"); setError(undefined);
      if (page.items.length > 0) setSeen(true);
    } catch (e) {
      if (!mounted.current) return;
      setStatus("error"); setError((e as Error).message);
    }
  }, [apiUrl, getIdToken, fetchFn]);

  const loadMore = useCallback(async () => {
    if (!next) return;
    const page = await fetchNotifications(apiUrl, await getIdToken(), { limit: PAGE_SIZE, before: next }, fetchFn);
    if (!mounted.current) return;
    setItems((cur) => [...cur, ...page.items]); setNext(page.next); setUnread(page.unread);
  }, [apiUrl, getIdToken, fetchFn, next]);

  // Optimistic: flip locally first so the badge reacts instantly; reconcile from the server on failure.
  // The unread delta is computed from itemsRef (not inside a state updater) so StrictMode's
  // double-invoked updaters cannot double-count.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const markRead = useCallback(async (ids: string[]) => {
    const targets = new Set(ids.filter(Boolean));
    if (targets.size === 0) return;
    const flipped = itemsRef.current.filter((n) => targets.has(n.id) && !n.read).length;
    if (flipped > 0) {
      setItems((cur) => cur.map((n) => (targets.has(n.id) && !n.read ? { ...n, read: true } : n)));
      setUnread((u) => Math.max(0, u - flipped));
    }
    try {
      await markNotificationsRead(apiUrl, await getIdToken(), [...targets], fetchFn);
    } catch {
      await refresh();
    }
  }, [apiUrl, getIdToken, fetchFn, refresh]);

  const markAllRead = useCallback(async () => {
    setItems((cur) => cur.map((n) => (n.read ? n : { ...n, read: true })));
    setUnread(0);
    try {
      await markNotificationsRead(apiUrl, await getIdToken(), "all", fetchFn);
    } catch {
      await refresh();
    }
  }, [apiUrl, getIdToken, fetchFn, refresh]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), NOTIFICATIONS_POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisibility); };
  }, [refresh]);

  const value = useMemo<NotificationsState>(() => ({
    items, unread, status, error, hasMore: Boolean(next), seen, refresh, loadMore, markRead, markAllRead,
  }), [items, unread, status, error, next, seen, refresh, loadMore, markRead, markAllRead]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return ctx;
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/catalog/apiCall.ts web/src/catalog/library.ts web/src/notifications/api.ts web/src/notifications/api.test.ts web/src/notifications/NotificationsProvider.tsx web/src/notifications/NotificationsProvider.test.tsx
git commit -m "feat(web): notifications client and provider with polling and optimistic read state"
```

---

### Task 10: Renderer table and `NotificationItem`

**Files:**
- Create: `web/src/notifications/render.ts`, `web/src/components/NotificationItem.tsx`
- Modify: `web/src/styles.css` (append)
- Test: `web/src/notifications/render.test.ts`, `web/src/components/NotificationItem.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface RenderContext { titleOf(bookId: string): string | undefined }
export interface Rendered { icon: string; text: string; href?: string }
export function renderNotification(n: Notification, ctx: RenderContext): Rendered
export function relativeTime(iso: string, nowMs?: number): string  // "just now" (<60s), "N min ago", "N h ago", "N d ago" (<14d), else "5 Sep 2026"
export function localPart(email: string): string
// NotificationItem
interface Props { n: Notification; isAdmin: boolean; titleOf(bookId: string): string | undefined; onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>; onNavigate?: () => void; nowMs?: number }
```

  Text per type (exact): `suggestion_pending` → `<who> suggested "<name>"` + ` for <title>` when the book resolves; `suggestion_resolved` → `Your suggestion "<name>" was accepted by <who>` / `Your suggestion "<name>" was rejected by <who>`; `books_added` → `<count> new books added` (`1 new book added`); `category_created` → `New category "<name>"`. Links: `category_created`, accepted `suggestion_resolved`, and `suggestion_pending` with `payload.status === "accepted"` → `/?category=<encoded name>`; `books_added` → `/`; otherwise none. Unknown type → icon `•`, text = the type, no link.
  Admin actions: for `suggestion_pending` with `isAdmin` and `payload.status === "pending"`, buttons `Accept <name>` / `Reject <name>` (aria-labels); resolved rows show `accepted by <who>` / `rejected` as muted text.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/notifications/render.test.ts
import { describe, expect, it } from "vitest";
import type { Notification } from "./api";
import { localPart, relativeTime, renderNotification } from "./render";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const mk = (type: Notification["type"], payload: Record<string, unknown>): Notification => ({ id: "x", type, payload, read: false, createdAt: "2026-09-05T11:00:00.000Z" });
const ctx = { titleOf: (id: string) => (id === "b1" ? "Black Hound of Death" : undefined) };

describe("renderNotification", () => {
  it("suggestion_pending with and without a resolvable book", () => {
    expect(renderNotification(mk("suggestion_pending", { suggestionId: "s", name: "Cosmic Horror", bookId: "b1", suggestedBy: "zach@example.com", status: "pending" }), ctx))
      .toEqual({ icon: "💡", text: 'zach suggested "Cosmic Horror" for Black Hound of Death' });
    expect(renderNotification(mk("suggestion_pending", { suggestionId: "s", name: "Cosmic Horror", bookId: "zz", suggestedBy: "zach@example.com", status: "accepted" }), ctx))
      .toEqual({ icon: "💡", text: 'zach suggested "Cosmic Horror"', href: "/?category=Cosmic%20Horror" });
  });
  it("suggestion_resolved, books_added, category_created, unknown", () => {
    expect(renderNotification(mk("suggestion_resolved", { suggestionId: "s", name: "Poetry", status: "accepted", resolvedBy: "jay@example.com" }), ctx))
      .toEqual({ icon: "✅", text: 'Your suggestion "Poetry" was accepted by jay', href: "/?category=Poetry" });
    expect(renderNotification(mk("suggestion_resolved", { suggestionId: "s", name: "Poetry", status: "rejected", resolvedBy: "jay@example.com" }), ctx))
      .toEqual({ icon: "🚫", text: 'Your suggestion "Poetry" was rejected by jay' });
    expect(renderNotification(mk("books_added", { count: 23, bookIds: [] }), ctx)).toEqual({ icon: "📚", text: "23 new books added", href: "/" });
    expect(renderNotification(mk("books_added", { count: 1, bookIds: [] }), ctx).text).toBe("1 new book added");
    expect(renderNotification(mk("category_created", { name: "Essays", createdBy: "jay@example.com", source: "admin" }), ctx))
      .toEqual({ icon: "🏷️", text: 'New category "Essays"', href: "/?category=Essays" });
    expect(renderNotification({ ...mk("books_added", {}), type: "surprise" as Notification["type"] }, ctx)).toEqual({ icon: "•", text: "surprise" });
  });
});

describe("relativeTime / localPart", () => {
  it("buckets by age", () => {
    expect(relativeTime("2026-09-05T11:59:30.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-09-05T11:45:00.000Z", NOW)).toBe("15 min ago");
    expect(relativeTime("2026-09-05T09:00:00.000Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-09-03T12:00:00.000Z", NOW)).toBe("2 d ago");
    expect(relativeTime("2026-08-01T12:00:00.000Z", NOW)).toBe("1 Aug 2026");
    expect(localPart("a.b@example.com")).toBe("a.b");
    expect(localPart("plain")).toBe("plain");
  });
});
```

```tsx
// web/src/components/NotificationItem.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../notifications/api";
import NotificationItem from "./NotificationItem";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const pending: Notification = { id: "2026-09-05T11:00:00.000Z#a", type: "suggestion_pending", payload: { suggestionId: "s1", name: "Cosmic Horror", bookId: "b1", suggestedBy: "zach@example.com", status: "pending" }, read: false, createdAt: "2026-09-05T11:00:00.000Z" };
const titleOf = (id: string) => (id === "b1" ? "Black Hound of Death" : undefined);

describe("NotificationItem", () => {
  it("renders text, relative time, unread marker, and a link when there is one", () => {
    const added: Notification = { ...pending, id: "x", type: "category_created", payload: { name: "Essays", createdBy: "jay@example.com", source: "admin" }, read: true };
    render(<ul><NotificationItem n={added} isAdmin={false} titleOf={titleOf} nowMs={NOW} /></ul>);
    expect(screen.getByRole("link", { name: 'New category "Essays"' })).toHaveAttribute("href", "/?category=Essays");
    expect(screen.getByText("1 h ago")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).not.toHaveClass("unread");
  });
  it("shows admin actions only for pending suggestions and calls onResolve", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ul><NotificationItem n={pending} isAdmin titleOf={titleOf} onResolve={onResolve} nowMs={NOW} /></ul>);
    expect(screen.getByText('zach suggested "Cosmic Horror" for Black Hound of Death')).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveClass("unread");
    await userEvent.click(screen.getByRole("button", { name: "Accept Cosmic Horror" }));
    expect(onResolve).toHaveBeenCalledWith("s1", "accept");
    rerender(<ul><NotificationItem n={pending} isAdmin={false} titleOf={titleOf} onResolve={onResolve} nowMs={NOW} /></ul>);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    rerender(<ul><NotificationItem n={{ ...pending, payload: { ...pending.payload, status: "accepted", resolvedBy: "jay@example.com" } }} isAdmin titleOf={titleOf} onResolve={onResolve} nowMs={NOW} /></ul>);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    expect(screen.getByText("accepted by jay")).toBeInTheDocument();
  });
  it("shows an inline error when onResolve rejects", async () => {
    render(<ul><NotificationItem n={pending} isAdmin titleOf={titleOf} onResolve={vi.fn().mockRejectedValue(new Error("Admin only"))} nowMs={NOW} /></ul>);
    await userEvent.click(screen.getByRole("button", { name: "Reject Cosmic Horror" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Admin only"));
    expect(screen.getByRole("button", { name: "Reject Cosmic Horror" })).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/notifications/render.test.ts src/components/NotificationItem.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

```ts
// web/src/notifications/render.ts
import type { Notification } from "./api";

export interface RenderContext { titleOf(bookId: string): string | undefined }
export interface Rendered { icon: string; text: string; href?: string }

export function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
const categoryHref = (name: unknown) => `/?category=${encodeURIComponent(String(name))}`;
const str = (v: unknown) => (typeof v === "string" ? v : "");

// One entry per notification type. Adding a type = one entry here + one notify() call server-side.
const RENDERERS: Record<Notification["type"], (p: Record<string, unknown>, ctx: RenderContext) => Rendered> = {
  suggestion_pending: (p, ctx) => {
    const title = typeof p.bookId === "string" ? ctx.titleOf(p.bookId) : undefined;
    const text = `${localPart(str(p.suggestedBy))} suggested "${str(p.name)}"${title ? ` for ${title}` : ""}`;
    return { icon: "💡", text, ...(p.status === "accepted" ? { href: categoryHref(p.name) } : {}) };
  },
  suggestion_resolved: (p) => {
    const who = localPart(str(p.resolvedBy));
    return p.status === "accepted"
      ? { icon: "✅", text: `Your suggestion "${str(p.name)}" was accepted by ${who}`, href: categoryHref(p.name) }
      : { icon: "🚫", text: `Your suggestion "${str(p.name)}" was rejected by ${who}` };
  },
  books_added: (p) => {
    const count = Number(p.count) || 0;
    return { icon: "📚", text: `${count} new ${count === 1 ? "book" : "books"} added`, href: "/" };
  },
  category_created: (p) => ({ icon: "🏷️", text: `New category "${str(p.name)}"`, href: categoryHref(p.name) }),
};

export function renderNotification(n: Notification, ctx: RenderContext): Rendered {
  const r = RENDERERS[n.type];
  return r ? r(n.payload ?? {}, ctx) : { icon: "•", text: String(n.type) };
}

export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
```

```tsx
// web/src/components/NotificationItem.tsx
import { useState } from "react";
import type { Notification } from "../notifications/api";
import { localPart, relativeTime, renderNotification } from "../notifications/render";
import Link from "./Link";

interface Props {
  n: Notification;
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
  onNavigate?: () => void;
  nowMs?: number;
}

export default function NotificationItem({ n, isAdmin, titleOf, onResolve, onNavigate, nowMs }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = renderNotification(n, { titleOf });
  const p = n.payload ?? {};
  const pending = n.type === "suggestion_pending" && p.status === "pending";
  const name = String(p.name ?? "");

  async function resolve(action: "accept" | "reject") {
    if (!onResolve) return;
    setBusy(true); setError(undefined);
    try {
      await onResolve(String(p.suggestionId), action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`notif${n.read ? "" : " unread"}`}>
      <span className="notif-icon" aria-hidden="true">{r.icon}</span>
      <div className="notif-body">
        {r.href ? <Link href={r.href} onClick={onNavigate}>{r.text}</Link> : <span>{r.text}</span>}
        <div className="notif-meta">
          <span>{relativeTime(n.createdAt, nowMs)}</span>
          {n.type === "suggestion_pending" && p.status === "accepted" && <span>accepted by {localPart(String(p.resolvedBy ?? ""))}</span>}
          {n.type === "suggestion_pending" && p.status === "rejected" && <span>rejected</span>}
        </div>
        {error && <div className="notif-error" role="alert">{error}</div>}
      </div>
      {isAdmin && pending && onResolve && (
        <span className="chip-actions">
          <button type="button" aria-label={`Accept ${name}`} title="Accept" disabled={busy} onClick={() => void resolve("accept")}>✓</button>
          <button type="button" aria-label={`Reject ${name}`} title="Reject" disabled={busy} onClick={() => void resolve("reject")}>✗</button>
        </span>
      )}
    </li>
  );
}
```

Append to `styles.css`:

```css
.notif { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.notif:last-child { border-bottom: 0; }
.notif.unread { background: color-mix(in srgb, var(--accent) 8%, var(--panel)); }
.notif.unread .notif-body > :first-child::before { content: "•"; color: var(--accent); margin-right: 0.35rem; }
.notif-icon { flex: 0 0 auto; }
.notif-body { flex: 1 1 auto; min-width: 0; }
.notif-body a { color: inherit; }
.notif-meta { color: var(--muted); font-size: 0.78rem; display: flex; gap: 0.6rem; margin-top: 0.15rem; }
.notif-error { color: var(--danger); font-size: 0.8rem; margin-top: 0.2rem; }
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/notifications/render.ts web/src/notifications/render.test.ts web/src/components/NotificationItem.tsx web/src/components/NotificationItem.test.tsx web/src/styles.css
git commit -m "feat(web): notification renderer table and row component"
```

---

### Task 11: `NotificationBell` popover

**Files:**
- Create: `web/src/components/NotificationBell.tsx`
- Modify: `web/src/styles.css` (append)
- Test: `web/src/components/NotificationBell.test.tsx`

**Interfaces:**
- Consumes: `useNotifications()` (Task 9), `NotificationItem` (Task 10), `POPOVER_COUNT`, `Link`.
- Produces: `NotificationBell` props `{ isAdmin: boolean; titleOf(bookId: string): string | undefined; onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void> }`. Renders nothing until `seen`. Button `aria-label="Notifications"` with `aria-expanded`; badge text = `unread` or `9+`; popover `role="dialog" aria-label="Notifications"` listing the first `POPOVER_COUNT` items; opening calls `markRead` for the unread ids shown (after render); footer `See all notifications` (Link to `/notifications`, closes the popover) and `Mark all as read` (only when `unread > 0`); closes on outside `mousedown` and `Escape`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/NotificationBell.test.tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../notifications/api";
import { NotificationsProvider } from "../notifications/NotificationsProvider";
import NotificationBell from "./NotificationBell";

const n = (i: number, read = false): Notification => ({
  id: `2026-09-05T10:00:${String(i).padStart(2, "0")}.000Z#${i}`, type: "category_created", payload: { name: `Cat ${i}`, createdBy: "j@example.com", source: "admin" }, read, createdAt: `2026-09-05T10:00:${String(i).padStart(2, "0")}.000Z`,
});
function server(items: Notification[], unread: number) {
  const posted: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(init.body)); return { ok: true, status: 204, headers: new Headers() }; }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ items, unread }) };
  }) as unknown as typeof fetch;
  return { fetchFn, posted };
}
const mount = (fetchFn: typeof fetch, isAdmin = false) => render(
  <NotificationsProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}>
    <div data-testid="outside">outside</div>
    <NotificationBell isAdmin={isAdmin} titleOf={() => undefined} />
  </NotificationsProvider>,
);

describe("NotificationBell", () => {
  it("is hidden with no notifications ever, then shows a capped badge", async () => {
    const empty = server([], 0);
    mount(empty.fetchFn);
    await waitFor(() => expect(empty.fetchFn).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    const many = server(Array.from({ length: 12 }, (_, i) => n(i)), 12);
    mount(many.fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    expect(screen.getByText("9+")).toBeInTheDocument();
  });
  it("opens to the five most recent, marks the shown unread ones read, and closes on Escape/outside", async () => {
    const items = Array.from({ length: 7 }, (_, i) => n(i, i === 1));
    const { fetchFn, posted } = server(items, 6);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(JSON.parse(posted[0]).ids).toEqual([items[0].id, items[2].id, items[3].id, items[4].id]);
    expect(screen.getByText("2")).toBeInTheDocument(); // 6 unread − 4 shown
    expect(within(dialog).getByRole("link", { name: "See all notifications" })).toHaveAttribute("href", "/notifications");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Mark all as read posts all and clears the badge", async () => {
    const { fetchFn, posted } = server([n(0), n(1)], 2);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(posted.some((b) => b === JSON.stringify({ all: true }))).toBe(true));
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/NotificationBell.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```tsx
// web/src/components/NotificationBell.tsx
import { useEffect, useRef, useState } from "react";
import { POPOVER_COUNT, useNotifications } from "../notifications/NotificationsProvider";
import Link from "./Link";
import NotificationItem from "./NotificationItem";

interface Props {
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
}

export default function NotificationBell({ isAdmin, titleOf, onResolve }: Props) {
  const { items, unread, seen, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shown = items.slice(0, POPOVER_COUNT);

  // GitHub-style: what you have seen in the popover counts as read.
  useEffect(() => {
    if (!open) return;
    const ids = shown.filter((n) => !n.read).map((n) => n.id);
    if (ids.length > 0) void markRead(ids);
    // Only when the popover opens — later refreshes while open should not auto-clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!seen) return null;

  return (
    <div className="bell" ref={root}>
      <button type="button" className="bell-button" aria-label="Notifications" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <ul className="notif-list">
            {shown.map((n) => (
              <NotificationItem key={n.id} n={n} isAdmin={isAdmin} titleOf={titleOf} onResolve={onResolve} onNavigate={() => setOpen(false)} />
            ))}
          </ul>
          <div className="popover-footer">
            <Link href="/notifications" onClick={() => setOpen(false)}>See all notifications</Link>
            {unread > 0 && <button type="button" className="more" onClick={() => void markAllRead()}>Mark all as read</button>}
          </div>
        </div>
      )}
    </div>
  );
}
```

Append to `styles.css`:

```css
.bell { position: relative; }
.bell-button { background: none; border: 0; font-size: 1.2rem; cursor: pointer; position: relative; padding: 0.2rem 0.4rem; }
.bell-badge { position: absolute; top: -0.2rem; right: -0.3rem; background: var(--accent); color: var(--accent-text); border-radius: 999px; font-size: 0.65rem; font-weight: 700; padding: 0.05rem 0.35rem; min-width: 1.1rem; text-align: center; }
.popover { position: absolute; right: 0; top: 2.2rem; width: 22rem; max-width: calc(100vw - 2rem); background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); z-index: 10; }
.notif-list { list-style: none; margin: 0; padding: 0; }
.popover-footer { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); font-size: 0.85rem; }
@media (max-width: 600px) { .bell { position: static; } .popover { left: 0.5rem; right: 0.5rem; width: auto; top: 3.4rem; } }
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/NotificationBell.tsx web/src/components/NotificationBell.test.tsx web/src/styles.css
git commit -m "feat(web): notification bell with badge and popover"
```

---

### Task 12: `/notifications` page and App wiring

**Files:**
- Create: `web/src/components/NotificationsPage.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css` (append)
- Test: `web/src/components/NotificationsPage.test.tsx`, `web/src/App.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: `NotificationsPage` props `{ isAdmin; titleOf; onResolve? }`; `App` renders `LibraryDataProvider` → `NotificationsProvider` → a `Shell` that routes `/` (Library, keyed by `search`) and `/notifications`, passes the bell to `Header`, and wires `Library.onChanged` to `notifications.refresh`. `Shell` defines `resolveFromBell(suggestionId, action)` = `resolveSuggestion(apiUrl, token, id, action, fetchFn)` then `refreshOverlay()` and `notifications.refresh()`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/NotificationsPage.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../notifications/api";
import { NotificationsProvider } from "../notifications/NotificationsProvider";
import NotificationsPage from "./NotificationsPage";

const n = (i: number): Notification => ({ id: `2026-09-05T10:00:${String(i).padStart(2, "0")}.000Z#${i}`, type: "books_added", payload: { count: i + 1, bookIds: [] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" });
function server(pages: Array<{ items: Notification[]; unread: number; next?: string }>, fail = false) {
  let gets = 0;
  const posted: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(init.body)); return { ok: true, status: 204, headers: new Headers() }; }
    if (fail && gets === 0) { gets += 1; return { ok: false, status: 502, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "down" }) }; }
    const page = pages[Math.min(gets, pages.length - 1)]; gets += 1;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => page };
  }) as unknown as typeof fetch;
  return { fetchFn, posted };
}
const mount = (fetchFn: typeof fetch) => render(
  <NotificationsProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn}>
    <NotificationsPage isAdmin={false} titleOf={() => undefined} />
  </NotificationsProvider>,
);

describe("NotificationsPage", () => {
  it("lists everything, loads more, and marks all read", async () => {
    const { fetchFn, posted } = server([{ items: [n(0), n(1)], unread: 2, next: "2026-09-05T10:00:01.000Z#1" }, { items: [n(2)], unread: 2 }]);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(posted).toContain(JSON.stringify({ all: true })));
    expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });
  it("shows an empty state and an error state with retry", async () => {
    mount(server([{ items: [], unread: 0 }]).fetchFn);
    await waitFor(() => expect(screen.getByText("No notifications yet")).toBeInTheDocument());
    const { fetchFn } = server([{ items: [n(0)], unread: 1 }], true);
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("down"));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });
});
```

Add to `web/src/App.test.tsx` (reuse that file's existing helpers for a signed-in token and its `fetchFn` stub; extend the stub so `/api/library` returns a valid overlay and `/api/notifications` returns `{ items: [{ id: "2026-09-05T10:00:00.000Z#a", type: "books_added", payload: { count: 2, bookIds: [] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" }], unread: 1 }`):

```tsx
  it("shows the bell when signed in and routes to the notifications page", async () => {
    // arrange a signed-in session exactly as the existing signed-in test does
    render(<AuthProvider config={cfg} fetchFn={fetchFn}><App fetchFn={fetchFn} /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await userEvent.click(screen.getByRole("link", { name: "See all notifications" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/notifications");
    await userEvent.click(screen.getByRole("link", { name: "Lit Library" }));
    await waitFor(() => expect(screen.getByRole("searchbox")).toBeInTheDocument());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/NotificationsPage.test.tsx src/App.test.tsx`
Expected: FAIL — page missing; no bell in App.

- [ ] **Step 3: Implement**

```tsx
// web/src/components/NotificationsPage.tsx
import { useNotifications } from "../notifications/NotificationsProvider";
import NotificationItem from "./NotificationItem";

interface Props {
  isAdmin: boolean;
  titleOf(bookId: string): string | undefined;
  onResolve?: (suggestionId: string, action: "accept" | "reject") => Promise<void>;
}

export default function NotificationsPage({ isAdmin, titleOf, onResolve }: Props) {
  const { items, unread, status, error, hasMore, refresh, loadMore, markAllRead } = useNotifications();
  return (
    <main className="page notifications-page">
      <div className="page-head">
        <h2>Notifications</h2>
        {unread > 0 && <button type="button" className="btn secondary" onClick={() => void markAllRead()}>Mark all as read</button>}
      </div>
      {status === "error" && (
        <div className="error" role="alert">
          Couldn't load notifications ({error}). <button type="button" className="more" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {status === "loading" && <p className="empty">Loading…</p>}
      {status === "ready" && items.length === 0 && <p className="empty">No notifications yet</p>}
      {items.length > 0 && (
        <ul className="notif-list panel">
          {items.map((n) => <NotificationItem key={n.id} n={n} isAdmin={isAdmin} titleOf={titleOf} onResolve={onResolve} />)}
        </ul>
      )}
      {hasMore && <button type="button" className="btn secondary" onClick={() => void loadMore()}>Load more</button>}
    </main>
  );
}
```

`App.tsx` becomes:

```tsx
import { useCallback } from "react";
import { useAuth } from "./auth/AuthProvider";
import { resolveSuggestion } from "./catalog/library";
import { LibraryDataProvider, useLibraryData } from "./catalog/LibraryDataProvider";
import { endSession } from "./catalog/session";
import Header from "./components/Header";
import Library from "./components/Library";
import NotificationBell from "./components/NotificationBell";
import NotificationsPage from "./components/NotificationsPage";
import SignInPage from "./components/SignInPage";
import StaticPage from "./components/StaticPage";
import { NotificationsProvider, useNotifications } from "./notifications/NotificationsProvider";
import { useRoute } from "./route";

interface Props { fetchFn?: typeof fetch }

function Shell({ fetchFn }: { fetchFn: typeof fetch }) {
  const auth = useAuth();
  const { path, search } = useRoute();
  const { titleOf, refreshOverlay } = useLibraryData();
  const notifications = useNotifications();

  const signOut = useCallback(async () => {
    await endSession(auth.apiUrl, fetchFn);
    auth.signOut();
  }, [auth, fetchFn]);

  // Accept/reject from the bell: same API as the sidebar chips, then refresh both views.
  const resolveFromBell = useCallback(async (suggestionId: string, action: "accept" | "reject") => {
    await resolveSuggestion(auth.apiUrl, await auth.getIdToken(), suggestionId, action, fetchFn);
    await Promise.all([refreshOverlay().catch(() => undefined), notifications.refresh()]);
  }, [auth, fetchFn, refreshOverlay, notifications]);

  const bell = <NotificationBell isAdmin={auth.isAdmin} titleOf={titleOf} onResolve={resolveFromBell} />;
  return (
    <>
      <Header email={auth.email} onSignOut={() => void signOut()} bell={bell} />
      {path === "/notifications"
        ? <NotificationsPage isAdmin={auth.isAdmin} titleOf={titleOf} onResolve={resolveFromBell} />
        : <Library key={search} apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn} isAdmin={auth.isAdmin} onChanged={() => void notifications.refresh()} />}
    </>
  );
}

export default function App({ fetchFn = fetch }: Props) {
  const auth = useAuth();
  const { path } = useRoute();
  if (path === "/privacy") return <StaticPage kind="privacy" />;
  if (path === "/terms") return <StaticPage kind="terms" />;
  if (auth.status === "loading") return <p className="empty">Signing you in…</p>;
  if (auth.status === "signedOut") return <SignInPage onSignIn={() => void auth.signIn()} error={auth.error} />;
  return (
    <LibraryDataProvider apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn}>
      <NotificationsProvider apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn}>
        <Shell fetchFn={fetchFn} />
      </NotificationsProvider>
    </LibraryDataProvider>
  );
}
```

(`key={search}` remounts `Library` when the query string changes so a `?category=` link from the bell re-seeds the filter; the catalog and overlay live in the provider, so the remount is cheap.) Append to `styles.css`:

```css
.page { max-width: 48rem; margin: 1.25rem auto; padding: 0 1.25rem; }
.page-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.page-head h2 { margin: 0.5rem 0; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin: 0.75rem 0; }
.notifications-page .btn { margin-top: 0.5rem; }
```

- [ ] **Step 4: Run the suite, typecheck, build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/NotificationsPage.tsx web/src/components/NotificationsPage.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles.css
git commit -m "feat(web): notifications page and app wiring for the bell"
```

---

### Task 13: Documentation

**Files:**
- Modify: `README.md`, `infra/README.md`

- [ ] **Step 1: README**

In **What it does**, after the "Shared, editable categories" bullet add:

```markdown
- **Notifications.** A bell in the header shows new suggestions (admins), the
  outcome of your own suggestions, new categories, and "N new books added"
  after each publish. Per-recipient rows in a small DynamoDB table with a
  90-day TTL; the site polls every five minutes.
```

In the mermaid block add `NOTIF[notifications Lambda]` and `NOTIFT[(DynamoDB<br/>notifications, 90-day TTL)]` inside the `aws` subgraph, edges `API --> NOTIF --> NOTIFT`, `LIB --> NOTIFT`, and `IDX -.->|books added| NOTIF`. In **Repository layout**, the `infra/` row's Lambda count becomes "four Lambdas" and the `scripts/` row gains "notify readers of new books (`notify-books-added.py`, run by `publish-new.sh`)". Update the three test counts in that table to the real totals (`npx vitest run` / `pytest -q` print them). In **Security notes** add: "The notifications Lambda may list Cognito users (to fan out) and read the library table; the indexer reaches it only through `lambda:InvokeFunction` with your own AWS credentials."

- [ ] **Step 2: infra/README**

Add a section after "Admins (category management)":

```markdown
## Notifications

`Notifications/Table` is disposable: rows carry a 90-day TTL, the table is not
retained on stack deletion and `scripts/backup.sh` does not export it. The
notifications Lambda has `cognito-idp:ListUsers` / `ListUsersInGroup` on the pool
(recipient fan-out) and read access to the library table (suggestion status). The
library Lambda has the same Cognito permissions plus write access to the
notifications table. `scripts/publish-new.sh` invokes the notifications Lambda
directly (`NotificationsFunctionName` output) after a publish that added books;
that needs `lambda:InvokeFunction` on the caller's credentials.
```

Do **not** add it to the never-rename list (it is meant to be disposable).

- [ ] **Step 3: Verify and commit**

Run: `cd infra && npm test` (docs touch nothing executable; this is a sanity run).

```bash
git add README.md infra/README.md
git commit -m "docs: notifications"
```

---

### Task 14: Deploy and smoke test (controller runs this; needs AWS credentials)

- [ ] **Step 1**: `cd infra && npx cdk diff` — expect additive: notifications table, Lambda + role + log retention, 2 routes + integration, Cognito policy statements on both Lambdas, env changes on the library Lambda, output. **No** replacement of the pool, buckets, distribution, or the library/downloads tables. Then `npm run deploy` (or have Jay run it) and `python3 ../scripts/apply-outputs.py` (no new config keys; harmless).
- [ ] **Step 2**: `scripts/deploy-web.sh`.
- [ ] **Step 3** (Jay, browser): from a second account suggest a category → as admin the bell shows "<who> suggested …" with ✓/✗ → accept from the bell → the suggester's bell shows "accepted by …" and everyone sees `New category "…"`; the category facet updates without a reload; "See all notifications" opens the page; a `?category=` link filters the grid.
- [ ] **Step 4**: `scripts/publish-new.sh` on a small new bundle (or `scripts/notify-books-added.py --before <snapshot> --added metadata/added.json --dry-run` to check the payload) → everyone sees "N new books added".
