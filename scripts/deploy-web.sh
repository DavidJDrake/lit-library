#!/usr/bin/env bash
# Build the SPA and publish it to the site bucket. Never touches catalog.json or covers/
# (the indexer owns those). Usage: scripts/deploy-web.sh [--dry-run]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUTS="$ROOT/infra/outputs.json"
REGION=us-east-1
DRY=${1:-}

read -r BUCKET DIST_ID CLIENT_ID < <(python3 - "$OUTPUTS" <<'EOF'
import json, sys
o = next(iter(json.load(open(sys.argv[1])).values()))
print(o["SiteBucketName"], o["DistributionId"], o["UserPoolClientId"])
EOF
)

python3 "$ROOT/scripts/write-web-env.py" "$OUTPUTS" "$ROOT/web"
cd "$ROOT/web"
npm run build

# Guard against a mis-wired build: the public client id must be baked into the bundle.
if ! grep -q "$CLIENT_ID" dist/assets/*.js; then
  echo "ERROR: built bundle does not contain the Cognito client id — refusing to deploy" >&2
  exit 1
fi
[ -f dist/index.html ] && [ -f dist/robots.txt ] || { echo "ERROR: dist is incomplete" >&2; exit 1; }

SYNC_ARGS=(dist/ "s3://$BUCKET/" --region "$REGION" --delete
  --exclude "index.html" --exclude "catalog.json" --exclude "covers/*"
  --cache-control "public, max-age=31536000, immutable")
if [ "$DRY" = "--dry-run" ]; then
  aws s3 sync "${SYNC_ARGS[@]}" --dryrun
  echo "(dry run — nothing uploaded)"; exit 0
fi

aws s3 sync "${SYNC_ARGS[@]}"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --region "$REGION" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
aws s3 cp dist/robots.txt "s3://$BUCKET/robots.txt" --region "$REGION" \
  --cache-control "no-cache" --content-type "text/plain"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --output text --query 'Invalidation.Id'
echo "deployed to https://lit.example.com"
