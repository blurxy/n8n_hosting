# Plaid → Notion Real-Time Budget Sync — Setup

Platform: **Cloudflare Workers** (free tier). Webhook-driven, near-real-time.
Nightly cron as a safety net. Zero local resource usage.

## What's already done

- Notion "Transactions" database: https://www.notion.so/2975ea12ab234685b792ad880c53f6c8
  (Database ID `2975ea12-ab23-4685-b792-ad880c53f6c8`, already in `wrangler.toml`)
- Worker source: `cloudflare-worker/src/` (index.ts, plaid.ts, notion.ts, types.ts)
- Worker dependencies installed (`npm install` already run)
- Helper script `cloudflare-worker/scripts/link-bank.sh` that mints a Plaid access
  token via Hosted Link and stores it as a Cloudflare secret in one shot
- Old n8n workflow JSON is kept as a reference fallback — ignore unless you switch platforms

## Steps you do manually

The whole thing is ~10 commands plus three browser logins (one per bank).

### 1. Get credentials (browser)

**Plaid** — https://dashboard.plaid.com/team/keys
Copy your **Production** `client_id` and `secret`. (If Production is not yet
unlocked, you can run the entire flow against `sandbox.plaid.com` first to verify
the worker logic — see "Sandbox path" at the bottom.)

**Notion** — https://notion.so/my-integrations
- Click **+ New integration**, name it "Plaid Sync", copy the secret token.
- Open the Transactions database → `···` → **Connections** → add your integration.
  (Skipping this makes every Notion API call return 404.)

### 2. Cloudflare login

```bash
cd cloudflare-worker
npx wrangler login
```
Opens a browser. Free Cloudflare account, no credit card required.

### 3. Create the KV namespace

```bash
npx wrangler kv:namespace create "SYNC_STATE"
```
Copy the `id` from the output. Open `wrangler.toml`, replace
`PLACEHOLDER_REPLACE_AFTER_wrangler_kv_create` with that id.

### 4. Set the three baseline secrets

Run each, paste the value when prompted (values are not echoed):

```bash
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put NOTION_TOKEN
```

(The three Plaid `ACCESS_TOKEN_*` secrets are set automatically by the helper
script in step 6.)

### 5. Deploy

```bash
npx wrangler deploy
```

Output ends with your worker URL, e.g.
`https://plaid-notion-sync.<your-subdomain>.workers.dev`. **Copy it.**

### 6. Mint Plaid access tokens via Hosted Link (per bank)

Set Plaid creds + your worker URL as env vars in your shell:

```bash
export PLAID_CLIENT_ID="paste_your_client_id"
export PLAID_SECRET="paste_your_production_secret"
export WORKER_URL="https://plaid-notion-sync.<your-subdomain>.workers.dev"
```

Then run the helper once per bank:

```bash
./scripts/link-bank.sh PLAID_ACCESS_TOKEN_CHASE
./scripts/link-bank.sh PLAID_ACCESS_TOKEN_CAPITAL_ONE
./scripts/link-bank.sh PLAID_ACCESS_TOKEN_SYNCHRONY
```

Each run prints a Hosted Link URL. Open it, log into the bank in your browser,
return to the terminal, press Enter. The script then exchanges the public_token
for an access_token, stores it as a Worker secret, and (because `WORKER_URL`
was exported) tells Plaid to send transaction webhooks to your worker.

The script also prints each `item_id` — keep these in a notepad. They're useful
if you ever need to check or update a specific bank link.

### 7. First sync

Cursors are empty on the first run, so Plaid returns up to 2 years of history.
Either wait for a real transaction or force a sync immediately:

```bash
# In one terminal: stream live logs
npx wrangler tail
```

```bash
# In another terminal: poke each item once to fire the webhook
curl -sX POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
  -H "Content-Type: application/json" \
  -d '{"client_id":"'$PLAID_CLIENT_ID'","secret":"'$PLAID_SECRET'","access_token":"<one-of-your-3-tokens>","webhook_code":"SYNC_UPDATES_AVAILABLE"}'
```
(`fire_webhook` only works in Sandbox. In Production, make a small purchase or
wait — the nightly 1 AM EST cron will catch up otherwise.)

In the `tail` window you should see lines like:
```
[chase] added=N modified=0 removed=0
```
Then check Notion → the rows appear.

### 8. Fill in the account map

After the first sync, scan the `tail` logs for the real Plaid `account_id`
values. Open `cloudflare-worker/src/notion.ts`, find `ACCOUNT_MAP`, fill it:

```ts
const ACCOUNT_MAP: Record<string, string> = {
  "abc123...": "Chase Freedom",
  "def456...": "Chase Auto",
  "ghi789...": "Chase Checking",
  "jkl012...": "Capital One Platinum",
  "mno345...": "Capital One Quicksilver",
  "pqr678...": "Synchrony Amazon",
};
```

Redeploy:
```bash
npx wrangler deploy
```

## Sandbox path (optional, for testing the wiring before going live)

If you want to dry-run the whole pipeline with fake data first:

```bash
# Use sandbox secret instead of production secret
export PLAID_CLIENT_ID="your_client_id"
export PLAID_SECRET="your_sandbox_secret"   # different from production secret
export PLAID_ENV="sandbox"
export WORKER_URL="https://plaid-notion-sync.<your-subdomain>.workers.dev"

./scripts/link-bank.sh PLAID_ACCESS_TOKEN_CHASE
# In the browser flow, log in with username "user_good", password "pass_good"
```

The worker will receive sandbox webhooks, sync sandbox transactions to Notion,
prove the loop end-to-end. When you're ready for real data, unset
`PLAID_ENV` (or set to `production`), re-run the helper for each bank with
production credentials, and you're live.

## How it works

- **Webhook path:** Plaid POSTs to your worker on transaction changes. Worker
  ACKs in <100ms via `ctx.waitUntil()`, then runs `/transactions/sync` and
  upserts to Notion in the background.
- **Cron path:** 1 AM EST nightly sweep over all 3 institutions as a safety net.
  Same code path as the webhook handler.
- **Idempotency:** Each Notion row is keyed by `Plaid Transaction ID`. Upsert
  logic = query that field → PATCH if found, POST if not.
- **Cursor:** Persisted per-institution in KV. Only advances after successful
  Notion writes, so a transient failure auto-retries on the next trigger.

## Common commands

```bash
npx wrangler dev                                  # local dev (uses .dev.vars)
npx wrangler deploy                               # push to production
npx wrangler tail                                 # stream live logs
npx wrangler kv:key list --binding=SYNC_STATE     # see stored cursors
npx wrangler secret list                          # see which secrets are set
```

## Troubleshooting

**"No institution found for item_id=..."** — The `item_id` doesn't match any of
your 3 access tokens. Check that all three `PLAID_ACCESS_TOKEN_*` secrets are
set (`npx wrangler secret list`).

**"Notion /pages failed: 404"** — The Notion integration isn't connected to the
database. Open the DB → `···` → Connections → add your integration.

**"Account is 'Uncategorized' for everything"** — `ACCOUNT_MAP` in
`src/notion.ts` is still empty. Fill it with real Plaid `account_id` values
from the worker logs and redeploy.

**Pending transactions stuck in Pending** — Plaid fires another webhook when
pending → posted transitions happen. If your webhook URL was down or
misconfigured during that event, the nightly cron will catch it.

**Plaid webhook signature verification** — Currently disabled for simplicity.
For production hardening, implement JWT verification using Plaid's
`/webhook_verification_key/get` endpoint and the `Plaid-Verification` header.

## Cost

- Cloudflare Workers free plan: 100k requests/day, 10ms CPU/request
- Expect ~20-50 webhook requests/day + 1 cron trigger = **~$0.00/month**
- KV free plan: 100k reads, 1k writes/day — you'll use ~5 writes/day

## Files

```
cloudflare-worker/
├── package.json
├── wrangler.toml         (worker config + cron)
├── tsconfig.json
├── .gitignore
├── .dev.vars.example     (template for local secrets)
├── scripts/
│   └── link-bank.sh      (Hosted Link helper — mints access_token + sets secret)
└── src/
    ├── index.ts          (webhook + scheduled handlers)
    ├── plaid.ts          (Plaid API calls + cursor management)
    ├── notion.ts         (Notion upsert by transaction_id)
    └── types.ts          (Env + Plaid type definitions)
```
