#!/usr/bin/env bash
# Generate the CloudFront cookie-signing key pair: private key → Secrets Manager,
# public key → infra/config.local.json (cloudfrontPublicKeyPem).
# Refuses to overwrite an existing secret unless --rotate is passed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/infra/config.local.json"
REGION=$(python3 -c "import json;print(json.load(open('$CONFIG'))['region'])")
SECRET=$(python3 -c "import json;print(json.load(open('$CONFIG'))['signingKeySecretName'])")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

openssl genrsa -out "$TMP/private.pem" 2048 2>/dev/null
openssl rsa -in "$TMP/private.pem" -pubout -out "$TMP/public.pem" 2>/dev/null

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET" >/dev/null 2>&1; then
  if [ "${1:-}" != "--rotate" ]; then
    echo "Secret $SECRET already exists; pass --rotate to replace it" >&2; exit 1
  fi
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET" --secret-string "file://$TMP/private.pem" >/dev/null
else
  aws secretsmanager create-secret --region "$REGION" --name "$SECRET" \
    --description "CloudFront cookie-signing private key for the session endpoint" \
    --secret-string "file://$TMP/private.pem" >/dev/null
fi

python3 - "$CONFIG" "$TMP/public.pem" <<'EOF'
import json, sys
cfg_path, pem_path = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
cfg["cloudfrontPublicKeyPem"] = open(pem_path).read()
json.dump(cfg, open(cfg_path, "w"), indent=2); open(cfg_path, "a").write("\n")
print("public key written to", cfg_path)
EOF
echo "private key stored in Secrets Manager as $SECRET"
