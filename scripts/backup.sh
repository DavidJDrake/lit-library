#!/usr/bin/env bash
# Back up everything that cannot be regenerated to a private prefix in the books bucket.
# Usage: scripts/backup.sh [--dry-run]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY=${1:-}
REGION=$(python3 -c "import json;print(json.load(open('$ROOT/infra/config.local.json'))['region'])")
read -r BUCKET TABLE < <(python3 -c "import json;o=next(iter(json.load(open('$ROOT/infra/outputs.json')).values()));print(o['BooksBucketName'], o['DownloadsTable'])")
DEST="s3://$BUCKET/_backup"
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
SYNC=(aws s3 sync "$ROOT/metadata/" "$DEST/metadata/" --region "$REGION" --exclude "publish.log")
[ "$DRY" = "--dry-run" ] && SYNC+=(--dryrun)
"${SYNC[@]}"
for f in infra/outputs.json infra/config.local.json config.yaml; do
  if [ "$DRY" = "--dry-run" ]; then echo "(dryrun) upload: $f -> $DEST/$f"; else aws s3 cp "$ROOT/$f" "$DEST/$f" --region "$REGION" >/dev/null; fi
done
if [ "$DRY" = "--dry-run" ]; then
  echo "(dryrun) would export DynamoDB table $TABLE to $DEST/dynamodb/downloads-$STAMP.json"
else
  TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
  aws dynamodb scan --table-name "$TABLE" --region "$REGION" --output json > "$TMP"
  aws s3 cp "$TMP" "$DEST/dynamodb/downloads-$STAMP.json" --region "$REGION" >/dev/null
  echo "exported $(python3 -c "import json;print(json.load(open('$TMP'))['Count'])") download rows"
fi
echo "backup complete: $DEST"
