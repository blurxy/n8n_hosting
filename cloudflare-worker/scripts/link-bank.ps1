# Mints a Plaid access_token via Hosted Link and stores it as a Cloudflare Worker secret.
#
# Usage:
#   .\scripts\link-bank.ps1 -SecretName PLAID_ACCESS_TOKEN_CHASE
#
# Required env:
#   $env:PLAID_CLIENT_ID
#   $env:PLAID_SECRET
#
# Optional env:
#   $env:WORKER_URL    Cloudflare Worker URL. If set, the resulting Plaid Item is
#                      born with this webhook configured (no /item/webhook/update needed).
#   $env:PLAID_ENV     production (default) | sandbox | development
#   $env:PLAID_USER_ID Identifier Plaid groups your Items under (default: rafi-personal).

param(
    [Parameter(Mandatory=$true)]
    [string]$SecretName
)

$ErrorActionPreference = 'Stop'

# Validate required env vars
if (-not $env:PLAID_CLIENT_ID) {
    Write-Error "Set PLAID_CLIENT_ID in your shell first: `$env:PLAID_CLIENT_ID = '...'"
}
if (-not $env:PLAID_SECRET) {
    Write-Error "Set PLAID_SECRET in your shell first: `$env:PLAID_SECRET = '...'"
}

$USER_ID = $env:PLAID_USER_ID ?? 'rafi-personal'
$ENV = $env:PLAID_ENV ?? 'production'
$BASE = "https://${ENV}.plaid.com"

# Helper to extract JSON values (simple parser for "key":"value" pairs)
function Get-JsonValue {
    param([string]$Key, [string]$Json)
    $pattern = "`"$Key`"\s*:\s*`"([^`"]*)`""
    if ($Json -match $pattern) {
        return $matches[1]
    }
    return $null
}

Write-Host "[1/4] Creating Hosted Link session against $BASE..."

$webhookField = ""
if ($env:WORKER_URL) {
    $webhookField = ", `"webhook`": `"$($env:WORKER_URL)`""
}

$createBody = @{
    client_id     = $env:PLAID_CLIENT_ID
    secret        = $env:PLAID_SECRET
    user          = @{ client_user_id = $USER_ID }
    client_name   = "Personal Budget Sync"
    products      = @("transactions")
    country_codes = @("US")
    language      = "en"
    hosted_link   = @{}
} | ConvertTo-Json

# Add webhook field if present (ConvertTo-Json doesn't support conditional fields easily)
if ($env:WORKER_URL) {
    $createBody = $createBody.TrimEnd('}') + ", `"webhook`": `"$($env:WORKER_URL)`"}"
}

try {
    $createResp = Invoke-WebRequest -Uri "$BASE/link/token/create" `
        -Method POST `
        -ContentType "application/json" `
        -Body $createBody `
        -UseBasicParsing | Select-Object -ExpandProperty Content
} catch {
    Write-Error "Failed to create link_token: $_"
}

$LINK_TOKEN = Get-JsonValue -Key "link_token" -Json $createResp
$HOSTED_URL = Get-JsonValue -Key "hosted_link_url" -Json $createResp

if (-not $LINK_TOKEN -or -not $HOSTED_URL) {
    Write-Host "Failed to create link_token. Plaid response:"
    Write-Host $createResp
    exit 1
}

Write-Host ""
Write-Host "[2/4] Open this URL, complete the bank login, then come back here:"
Write-Host ""
Write-Host "    $HOSTED_URL"
Write-Host ""
Write-Host -NoNewline "Press Enter once you see Plaid's 'Success!' screen... "
$null = Read-Host

Write-Host "[3/4] Retrieving public_token..."

$getBody = @{
    client_id   = $env:PLAID_CLIENT_ID
    secret      = $env:PLAID_SECRET
    link_token  = $LINK_TOKEN
} | ConvertTo-Json

try {
    $getResp = Invoke-WebRequest -Uri "$BASE/link/token/get" `
        -Method POST `
        -ContentType "application/json" `
        -Body $getBody `
        -UseBasicParsing | Select-Object -ExpandProperty Content
} catch {
    Write-Error "Failed to get public_token: $_"
}

$PUBLIC_TOKEN = Get-JsonValue -Key "public_token" -Json $getResp

if (-not $PUBLIC_TOKEN) {
    Write-Host "No public_token in response. Did the bank flow finish? Plaid response:"
    Write-Host $getResp
    exit 1
}

Write-Host "[4/4] Exchanging public_token -> access_token..."

$exchangeBody = @{
    client_id      = $env:PLAID_CLIENT_ID
    secret         = $env:PLAID_SECRET
    public_token   = $PUBLIC_TOKEN
} | ConvertTo-Json

try {
    $exchangeResp = Invoke-WebRequest -Uri "$BASE/item/public_token/exchange" `
        -Method POST `
        -ContentType "application/json" `
        -Body $exchangeBody `
        -UseBasicParsing | Select-Object -ExpandProperty Content
} catch {
    Write-Error "Exchange failed: $_"
}

$ACCESS_TOKEN = Get-JsonValue -Key "access_token" -Json $exchangeResp
$ITEM_ID = Get-JsonValue -Key "item_id" -Json $exchangeResp

if (-not $ACCESS_TOKEN) {
    Write-Host "Exchange failed. Plaid response:"
    Write-Host $exchangeResp
    exit 1
}

Write-Host ""
Write-Host "Storing access_token as Cloudflare Worker secret '$SecretName'..."

# Store in Cloudflare via wrangler
$ACCESS_TOKEN | npx wrangler secret put $SecretName

Write-Host ""
Write-Host "==========================================="
Write-Host "Done."
Write-Host "  item_id:    $ITEM_ID"
if (-not $env:WORKER_URL) {
    Write-Host ""
    Write-Host "  WORKER_URL was not set, so this Item has no webhook configured."
    Write-Host "  After you deploy the Worker, register the webhook with:"
    Write-Host ""
    Write-Host "    curl -sX POST $BASE/item/webhook/update \"
    Write-Host "      -H 'Content-Type: application/json' \"
    Write-Host "      -d '{`"client_id`":`"`$PLAID_CLIENT_ID`",`"secret`":`"`$PLAID_SECRET`",`"access_token`":`"<this-bank-access-token>`",`"webhook`":`"<your-worker-url>`"}'"
} else {
    Write-Host "  webhook:    $env:WORKER_URL  (set on the Item at creation)"
}
Write-Host "==========================================="
