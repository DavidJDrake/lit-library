# Backlog

Prioritized improvements, grouped by purpose. Effort is rough: **S** = under an hour
with the usual plan → build → review loop, **M** = an evening, **L** = a weekend.
Items move to "Done" with the commit or plan that closed them.

## Soon

| # | Item | Effort | Why |
|---|---|---|---|
| 1 | **Close the stale-session gap.** Make `DELETE /api/session` unauthenticated (it only clears cookies), shorten the signed cookie to ~2 h, and have the app renew it silently while signed in. | S | Today the 12 h cookie outlives both the ID token and allowlist removal: sign-out can't clear `HttpOnly` cookies once the Google session is gone, and de-inviting doesn't end an active session. |
| 2 | **"Recently added" first, plus a one-command refresh.** Default the grid to newest-first and add a script that indexes new bundles and publishes in one step. | S | Friends return for new books; adding a bundle is currently a terminal ritual only the owner knows. |
| 3 | **Back up what can't be regenerated.** Script that copies `metadata/` (enrichment cache, `added.json`, `overrides.yaml`, publish state), `infra/outputs.json`, `infra/config.local.json`, and a DynamoDB export to a private S3 prefix. | S | The enrichment cache is ~25 min to rebuild; `added.json` and the download log are unrecoverable. |

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

_(none yet)_
