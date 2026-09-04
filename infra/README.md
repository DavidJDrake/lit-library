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

## Construct IDs that must never be renamed after first deploy

These constructs use `RemovalPolicy.RETAIN` and are keyed by their CDK
logical id, which is derived from the construct id path. Renaming any of
them causes CloudFormation to create a brand-new resource and orphan (not
delete, but stop managing) the old one:

- `Storage/Books` — the books S3 bucket
- `Api/Downloads` — the downloads DynamoDB table
- `Auth/UserPool` — the Cognito user pool

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
