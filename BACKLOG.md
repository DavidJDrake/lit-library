# Backlog

Prioritized improvements, grouped by purpose. Effort is rough: **S** = under an hour
with the usual plan → build → review loop, **M** = an evening, **L** = a weekend.
Items move to "Done" with the commit or plan that closed them.

## Soon

_(none queued)_

## Product polish (independent, each S)

| # | Item | Notes |
|---|---|---|
| 4 | Reading status per user — downloaded / want to read / finished. | "Downloaded" is free from the existing log; the rest is one small table and a toggle on the card. |
| 5 | Shareable URLs — put search and filters in the query string. | Half done: `?category=` seeds the facet (notifications plan). Remaining: search text, other facets, sort, and writing the params back on change. Also makes a "New category" link clicked twice re-seed (today a no-op because the URL doesn't change). |
| 6 | Second enrichment pass for descriptions (25% coverage today). | Google Books by title+author, only for books still lacking a description; likely doubles coverage. |
| 16 | OPDS feed. | Another view of `catalog.json` behind the same session cookie; e-reader apps (KOReader, Moon+) can browse it directly. |
| 8 | Progressive cover loading — virtualize or page the grid. | 1,065 lazy images is fine on desktop, heavy on phones. |

## Polish deferred from reviews (each S, none blocking)

| # | Item | Notes |
|---|---|---|
| 17 | Notification popover focus management. | Move focus into the dialog on open, back to the bell on close; scope the Escape handler to the popover. |
| 18 | Don't notify the actor about their own action. | `category_created` goes to "everyone" incl. the admin who created it; `books_added` incl. whoever published. One `.filter()` in `notify`. |
| 19 | `loadMore` failure UX on `/notifications`. | The page-wide error banner shows over already-loaded items and Retry resets to page 1; show an inline "couldn't load more — retry" under the list instead. |
| 20 | `notify-books-added.py` hardening. | A missing/corrupt `added.json` or `--before` file tracebacks instead of warn-and-exit-0 (shielded by `publish-new.sh`); tests for the invoke-failure branches. |
| 21 | Suggestion duplicate check is not atomic. | Two simultaneous identical suggestions can both persist as pending; accept 409s the second, so no corruption. A `nameLower` lock item would close it. |
| 22 | `PUT /api/books/{id}/category` matches category names case-sensitively. | UI always sends canonical names; a differently-cased valid name gets a 400. |
| 23 | Small test gaps. | `AuthorizerId` asserted only at stack level; disabled-state of chip ✓/✗ while resolving; overlapping `markRead` calls where the first fails can revert the second (poll self-corrects). |

## Security and operations

| # | Item | Effort | Notes |
|---|---|---|---|
_(none queued)_

## Repo as portfolio

| # | Item | Effort | Notes |
|---|---|---|---|
| 13 | Screenshots or a short GIF in the README. | S | Blur covers if purchases shouldn't be visible. |
| 14 | A "what I'd do differently" retrospective section. | S | Material: the CloudFront cache-policy rule that bit, signed cookies vs an auth'd catalog API, keeping search client-side. |
| 15 | Post the real first-month AWS bill in the README. | S | A real number beats an estimate. |

## Done

| # | Item | Closed by |
|---|---|---|
| — | **User-editable categories.** Anyone moves a book between categories or suggests a new one; `admins` group accepts/rejects or adds directly; overlay table merged over the static catalog; `pull-edits.py` folds edits into `overrides.yaml`. | PR #1, spec/plan `2026-09-04-user-categories` |
| 10 | **CloudWatch alarms** — SNS email topic; `Errors ≥ 1`/5 min per Lambda, API `5xx ≥ 1`/5 min, `EstimatedCharges > $5`; ALARM and OK notifications; missing data = OK. | `infra/lib/alerts.ts` |
| 11 | **GitHub Actions CI** — infra (typecheck, tests, `cdk synth` on the example config), web (typecheck, tests, build), indexer (pytest) on every push/PR; badge in the README. | `.github/workflows/ci.yml` |
| 12 | **Dependabot** — weekly grouped minor/patch PRs for `/infra`, `/web`, `/indexer`, and the workflow actions. | `.github/dependabot.yml` |
| — | **Notifications.** Header bell + popover + `/notifications` page; fan-out per recipient with a 90-day TTL; suggestion/category events from the library Lambda, "N new books added" from `publish-new.sh`; in-app router; `?category=` seeding. | PR #2, spec/plan `2026-09-05-notifications` |
| 7 | **Send-to-Kindle.** One-click delivery of the EPUB (or PDF) to the user's `@kindle.com` address via SES, with SES domain verification, a `/settings` page for the address, size/format limits, and a `kindle_bounce` notification when Amazon rejects a send. | `infra/lib/kindle.ts`, spec/plan `2026-09-05-send-to-kindle` |
| 9 | **CloudFront security headers.** Response-headers policy on all three behaviours: CSP built from config (connect-src the Cognito host, frame-src the books bucket for the download iframe), HSTS, nosniff, frame-ancestors none, referrer policy. | PR #29, `infra/lib/site.ts` |
| 24 | **Dependency majors.** Vite 8 + `@vitejs/plugin-react` 6 + vitest 4 together (none can land alone), React 19, TypeScript 7 with infra moving off the removed `moduleResolution: node10` to `module: node18`. Dependabot's deferrals are gone; only the `@types/node` rule remains, and that tracks the Lambda runtime rather than deferring anything. | PRs #31, #35, and the TypeScript one |
| 25 | **Multiple Kindle devices per user.** Named device list (up to 5) with a default, split-button send with a device menu, bounce rows naming the device, lazy migration of the single saved address. | `infra/lambda/kindle/devices.ts`, `web/src/components/DeviceList.tsx`, `web/src/components/SendToKindleButton.tsx`; spec and plan `2026-09-06-kindle-devices`. |
| 1 | **Close the stale-session gap.** Made `DELETE /api/session` unauthenticated (it only clears cookies), shortened the signed cookie to 2 h, and had the app renew it silently every 90 min while signed in. | plan `2026-09-04-backlog-1-3` |
| 2 | **"Recently added" first, plus a one-command refresh.** Default the grid to newest-first and add a script that indexes new bundles and publishes in one step. | plan `2026-09-04-backlog-1-3` |
| 3 | **Back up what can't be regenerated.** Script that copies `metadata/` (enrichment cache, `added.json`, `overrides.yaml`, publish state), `infra/outputs.json`, `infra/config.local.json`, and a DynamoDB export to a private S3 prefix. | plan `2026-09-04-backlog-1-3` |
