# ebook-share infra

CDK app (TypeScript) for the ebook-share stack: S3 storage, CloudFront site,
Cognito auth (Google sign-in, restricted to an allowlist), and an HTTP API for signed
download URLs.

## Deploy

```
npm run deploy
```

Then, from the repo root, apply the stack outputs to the site config:

```
python3 scripts/apply-outputs.py
```

## Google OAuth secret

The Google identity provider reads its client credentials from Secrets
Manager, at the secret name in `googleOAuthSecretName` in
`infra/config.local.json` (`ebook-share/google-oauth`). The secret must be a
JSON object with these fields:

```json
{
  "client_id": "...",
  "client_secret": "..."
}
```

## Authorizing an account

Access is controlled by a comma-separated allowlist of emails in an SSM
parameter (`/ebook-share/allowed-emails`). To add someone:

```
aws ssm put-parameter --region us-east-1 \
  --name /ebook-share/allowed-emails \
  --type String --overwrite \
  --value "a@x,b@y"
```

This takes effect within about 60 seconds (the pre-signup Lambda caches the
parameter for that long) and requires no redeploy. A newly authorized account still needs
to sign in with Google once to create their Cognito user.

**SSM-parameter-freeze caveat:** the `AllowedEmails` parameter in
`lib/auth.ts` is seeded by CDK on first deploy only so there's an allowlist
before anyone has run the CLI command above. After that first deploy, do
**not** change that resource's properties (name, description, or seed
value) in code — any change makes CloudFormation reset `Value` on the next
deploy, silently evicting every account added via `put-parameter`. Manage
the allowlist only through the AWS CLI, never by editing the CDK source.

## Removing an account

Removing an email from the allowlist parameter only blocks *new* sign-ups —
the pre-signup trigger fires once, at account creation, so an existing
Cognito user keeps working. To fully revoke someone:

1. List users to find their username:
   `aws cognito-idp list-users --user-pool-id <user-pool-id>`
2. Delete their account:
   `aws cognito-idp admin-delete-user --user-pool-id <user-pool-id> --username <username>`

Their refresh tokens die with the user, so any cached session stops working
once it needs to renew.

## Admins (category management)

Members of the Cognito group `admins` can accept category suggestions and add
categories directly. Add someone who has already signed in with
`scripts/make-admin.sh <email>`; remove them with
`aws cognito-idp admin-remove-user-from-group --user-pool-id <pool> --username <username> --group-name admins`.
Group membership is read from the ID token, so changes take effect at the next
sign-in (or token refresh, at most an hour).

Category state lives in the `Library/Table` DynamoDB table (retained). The seven
built-in categories are seeded by custom resources on deploy; they are never
deleted or renamed by CDK. `scripts/pull-edits.py` copies edits into
`metadata/overrides.yaml`; `scripts/backup.sh` exports the table.

## Notifications

`Notifications/Table` is disposable: rows carry a 90-day TTL, the table is not
retained on stack deletion and `scripts/backup.sh` does not export it. The
notifications Lambda has `cognito-idp:ListUsers` / `ListUsersInGroup` on the pool
(recipient fan-out) and read access to the library table (suggestion status). The
library Lambda has the same Cognito permissions plus write access to the
notifications table. `scripts/publish-new.sh` invokes the notifications Lambda
directly (`NotificationsFunctionName` output) after a publish that added books;
that needs `lambda:InvokeFunction` on the caller's credentials.

## Send to Kindle (SES)

The stack verifies the site domain in SES with Easy DKIM (three CNAMEs in the hosted
zone) and sends from `kindleSender` (`config.local.json`). One-time steps:

1. **Sandbox testing.** New SES accounts are sandboxed: mail goes only to verified
   addresses. SES console → Identities → Create identity → *Email address* → your own
   `@kindle.com` address; click the confirmation link Amazon emails (it lands in your
   Kindle library as a document — open it there). Add the sender to your Amazon
   approved personal-document senders. Then `/settings` → save the address → send a
   small EPUB.
2. **Production access.** SES → Account dashboard → *Request production access*:
   transactional mail, personal library, tens of messages a month. Until approved,
   other users see "Kindle delivery isn't enabled for everyone yet".

Bounces, complaints, and rejects reach the `kindle-events` Lambda, which notifies the
user, logs `kindle.bounce`, and emails the alerts topic.

## Reviewing events

Every Lambda writes one JSON line per business event with an `event` field. In
CloudWatch Logs Insights, select the Lambda log groups and run:

    filter ispresent(event) | sort @timestamp desc | limit 200

or narrow to `filter event like /^kindle\./`. Events: `download.issued`,
`suggestion.created|accepted|rejected`, `category.created`, `notification.fanout`,
`kindle.sent`, `kindle.oversize`, `kindle.send_failed`, `kindle.bounce`. Kindle Lambdas
keep logs 3 months; the others 1 month.

## Alerts

`Alerts/*` creates one SNS topic (email subscription from `alarmEmail` in
`config.local.json`) and seven CloudWatch alarms: `Errors ≥ 1` in 5 minutes for each of
the five Lambdas, `5xx ≥ 1` in 5 minutes on the HTTP API, and month-to-date
`EstimatedCharges > $5` (USD, 6-hour period). Every alarm emails on ALARM and again on
OK, and treats missing data as fine (a quiet site is not a broken site).

Two one-time steps after the first deploy that creates the topic:

1. **Confirm the subscription.** SNS emails "AWS Notification - Subscription
   Confirmation" to `alarmEmail`; click the link, or nothing is ever delivered.
2. **Enable billing alerts.** The `AWS/Billing` metric is only published (and only in
   `us-east-1`) after you turn on *Receive Billing Alerts*: console → Billing and Cost
   Management → Billing preferences → Alert preferences. Until then the charges alarm
   simply stays in `INSUFFICIENT_DATA`.

To change the address, edit `alarmEmail` and redeploy; the old subscription is removed
and the new one needs confirming.

## Construct IDs that must never be renamed after first deploy

These constructs use `RemovalPolicy.RETAIN` and are keyed by their CDK
logical id, which is derived from the construct id path. Renaming any of
them causes CloudFormation to create a brand-new resource and orphan (not
delete, but stop managing) the old one:

- `Storage/Books` — the books S3 bucket
- `Api/Downloads` — the downloads DynamoDB table
- `Auth/UserPool` — the Cognito user pool
- `Library/Table` — the category overlay table

## Sending the right token to `/download`

The SPA must send the Cognito **ID token** — not the access token — as the
`Authorization` header on `POST /api/download`. The download Lambda reads the
signed-in user's email from the token's `email` claim, which only the ID
token carries; requests authenticated with an access token are rejected
with 401 (no email claim).

## Adding books

Drop new bundle folders into the library, then run `scripts/publish-new.sh`
from the repo root: it indexes any new bundles and publishes the updated
catalog in one step, printing how many books were newly added and
confirming the CloudFront invalidation for `catalog.json`.

## Deploying the web app

`scripts/deploy-web.sh` builds `web/` and syncs it to the site bucket (it never touches
`catalog.json` or `covers/`, which the indexer owns). `scripts/deploy-web.sh --dry-run`
shows what would change. Run it after any front-end change. For local development,
`cd web && npm run dev` serves http://localhost:5173 against the live catalog and API
(that origin is registered on the Cognito client). `scripts/write-web-env.py` writes
`VITE_DEV_PROXY_TARGET` into the web env files so the dev server can proxy
`/api`, `/catalog.json`, and `/covers` to the deployed CloudFront distribution
without needing CORS.

## Session cookies (catalog access)

`/catalog.json` and `/covers/*` are gated behind CloudFront signed cookies,
not the Cognito JWT directly. After sign-in, the SPA calls `GET /api/session`
(with the Cognito ID token in the `Authorization` header); the session Lambda
signs a CloudFront custom policy with the private half of the configured
signing key and returns it as three `HttpOnly`, `Secure`, `SameSite=Lax`
cookies (`CloudFront-Policy`, `CloudFront-Signature`, `CloudFront-Key-Pair-Id`)
scoped to the whole site, valid for 2 hours. While signed in, the app calls
`GET /api/session` again every 90 minutes to renew the cookies silently, so a
tab left open keeps working. `DELETE /api/session` is unauthenticated (it
only clears cookies, via `Max-Age=0`) so sign-out can end the session even
when the Cognito ID token has already expired and there's no refresh token
left to renew it; short of that, the cookies simply expire on their own.
Because renewal depends on a live ID token, removing someone from Cognito
(see "Removing an account" above) ends their catalog access within at most
2 hours, once their current cookie expires.

**Rotating the signing key:** run `scripts/make-signing-key.sh --rotate`, then
`npm run deploy`. The CloudFront `PublicKey` resource's name is derived from a
hash of the PEM (see `lib/signing.ts`), so a new key produces a new resource
name — CloudFormation creates the new `PublicKey` and deletes the old one
instead of attempting an in-place key-material update, which CloudFront
rejects. Existing signed cookies stop validating as soon as the deploy
completes (their signature was made with the old, now-deleted key); anyone
with an active session simply needs to reload and sign in again.

## Configuration

Deployment configuration lives in `infra/config.local.json` (gitignored, one
per environment) — copy `infra/config.example.json` and fill it in. Every key
in `InfraConfig` (`lib/config.ts`) is required; `loadConfig` also refuses to
proceed if `cloudfrontPublicKeyPem` still matches the example config's
placeholder key, since that key's private half is public and deploying with
it would let anyone forge a valid session. Run `scripts/make-signing-key.sh`
first to generate a real key pair (private key → Secrets Manager, public key
→ `config.local.json`).

## Backups

Everything that can't be regenerated — the enrichment cache and `added.json`
in `metadata/`, `infra/outputs.json`, `infra/config.local.json`, `config.yaml`,
and the downloads DynamoDB table — is backed up to a private `_backup/`
prefix in the books bucket:

```
scripts/backup.sh
```

`scripts/backup.sh --dry-run` shows what would be uploaded without writing
anything. The bucket is private and the download Lambda can only presign
keys listed in the catalog, so `_backup/` is unreachable from the site.

In addition to syncing the current `metadata/` contents (which a later run
can overwrite), each run also writes a point-in-time snapshot: a
`metadata-<stamp>.tar.gz` archive of the whole `metadata/` directory (minus
`publish.log`) at `_backup/metadata-archives/`, so a bad enrichment run or an
accidental edit can be rolled back to any prior backup, not just the most
recent one.

The DynamoDB export at `_backup/dynamodb/downloads-<stamp>.json` is a log of
that run's table contents, not a restorable snapshot — restoring means
reading it (e.g. to audit past downloads), not re-importing it into the
table.

To restore:

```
aws s3 sync s3://<books-bucket>/_backup/metadata/ metadata/
aws s3 cp s3://<books-bucket>/_backup/infra/outputs.json infra/outputs.json
aws s3 cp s3://<books-bucket>/_backup/config.yaml config.yaml
aws s3 cp s3://<books-bucket>/_backup/infra/config.local.json infra/config.local.json
```

To restore `metadata/` from a specific point in time instead of the latest
sync:

```
aws s3 cp s3://<books-bucket>/_backup/metadata-archives/metadata-<stamp>.tar.gz .
tar -xzf metadata-<stamp>.tar.gz
```
