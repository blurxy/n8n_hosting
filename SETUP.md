# Plaid → Notion Real-Time Budget Sync — Setup

Platform: **Cloudflare Workers** (free tier). Webhook-driven, near-real-time. Nightly cron as a safety net. Zero local resource usage.

## What's already done
- Notion "Transactions" database: https://www.notion.so/2975ea12ab234685b792ad880c53f6c8
  - Database ID: `2975ea12-ab23-4685-b792-ad880c53f6c8` (already in `wrangler.toml`)
- Worker source code: `cloudflare-worker/src/` (index.ts, plaid.ts, notion.ts, types.ts)
- Old n8n workflow JSON is kept as a reference fallback — ignore unless you switch platforms

## Your manual steps

### 1. Get credentials
You need:
- **Plaid** `client_id` and `secret` (Production) — from https://dashboard.plaid.com/team/keys
- **Plaid access tokens** for each of your 3 institutions — from Plaid Link flow (one-time OAuth)
  - Chase (Auto + Freedom + Checking)
  - Capital One (Platinum + Quicksilver)
  - Synchrony (Amazon)
- **Notion Internal Integration Token** — from https://notion.so/my-integrations
  - Then: open the Transactions database → `···` → Connections → add your integration

### 2. Install Wrangler and log in
```bash
cd cloudflare-worker
npm install
npx wrangler login
```
This opens a browser to auth with your Cloudflare account (free, no CC needed for Workers free plan).

### 3. Create the KV namespace
Stores Plaid cursors between runs.
```bash
npx wrangler kv:namespace create "SYNC_STATE"
```
Copy the `id` from the output and paste into `wrangler.toml` where it says `PLACEHOLDER_REPLACE_AFTER_wrangler_kv_create`.

### 4. Set secrets
Run each of these and paste the value when prompted (values never appear on screen or in shell history):
```bash
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put PLAID_ACCESS_TOKEN_CHASE
npx wrangler secret put PLAID_ACCESS_TOKEN_CAPITAL_ONE
npx wrangler secret put PLAID_ACCESS_TOKEN_SYNCHRONY
npx wrangler secret put NOTION_TOKEN
```

### 5. Deploy
```bash
npx wrangler deploy
```
Output will include your worker URL, e.g.:
```
https://plaid-notion-sync.<your-subdomain>.workers.dev
```
**Copy this URL** — it's your Plaid webhook endpoint.

### 6. Register the webhook with Plaid
Two options:

**A) Per-item (recommended for existing links):**
```bash
curl -X POST https://production.plaid.com/item/webhook/update \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "YOUR_CLIENT_ID",
    "secret": "YOUR_SECRET",
    "access_token": "ACCESS_TOKEN_FOR_CHASE",
    "webhook": "https://plaid-notion-sync.<your-subdomain>.workers.dev"
  }'
```
Repeat for Capital One and Synchrony access tokens.

**B) Default for the whole account:**
Set default webhook URL in Plaid Dashboard → Team Settings → Webhooks. New Link flows will auto-use this.

### 7. First sync
- Cursors are empty on first run, so Plaid returns your full transaction history (up to 2 years)
- Either wait for a real transaction to trigger the webhook, or force it immediately:
  ```bash
  curl -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
    -H "Content-Type: application/json" \
    -d '{"client_id":"...","secret":"...","access_token":"...","webhook_code":"SYNC_UPDATES_AVAILABLE"}'
  ```
- Watch it run live:
  ```bash
  npx wrangler tail
  ```
- Check Notion — rows should appear

### 8. Fill in the account mapping
Open `src/notion.ts`. After first sync, grab the real Plaid `account_id` values from the worker logs (or call `/accounts/get`) and fill in `ACCOUNT_MAP`:
```ts
const ACCOUNT_MAP: Record<string, string> = {
  "abc123...": "Chase Freedom",
  "def456...": "Chase Auto",
  "ghi789...": "Capital One Platinum",
  // etc.
};
```
Redeploy: `npx wrangler deploy`.

## How it works

- **Webhook path**: Plaid posts to your worker when new/modified/removed transactions exist. Worker ACKs in <100ms, then runs `/transactions/sync` and upserts to Notion via `ctx.waitUntil()`.
- **Cron path**: 1 AM EST nightly sweep hits all three institutions as a safety net. Same code path as webhook.
- **Idempotency**: Each Notion row is keyed by `Plaid Transaction ID`. Upsert = query by that field → PATCH if found, POST if not.
- **Cursor**: Persisted per-institution in KV. Only advances after successful Notion writes, so failures auto-retry on next trigger.

## Common commands
```bash
npx wrangler dev              # local dev server (uses .dev.vars for secrets)
npx wrangler deploy           # push to production
npx wrangler tail             # stream live logs
npx wrangler kv:key list --binding=SYNC_STATE   # see stored cursors
npx wrangler secret list      # see which secrets are set (not values)
```

## Troubleshooting

**"No institution found for item_id=..."** — The item_id doesn't match any of your 3 access tokens. Check that all three `PLAID_ACCESS_TOKEN_*` secrets are set correctly.

**"Notion /pages failed: 404"** — The Notion integration isn't connected to the database. Open the DB → `···` → Connections → add your integration.

**"Account is 'Uncategorized' for everything"** — `ACCOUNT_MAP` in `src/notion.ts` is still empty. Fill it with real Plaid `account_id` values and redeploy.

**Pending transactions stuck in Pending** — Plaid fires another webhook when pending → posted transitions happen. If your webhook URL was down or misconfigured during that event, the nightly cron (1 AM EST) will catch it.

**Plaid webhook verification** — Currently disabled for simplicity. For production hardening, implement JWT verification using Plaid's `/webhook_verification_key/get` endpoint + the `Plaid-Verification` header.

## Cost
- Cloudflare Workers free plan: 100k requests/day, 10ms CPU/request
- You'll use maybe 20-50 webhook requests/day + 1 cron trigger = **~$0.00/month**
- KV free plan: 100k reads, 1k writes/day — you'll use ~5 writes/day

## Files
```
cloudflare-worker/
├── package.json
├── wrangler.toml        (worker config + cron)
├── tsconfig.json
├── .gitignore
├── .dev.vars.example    (template for local secrets)
└── src/
    ├── index.ts         (webhook + scheduled handlers)
    ├── plaid.ts         (Plaid API calls + cursor management)
    ├── notion.ts        (Notion upsert by transaction_id)
    └── types.ts         (Env + Plaid type definitions)
```
