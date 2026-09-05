#!/usr/bin/env bash
# Index any new bundles and publish them: one command after dropping new folders into the library.
# Afterwards, tell the site which books are new so everyone gets a notification.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/indexer"
BEFORE=$(mktemp)
trap 'rm -f "$BEFORE"' EXIT
python3 -c "import json,os,sys;p='../metadata/added.json';json.dump(json.load(open(p)) if os.path.exists(p) else {}, open(sys.argv[1],'w'))" "$BEFORE"
.venv/bin/python -m ebook_indexer index --config ../config.yaml
after=$(python3 -c "import json;print(len(json.load(open('../metadata/added.json'))))")
before=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$BEFORE")
echo "new books: $((after - before))"
.venv/bin/python -m ebook_indexer publish --config ../config.yaml
echo "published — CloudFront invalidation requested for catalog.json"
REGION=$(python3 -c "import yaml;print(yaml.safe_load(open('../config.yaml')).get('aws_region','us-east-1'))" 2>/dev/null || echo us-east-1)
.venv/bin/python "$ROOT/scripts/notify-books-added.py" --before "$BEFORE" --added ../metadata/added.json --region "$REGION" || true
