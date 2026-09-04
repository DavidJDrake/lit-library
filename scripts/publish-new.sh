#!/usr/bin/env bash
# Index any new bundles and publish them: one command after dropping new folders into the library.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/indexer"
before=$(python3 -c "import json,os;print(len(json.load(open('../metadata/added.json'))) if os.path.exists('../metadata/added.json') else 0)")
.venv/bin/python -m ebook_indexer index --config ../config.yaml
after=$(python3 -c "import json;print(len(json.load(open('../metadata/added.json'))))")
echo "new books: $((after - before))"
.venv/bin/python -m ebook_indexer publish --config ../config.yaml
echo "published — CloudFront invalidation requested for catalog.json"
