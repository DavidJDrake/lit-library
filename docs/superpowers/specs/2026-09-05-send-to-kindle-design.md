# Send to Kindle — Design Spec

**Date:** 2026-09-05
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-09-05-notifications-design.md` (fan-out, bell, renderer table),
`2026-09-04-user-categories-design.md` (library table, admins), and the download
Lambda from `2026-08-31-ebook-share-design.md`.

## Purpose

A "Send to Kindle" button that emails a book's EPUB (or PDF) to the user's
`@kindle.com` address via Amazon SES, a per-user Kindle address setting, bounce
handling that closes the loop for the user and for engineering, and a shared
structured event log for every Lambda.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| Delivery mechanism | Email with the file **attached** (Amazon's Send-to-Kindle only ingests attachments; links are ignored). |
| Pipeline | **Synchronous** (Approach A): one Lambda streams the object from S3 and calls SES in the request. A queue + worker (Approach B) is the upgrade path if volume ever warrants it — noted in the README. |
| Bounces | User gets a `kindle_bounce` notification; engineering gets a structured `kindle.bounce` log event and an email on the alerts topic. |
| Event logging | Structured JSON lines to CloudWatch (`logEvent(name, fields)` shared helper), adopted for the Kindle events and retrofitted to existing Lambdas. No events table. |
| Kindle address UX | Inline capture on first send plus a `/settings` page. |
| Sender | `library@<siteDomain>` (config `kindleSender`); SES domain identity with Easy DKIM written into Route 53 by CDK; no custom MAIL FROM. |
| Size limit | **28 MB** per file (`KINDLE_MAX_BYTES = 28 * 1024 * 1024`): SES's 40 MB raw-message cap after base64. Larger files: download instead. |
| Formats | EPUB preferred, PDF otherwise; CBZ/ZIP unsupported. |
| Out of scope | MOBI conversion, sending to multiple devices, per-send format conversion, an events table, a metric-filter alarm on bounces (the alerts email covers it). |

## Infrastructure (`infra/lib/kindle.ts`, `Kindle` construct)

- **SES identity**: `ses.EmailIdentity` for `config.siteDomain` with
  `Identity.publicHostedZone(zone)` — CDK creates the three Easy-DKIM CNAMEs; the
  hosted zone is looked up the same way `Site` does. Sender address
  `config.kindleSender` (example `library@lit.example.com`); `loadConfig` requires it and
  checks its domain equals `siteDomain`.
- **Configuration set** `kindle` with an event destination publishing `BOUNCE`,
  `COMPLAINT`, `REJECT` to SNS topic `KindleEvents`; the `kindle-events` Lambda subscribes.
- **`kindle` Lambda** (`infra/lambda/kindle/`): Node 22, 60 s timeout, 1024 MB, log
  retention 3 months. Routes on the existing HTTP API (default JWT authorizer):
  `GET /api/kindle/address`, `PUT /api/kindle/address`, `POST /api/kindle/send`.
  Grants: `s3:GetObject` on `books/*` objects; `s3:GetObject` on `catalog.json` in the
  site bucket; `ses:SendEmail` + `ses:SendRawEmail` on the identity ARN and the
  configuration-set ARN; read/write on the library table (settings row); `PutItem` on
  the downloads table. Env: `KINDLE_SENDER`, `KINDLE_CONFIG_SET`, `BOOKS_BUCKET`,
  `SITE_BUCKET`, `LIBRARY_TABLE`, `DOWNLOADS_TABLE`.
- **`kindle-events` Lambda** (`infra/lambda/kindle-events/`): SNS-triggered, 30 s,
  log retention 3 months. Grants: write on the notifications table, the two Cognito
  list actions on the pool ARN (fan-out), `sns:Publish` on the alerts topic. Env:
  `NOTIFICATIONS_TABLE`, `USER_POOL_ID`, `ALERTS_TOPIC_ARN`.
- `Alerts` exposes its topic; the stack passes it to `Kindle`. CDK diff is additive.
- **Sandbox**: SES accounts start sandboxed — sends succeed only to console-verified
  recipients until production access is granted (one-time request). The Lambda maps
  the sandbox rejection to a user-facing message. Steps are in `infra/README.md`.

## Data

Settings row in the **library** table: `pk = USER#<email>`, `sk = SETTINGS`,
`{ kindleAddress: string, updatedAt }`. Only the caller's own row (token email,
lowercased) is read or written. Kindle sends are logged in the **downloads** table with
`format: "kindle:<epub|pdf>"` and the same shape as a download row.

## API

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/kindle/address` | 200 `{ kindleAddress: string \| null }` |
| `PUT` | `/api/kindle/address` | body `{ kindleAddress }`. Must match `^[A-Za-z0-9._+-]+@kindle\.com$` (case-insensitive; stored lowercased) → 204; `""` clears → 204; else 400. |
| `POST` | `/api/kindle/send` | body `{ bookId, format?: "epub" \| "pdf" }`. Resolve the book from `catalog.json` (cached 60 s as in the download Lambda; 404 unknown). Choose `format` if given and present, else EPUB, else PDF; none → 400 `{ error: "unsupported" }`. No saved address → 409 `{ error: "no_address" }`. Object size (from the catalog) > `KINDLE_MAX_BYTES` → 413 `{ error: "too_large", bytes, limit }`. Otherwise stream the object from S3, build a MIME message (From `KINDLE_SENDER`, To the Kindle address, Subject = book title, one attachment named `<safe title>.<ext>` with the right content type, message tags `recipient=<user email>` and `bookId`), send with `SendEmail` (raw content, `ConfigurationSetName`). On success: write the downloads row (`format: "kindle:<ext>"`), `logEvent("kindle.sent", { email, bookId, format, bytes, sesMessageId })`, return 202 `{ sentTo, format }`. SES `MessageRejected` containing "not verified" → 502 `{ error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" }`; any other S3/SES failure → 502 with the message and `logEvent("kindle.send_failed", …)`. The downloads row is written only after SES accepts. |

Errors are JSON `{ error, message? }`; unexpected exceptions → 500 with logged stack.

## Event logging (`infra/lambda/shared/log.ts`)

```ts
logEvent(name: string, fields: Record<string, unknown>): void
// prints one line: JSON.stringify({ event: name, at: new Date().toISOString(), ...fields })
```

Events at launch: `kindle.sent`, `kindle.send_failed`, `kindle.oversize`,
`kindle.bounce`; retrofitted with no behaviour change: `download.issued`,
`suggestion.created`, `suggestion.accepted`, `suggestion.rejected`,
`category.created`, `notification.fanout` (`{ type, recipients }`). Fields never
include file contents or another user's settings. `infra/README.md` documents the
Logs Insights query (`filter event like /^kindle\./ | sort @timestamp desc`) and the
meaning of each event.

## Bounce handling (`kindle-events` Lambda)

For each SES event record (`Bounce`, `Complaint`, `Reject`) in the SNS message:

1. Read message tags `recipient` and `bookId` (never derive identity from the bounce
   report); ignore records without a `recipient` tag.
2. `notify([recipient], "kindle_bounce", { bookId, kind, reason })`. The notification
   row's `sk` uses the SES message id as its unique part (`<createdAt>#<sesMessageId>`)
   so a redelivered event overwrites rather than duplicates. `notify` gains an optional
   `id` override for this.
3. `logEvent("kindle.bounce", { recipient, bookId, kind, reason, sesMessageId })`.
4. Publish a one-paragraph summary to the alerts topic (subject
   `Kindle delivery <kind>: <local part of recipient>`).

A failure inside this Lambda surfaces through the existing Lambda-error alarm.

## Web UI

- **`KindleProvider`** (`web/src/kindle/`): `{ address, status, save(address), send(bookId, format?) }`. Loads the address on sign-in; `send` throws a typed `KindleError` with `code ∈ { no_address, too_large, unsupported, not_enabled, failed }`.
- **`BookDetail`**: a **Send to Kindle** button beside the download buttons, rendered only when the book has an EPUB or PDF. Disabled with tooltip *"Too large for Kindle delivery — download instead"* when the file that would be sent exceeds 28 MB (sizes come from the catalog). Sends the EPUB by default; when both exist a secondary "(PDF)" link sends the PDF. States: idle → "Sending…" → toast **"Sent to <address> — it usually arrives within a couple of minutes"**. On `no_address` the button is replaced by an inline form: input *"Your Kindle email"* (client-validated `@kindle.com`), a "Where do I find this?" link to Amazon's Personal Document Settings, and **Save and send**, which saves then retries. `not_enabled`/`failed` toast the message.
- **`/settings` page** (router route; header gets a ⚙ link labelled "Settings" beside the bell): the Kindle address field with Save, and the checklist: (1) find the address under Amazon → Content & Devices → Preferences → Personal Document Settings; (2) add `<kindleSender>` to the approved personal-document senders. The sender comes from `VITE_KINDLE_SENDER`, written by `scripts/write-web-env.py` from `infra/config.local.json`; `vite.config.ts` requires it.
- **Renderer entry** `kindle_bounce`: icon 📵, text *Your Kindle rejected "<title>" — add <sender> to your approved senders* (title via `titleOf`), link `/settings`.
- **README**: feature bullet; a note that the synchronous design suits this scale and that SQS + a worker Lambda is the path if volume grows; diagram nodes for SES and the two Lambdas.

## Error handling summary

| Condition | Behaviour |
|---|---|
| No address | 409 `no_address` → inline form |
| Bad address | 400 (client validates too) |
| No EPUB/PDF | 400 `unsupported` (button hidden anyway) |
| > 28 MB | 413 `too_large` (button disabled anyway) |
| Sandbox, unverified recipient | 502 `not_enabled` with the friendly message |
| Other S3/SES error | 502 + `kindle.send_failed` |
| Bounce/complaint/reject | notification + log + alerts email; idempotent on message id |
| kindle-events Lambda error | existing Lambda-error alarm |

## Testing (offline)

- **infra**: CDK assertions (identity + DKIM records, configuration set + event
  destination + topic subscription, both Lambdas' grants scoped as listed, three routes on
  the authorizer, 3-month log retention, output); `kindle` handler (format choice incl.
  explicit `format`, `no_address`, oversize, `not_enabled` mapping, MIME has one
  attachment with the right name/type and both tags, downloads row only after success,
  address validation and lowercasing); `kindle-events` handler (bounce → notify + log +
  alert, idempotent `sk`, records without tags ignored, complaint and reject kinds);
  `logEvent` output shape; retrofitted events asserted in existing handler tests.
- **web**: `KindleProvider` (load, save, send, typed errors), `BookDetail` (button
  visibility per formats and size, sending state, `no_address` → form → save-and-send,
  PDF secondary link, toast copy), `SettingsPage`, renderer `kindle_bounce`,
  `write-web-env.py` emits `VITE_KINDLE_SENDER`, `vite.config.ts` requires it.

## Rollout

1. Add `kindleSender` to `config.local.json`; deploy infra; confirm DKIM
   (`aws sesv2 get-email-identity --email-identity <siteDomain>` → `VerifiedForSendingStatus: true`).
2. SES console: verify your own Kindle address as a sandbox recipient. Amazon: add the
   sender to your approved personal-document senders.
3. Deploy web; save your Kindle address on `/settings`; send a small EPUB; it appears on
   the Kindle.
4. Bounce test: remove the sender from the approved list, send, expect the bell row and
   the alerts email; restore.
5. Request SES production access (SES → Account dashboard → Request production access;
   transactional, personal library, tens of emails per month). Until approved, friends
   see the "not enabled yet" message.
