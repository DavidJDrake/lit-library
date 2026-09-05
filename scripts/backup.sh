#!/usr/bin/env bash
# Back up everything that cannot be regenerated to a private prefix in the books bucket.
# Usage: scripts/backup.sh [--dry-run]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY=${1:-}
case "$DRY" in
  ""|--dry-run) ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2;;
esac
REGION=$(python3 -c "import json;print(json.load(open('$ROOT/infra/config.local.json'))['region'])")
read -r BUCKET TABLE LIBTABLE < <(python3 -c "import json;o=next(iter(json.load(open('$ROOT/infra/outputs.json')).values()));print(o['BooksBucketName'], o['DownloadsTable'], o.get('LibraryTable',''))")
DEST="s3://$BUCKET/_backup"
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
trap 'rm -rf "${TARDIR:-}" "${TMP:-}"' EXIT
SYNC=(aws s3 sync "$ROOT/metadata/" "$DEST/metadata/" --region "$REGION" --exclude "publish.log")
[ "$DRY" = "--dry-run" ] && SYNC+=(--dryrun)
"${SYNC[@]}"
for f in infra/outputs.json infra/config.local.json config.yaml; do
  if [ "$DRY" = "--dry-run" ]; then echo "(dryrun) upload: $f -> $DEST/$f"; else aws s3 cp "$ROOT/$f" "$DEST/$f" --region "$REGION" >/dev/null; fi
done
if [ "$DRY" = "--dry-run" ]; then
  echo "(dryrun) would archive metadata/ -> $DEST/metadata-archives/metadata-$STAMP.tar.gz"
else
  TARDIR=$(mktemp -d)
  tar -czf "$TARDIR/metadata-$STAMP.tar.gz" -C "$ROOT" --exclude=publish.log metadata
  aws s3 cp "$TARDIR/metadata-$STAMP.tar.gz" "$DEST/metadata-archives/metadata-$STAMP.tar.gz" --region "$REGION" >/dev/null
fi
if [ "$DRY" = "--dry-run" ]; then
  echo "(dryrun) would export DynamoDB table $TABLE to $DEST/dynamodb/downloads-$STAMP.json"
else
  TMP=$(mktemp)
  aws dynamodb scan --table-name "$TABLE" --region "$REGION" --output json > "$TMP"
  aws s3 cp "$TMP" "$DEST/dynamodb/downloads-$STAMP.json" --region "$REGION" >/dev/null
  echo "exported $(python3 -c "import json;print(len(json.load(open('$TMP'))['Items']))") download rows"
fi
if [ -n "$LIBTABLE" ]; then
  if [ "$DRY" = "--dry-run" ]; then
    echo "(dryrun) would export DynamoDB table $LIBTABLE to $DEST/dynamodb/library-$STAMP.json"
  else
    LTMP=$(mktemp)
    aws dynamodb scan --table-name "$LIBTABLE" --region "$REGION" --output json > "$LTMP"
    aws s3 cp "$LTMP" "$DEST/dynamodb/library-$STAMP.json" --region "$REGION" >/dev/null
    echo "exported $(python3 -c "import json;print(len(json.load(open('$LTMP'))['Items']))") library rows"
    rm -f "$LTMP"
  fi
fi
echo "backup complete: $DEST"
