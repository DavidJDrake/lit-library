#!/usr/bin/env bash
# Add a user who has already signed in to the Cognito "admins" group.
# Admins can accept category suggestions and add categories directly.
# Usage: scripts/make-admin.sh <email>
set -euo pipefail
EMAIL=${1:?usage: $0 <email>}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION=$(python3 -c "import json;print(json.load(open('$ROOT/infra/config.local.json'))['region'])")
POOL=$(python3 -c "import json;o=next(iter(json.load(open('$ROOT/infra/outputs.json')).values()));print(o['UserPoolId'])")
# Federated users have usernames like google_1234…; look them up by email.
USERNAME=$(aws cognito-idp list-users --user-pool-id "$POOL" --region "$REGION" \
  --filter "email = \"$EMAIL\"" --query 'Users[0].Username' --output text)
if [ -z "$USERNAME" ] || [ "$USERNAME" = "None" ]; then
  echo "no Cognito user with email $EMAIL — they must sign in to the site once first" >&2
  exit 1
fi
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --region "$REGION" \
  --username "$USERNAME" --group-name admins
echo "added $EMAIL ($USERNAME) to admins — they must sign out and back in to get a token with the group"
