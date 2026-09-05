# User-Editable Categories — Design Spec

**Date:** 2026-09-04
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-08-31-ebook-share-design.md` (the static catalog, signed-cookie
gating, JWT-protected HTTP API, and download log this feature extends)

## Purpose

Let any signed-in user move a book to a different category, let anyone suggest a
new category (optionally for a specific book), and let an admin accept or reject
suggestions or add categories directly. Changes are global: everyone sees them.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| Scope of an edit | **Global.** One shared taxonomy; a change is visible to every user. |
| Categories per book | **Exactly one**, as today. Editing *moves* a book. |
| Suggestions | A **name plus an optional originating book**. Accepting creates the category and, if a book is attached, moves it in the same step. |
| Admin role | **Cognito user pool group `admins`.** Membership added by CLI; the ID token's `cognito:groups` claim is the authority. |
| Where mutable state lives | **Runtime overlay in DynamoDB** (Approach A). `catalog.json` stays static and republishable; the SPA merges the overlay on load. A manual script folds edits back into `overrides.yaml`. |
| Rejected alternatives | Write-through to `catalog.json` (1 MB read-modify-write per edit, races, still needs the sync script); serving the whole catalog from DynamoDB (discards the static/signed-cookie design). |
| Out of scope | Renaming or deleting categories; per-user tags; email notifications; edit history beyond "who/when" on the current value. |

## Data model

One new DynamoDB table `library` (on-demand, `RemovalPolicy.RETAIN`), single-table
design keyed by `pk` / `sk` (strings):

| Item | `pk` | `sk` | Other attributes |
|---|---|---|---|
| Category | `CATEGORY` | `<name>` | `nameLower`, `createdBy`, `createdAt`, `source` ∈ {`seed`, `admin`, `suggestion`} |
| Book category | `BOOK` | `<bookId>` | `category`, `changedBy`, `changedAt` |
| Suggestion | `SUGGESTION` | `<ulid>` | `name`, `nameLower`, `bookId?`, `suggestedBy`, `createdAt`, `status` ∈ {`pending`, `accepted`, `rejected`}, `resolvedBy?`, `resolvedAt?` |

- The whole overlay is three `Query` calls (one per `pk`); it stays in the hundreds
  of items at most.
- **Category names** are the identity: trimmed, 1–40 characters, no control
  characters. Uniqueness is case-insensitive, enforced by checking `nameLower`
  against existing categories *and* pending suggestions before a create.
- **Seeding.** A CDK custom resource writes the seven built-in categories
  (`Tech & Programming`, `Security & Hacking`, `Fiction`, `Comics`, `TTRPG`,
  `Certification`, `Other/Lifestyle`) with `source: seed` using conditional
  `PutItem` (`attribute_not_exists(pk)`), so redeploys are idempotent and never
  delete. This keeps `catalog.json` category values and the table in agreement
  from the first deploy.
- Timestamps are ISO-8601 UTC; actors are the token's `email` claim.

## API

All routes live on the existing HTTP API behind CloudFront at `/api/*`, use the
existing JWT authorizer (ID token), and are served by **one new Lambda**, `library`,
that routes on method + path internally (the same shape as the session Lambda).
Its IAM grant is read/write on the `library` table only.

| Method | Path | Who | Behaviour |
|---|---|---|---|
| `GET` | `/api/library` | any user | 200 `{ categories: [{name, source}], bookCategories: {bookId: name}, suggestions: [{id, name, bookId?, suggestedBy, createdAt}] }` — suggestions are the *pending* ones only, sorted by `createdAt`. Categories sorted by name. |
| `PUT` | `/api/books/{id}/category` | any user | body `{category}`. 400 if the category does not exist. Writes/overwrites the `BOOK` item. 204. |
| `POST` | `/api/suggestions` | any user | body `{name, bookId?}`. 400 on invalid name; 409 if `nameLower` matches an existing category or a pending suggestion. 201 `{id}`. |
| `POST` | `/api/categories` | admin | body `{name}`. 400 invalid; 409 duplicate. 201. |
| `POST` | `/api/suggestions/{id}/accept` | admin | 404 unknown; 409 already resolved or name now taken. One `TransactWriteItems`: create the category (`source: suggestion`), write the `BOOK` item if `bookId` present, set `status: accepted` + `resolvedBy/At`. 204. |
| `POST` | `/api/suggestions/{id}/reject` | admin | 404 unknown; 409 already resolved. Sets `status: rejected` + `resolvedBy/At`. 204. |

- **Admin check:** `event.requestContext.authorizer.jwt.claims["cognito:groups"]`
  must include `admins`, else 403. (Cognito serialises the claim as a string like
  `[admins]` in HTTP API authorizers; the handler accepts both the array and the
  bracketed-string form.)
- Errors are JSON `{error}`; unexpected exceptions are logged with stack and
  return 500, matching the download Lambda.
- Book ids are not validated against the catalog (the Lambda does not have it);
  an unknown id creates an orphan `BOOK` row that `pull-edits.py` reports.
- No CORS (same origin via CloudFront). `/api/*` is already uncached.

## Authorization

- The Auth stack adds a `CfnUserPoolGroup` named `admins` on the existing pool.
- `scripts/make-admin.sh <email>` finds the federated username via
  `list-users --filter 'email = "…"'` and runs `admin-add-user-to-group`. It is
  documented as a deploy step next to editing the allowlist. Tokens issued before
  the group change do not carry the claim: sign out and in again.
- Admin is orthogonal to the allowlist and the pre-signup trigger; neither changes.
- The SPA exposes `isAdmin` from `AuthProvider` by parsing the stored ID token's
  `cognito:groups`. It only gates rendering; the API is the gate.

## Web UI

Two touch points, in existing components.

**`BookDetail`** — the category line becomes a `<select>` listing every overlay
category with the current one selected. On change: `PUT /api/books/{id}/category`,
update the book in state, toast "Moved to <name>"; on failure revert and toast the
error. The final option, **"Suggest a new category…"**, swaps the select for an
inline one-field form (name, Submit, Cancel) that posts `{name, bookId}`. Success
toast: "Suggested '<name>' — waiting for approval".

**Category `FacetGroup`** — gains a footer:
- a **"Suggest a category"** link opening the same inline form with no book;
- **pending suggestions** as muted chips ("<name> · suggested by <email local part>")
  so people do not duplicate; for admins each chip has accept (✓) and reject (✗)
  buttons; admins also get an **"Add category"** link that creates one directly.

**Data flow** — after `establishSession` succeeds and `catalog.json` loads, the app
calls `GET /api/library` and merges with `applyOverlay(books, overlay)`:
`book.category = overlay.bookCategories[book.id] ?? book.category`. The category
facet's option list is the overlay's category list (so an empty new category is
selectable in the detail dropdown and appears in the facet with count 0 — the
facet hides zero-count values as today, but the dropdown shows all). Counts
come from the merged books. After any mutation the app re-fetches the overlay
instead of patching local state. If the overlay fetch fails, the library renders
from `catalog.json` alone with editing controls hidden and a toast — a broken
`library` Lambda cannot take the site down.

## Indexer sync and operations

- **`scripts/pull-edits.py`** scans the `library` table and merges every `BOOK`
  item's category into `metadata/overrides.yaml` under its book id (preserving the
  header comment and existing entries), and writes the table's category names to
  a top-level `categories:` list in the same file. It prints `BOOK` ids that are
  not in `out/catalog.json` (orphans) and exits 0. Run before `publish-new.sh` or
  before committing metadata; it is manual by design, like everything in `metadata/`.
- **Indexer** — `categorize.py`'s valid-category check becomes: the seven built-ins
  plus the `categories:` list from `overrides.yaml`. `load_overrides` separates that
  key from the per-book entries. Derivation rules are unchanged; new categories are
  only ever assigned by people.
- **Backups** — `scripts/backup.sh` also exports the `library` table.
- **Config** — the table name is a stack output picked up by `apply-outputs.py`
  into `config.yaml` (`library_table`) for the scripts. Nothing new in
  `infra/config.local.json`.

## Error handling summary

| Condition | Response |
|---|---|
| Invalid category name (empty, >40 chars, control chars) | 400 |
| Duplicate name (case-insensitive, vs categories or pending suggestions) | 409 |
| `PUT` to a non-existent category | 400 |
| Admin route without `admins` group | 403 |
| Unknown suggestion id | 404 |
| Suggestion already resolved | 409 |
| Accept race (name created meanwhile) | transaction fails → 409 |
| Anything else | 500 with logged stack |

## Testing

All offline, following the existing suites.

- **infra** — CDK assertions: table (pk/sk, on-demand, RETAIN), `admins` group,
  Lambda grant limited to the new table, six routes on the JWT authorizer, seed
  custom resource. Lambda unit tests with a mocked DynamoDB client: each route's
  happy path, every validation/409/404 case, the 403, the accept transaction's
  item shape, the bracketed-string groups claim.
- **web** — `applyOverlay`; `isAdmin` parsing; `BookDetail` select → PUT → toast
  and revert on failure; suggest form (with and without a book); facet footer chips,
  admin buttons only when `isAdmin`; overlay fetch failure leaves the catalog
  rendered read-only.
- **indexer** — `categories:` extends the valid set; unknown category still
  rejected; `pull-edits.py` merge preserves existing overrides and the header
  comment, reports orphans.

## Rollout

1. Deploy infra (table, group, Lambda, routes, seed) → `apply-outputs.py`.
2. `scripts/make-admin.sh fatherofash@gmail.com`.
3. Deploy web; sign out and in.
4. Smoke test: move a book; suggest a category from a book; accept it as admin and
   confirm the book moved; confirm a second account sees both; run `pull-edits.py`
   and diff `overrides.yaml`.
