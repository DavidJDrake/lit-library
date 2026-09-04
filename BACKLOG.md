# Backlog

Prioritized improvements, grouped by purpose. Effort is rough: **S** = under an hour
with the usual plan → build → review loop, **M** = an evening, **L** = a weekend.
Items move to "Done" with the commit or plan that closed them.

## Soon

Nothing queued right now — see "Product polish" and the sections below.

## Product polish (independent, each S)

| # | Item | Notes |
|---|---|---|
| 4 | Reading status per user — downloaded / want to read / finished. | "Downloaded" is free from the existing log; the rest is one small table and a toggle on the card. |
| 5 | Shareable URLs — put search and filters in the query string. | ~30 lines; lets someone send "all the TTRPG books". |
| 6 | Second enrichment pass for descriptions (25% coverage today). | Google Books by title+author, only for books still lacking a description; likely doubles coverage. |
| 7 | Send-to-Kindle and/or an OPDS feed. | OPDS is another view of `catalog.json` behind the same session cookie; e-reader apps (KOReader, Moon+) can browse it directly. |
| 8 | Progressive cover loading — virtualize or page the grid. | 1,065 lazy images is fine on desktop, heavy on phones. |

## Security and operations

| # | Item | Effort | Notes |
|---|---|---|---|
| 9 | CloudFront response-headers policy: CSP, `X-Content-Type-Options`, HSTS. | S | Cheap insurance for tokens in `sessionStorage`. |
| 10 | CloudWatch alarms: Lambda errors, and estimated charges > $5/month, both to email. | S | A broken deploy is currently discovered by a friend. |
| 11 | GitHub Actions CI: all three test suites plus `cdk synth` on every push. | S | Suites are fully offline — no secrets needed. Green badge on the public repo. |
| 12 | Dependabot / Renovate for the three package manifests. | S | Otherwise this quietly rots. |

## Repo as portfolio

| # | Item | Effort | Notes |
|---|---|---|---|
| 13 | Screenshots or a short GIF in the README. | S | Blur covers if purchases shouldn't be visible. |
| 14 | A "what I'd do differently" retrospective section. | S | Material: the CloudFront cache-policy rule that bit, signed cookies vs an auth'd catalog API, keeping search client-side. |
| 15 | Post the real first-month AWS bill in the README. | S | A real number beats an estimate. |

## Done

| # | Item | Closed by |
|---|---|---|
| 1 | **Close the stale-session gap.** Made `DELETE /api/session` unauthenticated (it only clears cookies), shortened the signed cookie to 2 h, and had the app renew it silently every 90 min while signed in. | plan `2026-09-04-backlog-1-3` |
| 2 | **"Recently added" first, plus a one-command refresh.** Default the grid to newest-first and add a script that indexes new bundles and publishes in one step. | plan `2026-09-04-backlog-1-3` |
| 3 | **Back up what can't be regenerated.** Script that copies `metadata/` (enrichment cache, `added.json`, `overrides.yaml`, publish state), `infra/outputs.json`, `infra/config.local.json`, and a DynamoDB export to a private S3 prefix. | plan `2026-09-04-backlog-1-3` |
