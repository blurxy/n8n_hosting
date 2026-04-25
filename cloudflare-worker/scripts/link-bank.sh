#!/usr/bin/env bash
# Mints a Plaid access_token via Hosted Link and stores it as a Cloudflare Worker secret.
#
# Usage:
#   ./scripts/link-bank.sh <secret-name>
#   e.g.  ./scripts/link-bank.sh PLAID_ACCESS_TOKEN_CHASE
#
# Required env:
#   PLAID_CLIENT_ID
#   PLAID_SECRET
#
# Optional env:
#   WORKER_URL    Cloudflare Worker URL. If set, the resulting Plaid Item is
#                 born with this webhook configured (no /item/webhook/update needed).
#   PLAID_ENV     production (default) | sandbox | development
#   PLAID_USER_ID Identifier Plaid groups your Items under (default: rafi-personal).

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <secret-name>"
  echo "  e.g. $0 PLAID_ACCESS_TOKEN_CHASE"
  exit 1
fi

SECRET_NAME="$1"

: "${PLAID_CLIENT_ID:?Set PLAID_CLIENT_ID in your shell first (export PLAID_CLIENT_ID=...)}"
: "${PLAID_SECRET:?Set PLAID_SECRET in your shell first (export PLAID_SECRET=...)}"

USER_ID="${PLAID_USER_ID:-rafi-personal}"
ENV="${PLAID_ENV:-production}"
BASE="https://${ENV}.plaid.com"

WEBHOOK_FIELD=""
if [ -n "${WORKER_URL:-}" ]; then
  WEBHOOK_FIELD=", \"webhook\": \"$WORKER_URL\""
fi

# Plain-bash JSON value extractor for "key":"value" pairs. No jq dependency.
json_get() {
  printf '%s' "$2" | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E "s/\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

echo "[1/4] Creating Hosted Link session against $BASE..."
CREATE_RESP=$(curl -sX POST "$BASE/link/token/create" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"$PLAID_CLIENT_ID\",
    \"secret\": \"$PLAID_SECRET\",
    \"user\": { \"client_user_id\": \"$USER_ID\" },
    \"client_name\": \"Personal Budget Sync\",
    \"products\": [\"transactions\"],
    \"country_codes\": [\"US\"],
    \"language\": \"en\",
    \"hosted_link\": {}$WEBHOOK_FIELD
  }")

LINK_TOKEN=$(json_get link_token "$CREATE_RESP")
HOSTED_URL=$(json_get hosted_link_url "$CREATE_RESP")

if [ -z "$LINK_TOKEN" ] || [ -z "$HOSTED_URL" ]; then
  echo "Failed to create link_token. Plaid response:"
  echo "$CREATE_RESP"
  exit 1
fi

echo ""
echo "[2/4] Open this URL, complete the bank login, then come back here:"
echo ""
echo "    $HOSTED_URL"
echo ""
printf "Press Enter once you see Plaid's 'Success!' screen... "
read -r _

echo "[3/4] Retrieving public_token..."
GET_RESP=$(curl -sX POST "$BASE/link/token/get" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"$PLAID_CLIENT_ID\",
    \"secret\": \"$PLAID_SECRET\",
    \"link_token\": \"$LINK_TOKEN\"
  }")

PUBLIC_TOKEN=$(json_get public_token "$GET_RESP")

if [ -z "$PUBLIC_TOKEN" ]; then
  echo "No public_token in response. Did the bank flow finish? Plaid response:"
  echo "$GET_RESP"
  exit 1
fi

echo "[4/4] Exchanging public_token -> access_token..."
EXCHANGE_RESP=$(curl -sX POST "$BASE/item/public_token/exchange" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"$PLAID_CLIENT_ID\",
    \"secret\": \"$PLAID_SECRET\",
    \"public_token\": \"$PUBLIC_TOKEN\"
  }")

ACCESS_TOKEN=$(json_get access_token "$EXCHANGE_RESP")
ITEM_ID=$(json_get item_id "$EXCHANGE_RESP")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Exchange failed. Plaid response:"
  echo "$EXCHANGE_RESP"
  exit 1
fi

echo ""
echo "Storing access_token as Cloudflare Worker secret '$SECRET_NAME'..."
printf '%s' "$ACCESS_TOKEN" | npx wrangler secret put "$SECRET_NAME"

echo ""
echo "==========================================="
echo "Done."
echo "  item_id:    $ITEM_ID"
if [ -z "${WORKER_URL:-}" ]; then
  echo ""
  echo "  WORKER_URL was not set, so this Item has no webhook configured."
  echo "  After you deploy the Worker, register the webhook with:"
  echo ""
  echo "    curl -sX POST $BASE/item/webhook/update \\"
  echo "      -H 'Content-Type: application/json' \\"
  echo "      -d '{\"client_id\":\"\$PLAID_CLIENT_ID\",\"secret\":\"\$PLAID_SECRET\",\"access_token\":\"<this-bank-access-token>\",\"webhook\":\"<your-worker-url>\"}'"
else
  echo "  webhook:    $WORKER_URL  (set on the Item at creation)"
fi
echo "==========================================="
