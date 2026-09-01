# ebook-share infra

CDK app (TypeScript) for the ebook-share stack: S3 storage, CloudFront site,
Cognito auth (Google sign-in, invite-only), and an HTTP API for signed
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
Manager, at the secret name in `CONFIG.googleOAuthSecretName`
(`ebook-share/google-oauth`). The secret must be a JSON object with these
fields:

```json
{
  "client_id": "...",
  "client_secret": "..."
}
```

## Inviting a friend

Access is controlled by a comma-separated allowlist of emails in an SSM
parameter (`/ebook-share/allowed-emails`). To add someone:

```
aws ssm put-parameter --region us-east-1 \
  --name /ebook-share/allowed-emails \
  --type String --overwrite \
  --value "a@x,b@y"
```

This takes effect within about 60 seconds (the pre-signup Lambda caches the
parameter for that long) and requires no redeploy. A new friend still needs
to sign in with Google once to create their Cognito user.

**SSM-parameter-freeze caveat:** the `AllowedEmails` parameter in
`lib/auth.ts` is seeded by CDK on first deploy only so there's an allowlist
before anyone has run the CLI command above. After that first deploy, do
**not** change that resource's properties (name, description, or seed
value) in code — any change makes CloudFormation reset `Value` on the next
deploy, silently evicting every friend added via `put-parameter`. Manage
the allowlist only through the AWS CLI, never by editing the CDK source.

## De-inviting someone

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
`Authorization` header on `POST /download`. The download Lambda reads the
signed-in user's email from the token's `email` claim, which only the ID
token carries; requests authenticated with an access token are rejected
with 401 (no email claim).
