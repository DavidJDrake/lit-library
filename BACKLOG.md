# Backlog

Prioritized improvements, grouped by purpose. Effort is rough: **S** = under an hour
with the usual plan → build → review loop, **M** = an evening, **L** = a weekend.
Items move to "Done" with the commit or plan that closed them. Larger pieces of work
live under "Epics": each states its goal, the evidence for doing it, and the tasks it
breaks into. Tasks are ticked off as they land; the epic closes when they all are.

## Soon

_(none queued)_

## Epics

Evidence below was measured on 2026-09-11 against the live library (1,327 books).

### 28. Backups that survive losing the bucket

**Goal:** the state that cannot be regenerated stays recoverable even if the books
bucket is emptied, corrupted or deleted.

**Why:** `scripts/backup.sh` writes to `_backup/` *inside the books bucket* — the same
bucket it is backing up — and that bucket has versioning disabled, so one bad sync or
recursive delete takes the books and every backup with them. The newest backup is from
2026-09-06 and only exists because it was run by hand. The DynamoDB exports are the
irreplaceable part: reading statuses, category edits, suggestions, Kindle devices and
OPDS token hashes. The bucket holds 3,049 objects / 95 GB.

- [ ] Separate backup bucket, versioning on, public access blocked, its own lifecycle
- [ ] Decide whether the books bucket also gets versioning (cost against 95 GB)
- [ ] Run it on a schedule, with a failure alarm through the existing SNS topic
- [ ] Rehearse a restore: load a DynamoDB export into a scratch table and check row counts

**Effort:** M. Do this one first — it is the only backlog item where a mistake is
unrecoverable.

### 29. Fill in the catalog metadata

**Goal:** a book card shows what a reader needs to choose it.

**Why:** measured across the 1,327 books — 923 (69%) have no description, 508 (38%) no
year, 331 (24%) no author, 99 (7%) no cover, and 91 titles are still filename-ish
(`Cyberpunk2020Corerulebook`, `Blackhandsstreetweapons2020`). Enrichment has never
contributed a description because no `GOOGLE_BOOKS_API_KEY` is set (see #6, which fixed
the caching bug behind it).

- [ ] Add `GOOGLE_BOOKS_API_KEY`; run `--retry-failed-enrichment` on a small batch first
- [ ] Re-run across the library, then re-measure the five counts above
- [ ] Fall back to embedded EPUB/PDF metadata where enrichment finds nothing
- [ ] Split run-together titles, with the changes reviewed before publishing

**Effort:** M.

### 30. Group duplicate editions

**Goal:** one book, one card, however many bundles it arrived in.

**Why:** 90 titles appear in more than one bundle — 201 books, about 15% of the
catalog. *AWS Certified Security – Specialty* is in three bundles; *The Docker
Workshop* and *The Kubernetes Workshop* in two each. Bundle sellers repackage the same
titles, so browsing shows the same cover repeatedly and search results pad out.

- [ ] Pick a match key (normalised title plus author) and count false merges on the real catalog
- [ ] Group matches in the catalog builder: one book, several sources
- [ ] One card in the UI; the dialog lists sources and the download picks one
- [ ] Migrate reading statuses and download rows onto the surviving book id

**Effort:** M. Worth doing while only one reader has status rows to migrate.

### 31. Give the other readers a reason to come back

**Goal:** the library is used by the people it was shared with, not just its owner.

**Why:** three accounts exist; two have ever downloaded anything; nine downloads in
total. Only one reader (the owner) has a reading status, a Kindle device or an OPDS
token. Notifications are in-app only, so they reach nobody who does not visit. This is
an attention problem, not a feature gap — the library has 1,327 books and one habitual
reader.

- [ ] Ask the two readers what would bring them back, before building anything
- [ ] Email digest of new books, reusing the notification fan-out and the verified SES domain
- [ ] An entry point that is not a search box: shelves, or a few picks per category
- [ ] Email preferences and unsubscribe in Settings

**Effort:** M, and the first task is free.

## Product polish

_(none queued)_

## Deferred from reviews

| # | Item | Notes |
|---|---|---|
| 26 | Don't notify the publisher about their own upload. | Split out of #18 after survey: `books_added` fires from a direct Lambda invoke by `scripts/notify-books-added.py`, which has no Cognito session and no notion of who ran it. Fixing it means inventing a publisher identity and threading it through the script, the invoke payload and the event validation. Effort **M**, and worth deciding whether it earns that. |

## Security and operations

_(none queued)_

## Repo as portfolio

| # | Item | Effort | Notes |
|---|---|---|---|
| 13 | Screenshots in the README. | S | Recipe written up in `docs/screenshots.md`, including the public-domain-only view and how to blank the email and feed token. The images themselves still need taking: the browser tooling used here writes them to an environment this checkout cannot read. |
| 15 | Post the real first-month AWS bill in the README. | S | A real number beats an estimate. Not obtainable from the CLI so far: on 2026-09-11 the `EstimatedCharges` billing metric read $0.00 for the whole of August and September to date, and Cost Explorer returned only fractional refunds. 95 GB of Intelligent-Tiering storage should not be free, so credits are the likely explanation — read the figure off the Billing console rather than trusting either API. |

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
| 17 | **Notification popover focus management.** Focus enters the popover on open and returns to the bell on close; Escape is scoped to the popover, so it no longer fires while typing in search. | PRs #38–#40 |
| 18 | **Actors are not notified about their own actions.** An `excludeEmail` option on the fan-out, passed at the three authenticated library call sites. | PRs #38–#40 |
| 19 | **A failed load-more no longer blows away the page.** Tracked separately from a first-load failure, with an inline retry that continues instead of restarting. | PRs #38–#40 |
| 20 | **The publish notification script keeps its no-crash promise.** Missing, corrupt, and unreadable input files now warn and exit zero, matching the pattern already used for one of the three reads. | PRs #38–#40 |
| 21 | **The suggestion duplicate check is atomic.** A name reservation written conditionally inside a transaction, released on accept and reject. The cancelled-transaction catch inspects the reasons, so throttling is not reported as a duplicate. | PRs #38–#40 |
| 22 | **Category names match case-insensitively**, storing the existing canonical casing. | PRs #38–#40 |
| 23 | **Test gaps closed.** Routes are asserted against the real JWT authorizer (proven to fail when a route loses auth), the suggestion chip’s in-flight disabled state is covered, and the overlapping mark-as-read was fixed rather than pinned. | PRs #38–#40 |
| 8 | **Windowed book grid.** Renders only the rows near the viewport, measuring the browser's own column track list and a card's height rather than reimplementing the CSS. Card height is now deterministic by construction, which the measurement depends on. Verified live: 1,297 cards down to about 21-56 mounted, one distinct card height, zero scroll drift at the bottom. | PR #42 |
| 6 | **Description enrichment repaired.** Not the second pass the item asked for, which already existed: enrichment had never contributed a single description, because transient failures were cached permanently as misses. Failures are now retried and left uncached, an optional API key is supported, and a flag re-attempts only past misses. | PR #43 |
| 5 | **Shareable library URLs.** All six facets, the search text and the sort round-trip through the query string; defaults omitted, values ordered so the URL does not depend on click order. A replacing history update keeps the back button useful and closes the loop between state and URL, which also fixed the category link that used to do nothing when already applied. | PR #44 |
| 4 | **Reading status per reader.** Want to read, reading and finished, stored per reader in the existing library table, set from the book dialog and shown as a chip on the card. Downloaded appears alongside them as a derived, non-settable marker from the download log, so a book can show both at once. Filterable as a facet like any other. | PR #45 |
| 16 | **OPDS 2.0 feed.** JSON acquisition feed of the whole catalogue for e-reader apps, authenticated by a per-reader token that is 256 bits of entropy, stored only as a hash, revocable from Settings, and read-only. Minting and revoking still require Google sign-in; only the feed and acquisition routes are open, and they check the token in the handler. Acquisition redirects to a freshly signed URL and logs the download. | PR #47 |
| 27 | **Consistent email normalisation.** All four handlers now take the caller's address through one helper that trims and lowercases, so a fifth cannot drift. The downloads table had two producers that disagreed, which would have split a mixed-case reader across two partitions. Every allowlisted address was already lowercase, so nothing needed migrating. | PR #48 |
| 14 | **"What I'd do differently" retrospective.** Signed cookies versus an authenticated catalog API, client-side search and where it expires, the cache policy CloudFront rejects, the enrichment cache that froze an outage into permanent state, uniform card heights as a prerequisite for windowing, a test harness that ran the wrong code, and where the review effort actually paid. | README |
| 25 | **Multiple Kindle devices per user.** Named device list (up to 5) with a default, split-button send with a device menu, bounce rows naming the device, lazy migration of the single saved address. | `infra/lambda/kindle/devices.ts`, `web/src/components/DeviceList.tsx`, `web/src/components/SendToKindleButton.tsx`; spec and plan `2026-09-06-kindle-devices`. |
| 1 | **Close the stale-session gap.** Made `DELETE /api/session` unauthenticated (it only clears cookies), shortened the signed cookie to 2 h, and had the app renew it silently every 90 min while signed in. | plan `2026-09-04-backlog-1-3` |
| 2 | **"Recently added" first, plus a one-command refresh.** Default the grid to newest-first and add a script that indexes new bundles and publishes in one step. | plan `2026-09-04-backlog-1-3` |
| 3 | **Back up what can't be regenerated.** Script that copies `metadata/` (enrichment cache, `added.json`, `overrides.yaml`, publish state), `infra/outputs.json`, `infra/config.local.json`, and a DynamoDB export to a private S3 prefix. | plan `2026-09-04-backlog-1-3` |
