# Notifications — Design Spec

**Date:** 2026-09-05
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-09-04-user-categories-design.md` (suggestions, the `admins` group,
the `library` Lambda and overlay) and `2026-08-31-ebook-share-design.md`.

## Purpose

A bell icon in the header with an unread count, a popover showing the most recent
notifications, and a `/notifications` page listing all of them — built so that new
notification types are one renderer entry on the client and one `notify(...)` call on
the server.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| Notification types at launch | `suggestion_pending` (→ admins, actionable), `suggestion_resolved` (→ the suggester), `books_added` (→ everyone), `category_created` (→ everyone). "A book was moved" was considered and dropped as noise. |
| Storage | **Fan-out per recipient** (Approach A): one row per recipient per event in a new `notifications` table. Rejected: a global feed with a per-user "seen" cursor (no per-item read state, late joiners see all history) and a global feed with per-user read-id sets (more moving parts for no gain at ≤ 10 users). |
| Read semantics | GitHub-style: opening the popover marks the rows *shown* as read; the page has "Mark all as read". Actionability is independent of read state. |
| Freshness | Poll every 5 minutes plus on `visibilitychange`; refresh after local actions that generate notifications. No push, no email. |
| Retention | DynamoDB TTL, 90 days. The table is disposable (`RemovalPolicy.DESTROY`) and not backed up. |
| `books_added` source | `publish-new.sh` invokes the notifications Lambda directly (`aws lambda invoke`) after a publish with new books; the Lambda fans out. The indexer never talks to Cognito or the table. |
| Navigation | A minimal in-app router (`useRoute`: pathname state, `pushState`, `popstate`) so "See all" and the logo navigate without a reload. `/privacy` and `/terms` are unchanged. |
| Out of scope | Per-type mute preferences, browser push, sounds, email, notification history beyond 90 days. |

## Data model

Table `notifications` (on-demand, `RemovalPolicy.DESTROY`, TTL attribute `expiresAt`):

| Attribute | Value |
|---|---|
| `pk` | `USER#<email>` |
| `sk` | `<createdAt ISO-8601>#<uuid>` — newest-first with `ScanIndexForward: false`; doubles as the notification **id** the client sends back |
| `type` | `suggestion_pending` \| `suggestion_resolved` \| `books_added` \| `category_created` |
| `payload` | map, per type (below) |
| `read` | boolean |
| `createdAt` | ISO-8601 |
| `expiresAt` | epoch seconds, `createdAt + 90 days` |

Payloads carry ids, never titles — the client holds the catalog and renders titles itself:

| Type | Payload | Recipients |
|---|---|---|
| `suggestion_pending` | `{ suggestionId, name, bookId?, suggestedBy }` | admins |
| `suggestion_resolved` | `{ suggestionId, name, status: "accepted" \| "rejected", resolvedBy, bookId? }` | the suggester |
| `books_added` | `{ count, bookIds }` (`bookIds` = the first 20) | everyone |
| `category_created` | `{ name, createdBy, source: "admin" \| "suggestion" }` | everyone |

## Fan-out

`infra/lambda/notifications/fanout.ts`, bundled into both the `library` and
`notifications` Lambdas:

```ts
notify(type, payload, recipients: "everyone" | "admins" | string[], deps): Promise<void>
```

- Recipient lists come from Cognito: `ListUsers` (paginated, ≤ 60 per page; filtered to
  `Enabled` and `UserStatus ∈ {CONFIRMED, EXTERNAL_PROVIDER}`; the `email` attribute) for
  "everyone", `ListUsersInGroup admins` for "admins". Results are cached in module memory
  for 60 s.
- One `PutItem` per recipient, batched with `BatchWriteItem` (25 per call) when there are
  more than a few.
- **Best-effort when triggered by a user action**: the library Lambda performs its primary
  write, *then* calls `notify` inside its own try/catch and logs failures. A Cognito or
  DynamoDB failure in fan-out never changes the HTTP response of the triggering request.

Writers:

| Event | Where | Emits |
|---|---|---|
| `POST /api/suggestions` | library Lambda | `suggestion_pending` → admins |
| accept | library Lambda | `suggestion_resolved` → suggester; `category_created` (`source: suggestion`) → everyone |
| reject | library Lambda | `suggestion_resolved` → suggester |
| `POST /api/categories` | library Lambda | `category_created` (`source: admin`) → everyone |
| `publish-new.sh` with new books | notifications Lambda, direct invoke | `books_added` → everyone |

## API

New `notifications` Lambda on the existing HTTP API (JWT authorizer, same-origin via
CloudFront `/api/*`):

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/notifications?limit=50&before=<sk>` | 200 `{ items: [{ id, type, payload, read, createdAt }], unread: n, next?: sk }`. `limit` clamped to 1–100; malformed `before` → 400. Items newest first. For `suggestion_pending` items, `payload.status` is joined from the suggestion's current row in the library table (`pending` \| `accepted` \| `rejected`, plus `resolvedBy` when resolved) so admin rows reflect reality without write-back. `unread` is a separate `Query` with `Select: COUNT` and `read = false`. |
| `POST` | `/api/notifications/read` | body `{ ids: string[] }` (≤ 100) or `{ all: true }`. Updates `read = true` on the caller's rows only (they are keyed under the caller's `pk`, so a foreign id is a no-op). 204. |

**Direct invoke** (from `publish-new.sh`, IAM-authorized by `lambda:InvokeFunction`): the
same handler recognises an event with no `requestContext`. It accepts only
`{ source: "indexer", type: "books_added", count: integer ≥ 1, bookIds: string[] (≤ 20) }`,
fans out to everyone, and returns `{ ok: true, recipients: n }`; anything else returns
`{ ok: false, error }` without writing.

Errors are JSON `{error}`; unexpected exceptions → 500 with logged stack, as in the other
Lambdas.

## Web UI

**Providers** (in `App`, below `AuthProvider`):

- `NotificationsProvider` — `{ items, unread, status, refresh(), markRead(ids), markAllRead(), loadMore() }`. Fetches on mount, every 5 minutes, and on `visibilitychange` → visible. `markRead` updates local state optimistically, then posts. `status` is `loading | ready | error`.
- `OverlayProvider` — the library overlay (`overlay`, `refreshOverlay()`) moves up out of `Library` so an accept from the bell refreshes the category facets on the page below. `Library` keeps its mutation callbacks and toasts; it reads the overlay from context.

**`NotificationBell`** (in `Header`): bell icon with a badge showing `unread` (capped at
"9+"); rendered only when the provider has ever returned at least one item. Click opens a
popover anchored under the bell (closed by outside click or Escape) containing:

- the **5 most recent** notifications, newest first (`NotificationItem` rows);
- for admins, ✓ / ✗ on `suggestion_pending` rows while `payload.status === "pending"`;
  otherwise "accepted by <local part>" / "rejected";
- footer: **See all notifications** → `/notifications`; **Mark all as read** when `unread > 0`.
- Opening the popover calls `markRead` for the unread rows it shows, after they render.
- At ≤ 600 px the popover spans the full width under the header.

**`NotificationItem`** renders one row from a per-type table `{ icon, text(payload, catalog), href(payload), actions? }`:

| Type | Text | Link |
|---|---|---|
| `suggestion_pending` | `<suggestedBy local part> suggested "<name>"` + `for <book title>` when `bookId` resolves in the catalog | `/?category=<name>` once accepted; none while pending |
| `suggestion_resolved` | `Your suggestion "<name>" was accepted by <who>` / `… was rejected` | `/?category=<name>` when accepted |
| `books_added` | `<count> new books added` | `/` (Recently added is the default sort) |
| `category_created` | `New category "<name>"` | `/?category=<name>` |

Each row shows a relative time ("3 h ago") and an unread dot. Adding a type later is one
entry in this table plus one `notify(...)` call on the server.

**`/notifications` page**: same rows, 50 per page with **Load more** (API cursor),
**Mark all as read**, an empty state, and an error state with retry.

**Routing**: `useRoute()` returns the pathname and a `navigate(path)` that calls
`pushState` and updates state; a `popstate` listener keeps back/forward working. `App`
switches on it for `/`, `/notifications`, `/privacy`, `/terms`. Internal links render as
`<a href>` with an `onClick` that calls `navigate` (plain-click only, so modifier-clicks
still open new tabs).

**`?category=<name>`**: `Library` seeds `filters.category` from this query param on first
render (a slice of backlog #5, shareable URLs); nothing writes the param back yet.

**Library changes**: after `suggest`, `addCategory`, and `resolve`, `Library` also calls
`notifications.refresh()` so the bell reflects the user's own action immediately.
The category-facet chips (pending suggestions with admin ✓/✗) stay as they are — the bell
is an additional surface, not a replacement, and the chips are what non-admins see.

## Infrastructure and operations

- **`Notifications` construct** (`infra/lib/notifications.ts`): table, Lambda, two routes.
  Grants: read/write on the notifications table; read on the library table;
  `cognito-idp:ListUsers` and `cognito-idp:ListUsersInGroup` on the pool ARN. Env:
  `NOTIFICATIONS_TABLE`, `LIBRARY_TABLE`, `USER_POOL_ID`.
- **Library Lambda** gains write on the notifications table and the same two Cognito
  permissions; env `NOTIFICATIONS_TABLE`, `USER_POOL_ID`.
- **Construct ordering**: `Notifications` is created before `Library` so the table can be
  passed in; both attach routes to `api.httpApi` after its default authorizer is set. The
  existing stack test asserting `AuthorizerId` on every `/api/*` route covers the new ones.
- **Stack output** `NotificationsFunctionName`.
- **`publish-new.sh`**: after a successful publish, when the `added.json` delta is > 0,
  invokes the function (`aws lambda invoke --payload '{"source":"indexer","type":"books_added","count":N,"bookIds":[…first 20…]}'`)
  and prints the response. A failed invoke prints a warning and exits 0 — the publish
  succeeded and re-running would double-publish.
- `apply-outputs.py` and `backup.sh` are unchanged.
- **Docs**: README ("What it does" bullet, diagram nodes for the notifications Lambda and
  table, `scripts/` row), `infra/README.md` (what the notifications Lambda may read; the
  table is not retained or backed up).

## Error handling summary

| Condition | Behaviour |
|---|---|
| Fan-out fails after a user action | logged; the action's HTTP response is unchanged |
| Direct-invoke event malformed | `{ ok: false, error }`, nothing written |
| `limit` outside 1–100 | clamped |
| malformed `before` cursor | 400 |
| `read` with ids not under the caller's `pk` | no-op |
| notifications fetch fails in the client | bell hidden; page shows an error with retry; library unaffected |
| accept/reject from the bell fails | existing 403/404/409 toasts |

## Testing

- **infra**: CDK assertions (table with TTL and DESTROY, two routes on the authorizer,
  grants scoped to the two tables and the pool ARN, output). `fanout.ts` with a mocked
  Cognito client (pagination, status/enabled filtering, 60 s cache, "everyone" /
  "admins" / explicit list, batching). Notifications handler: list with unread and
  cursor, `read` by ids and all, suggestion-status join, direct-invoke validation and
  fan-out, 401 without email. Library handler: `notify` called with the right type and
  recipients per route; a rejected `notify` leaves the response unchanged.
- **web**: `NotificationsProvider` (initial fetch, 5-minute timer, visibility refresh,
  optimistic `markRead`), `NotificationBell` (badge cap, open/close, mark-seen-on-open,
  admin actions gated on `isAdmin` and `status === "pending"`), `NotificationItem` (one
  test per type incl. title resolution from the catalog), `NotificationsPage` (load more,
  mark all, empty and error states), `useRoute` (pushState/popstate), `Library`
  `?category=` seeding and the post-action `refresh` calls, `OverlayProvider` extraction
  leaving the existing Library tests green.
- **scripts**: `publish-new.sh` invoke branch with a stub `aws` on `PATH` — no invoke when
  the delta is 0, correct payload when > 0, warning-and-exit-0 when the invoke fails.

## Rollout

1. Deploy infra, then web.
2. From a second account, suggest a category; as admin, accept it from the bell; confirm
   the suggester's bell shows "accepted" and every account shows "New category".
3. Run `publish-new.sh` on a small bundle and confirm "N new books added".
4. Pending suggestions created before this deploy have no notification rows; they remain
   visible in the category-facet chips.
