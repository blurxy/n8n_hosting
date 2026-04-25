import type {
  Env,
  InstitutionKey,
  PlaidSyncResponse,
  PlaidTransaction,
} from "./types";

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

export const INSTITUTIONS: InstitutionKey[] = [
  "chase",
  "capital_one",
  "synchrony",
];

export function accessTokenFor(env: Env, inst: InstitutionKey): string {
  switch (inst) {
    case "chase":
      return env.PLAID_ACCESS_TOKEN_CHASE;
    case "capital_one":
      return env.PLAID_ACCESS_TOKEN_CAPITAL_ONE;
    case "synchrony":
      return env.PLAID_ACCESS_TOKEN_SYNCHRONY;
  }
}

export async function findInstitutionByItemId(
  env: Env,
  itemId: string,
): Promise<InstitutionKey | null> {
  // Cache item_id → institution mapping in KV on first lookup so we
  // avoid calling /item/get for every webhook.
  const cacheKey = `item_to_inst:${itemId}`;
  const cached = await env.SYNC_STATE.get(cacheKey);
  if (cached) return cached as InstitutionKey;

  for (const inst of INSTITUTIONS) {
    const token = accessTokenFor(env, inst);
    if (!token) continue;
    const resp = await plaidFetch(env, "/item/get", { access_token: token });
    if (resp?.item?.item_id === itemId) {
      await env.SYNC_STATE.put(cacheKey, inst);
      return inst;
    }
  }
  return null;
}

export async function plaidFetch(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<any> {
  const url = PLAID_HOSTS[env.PLAID_ENV] + path;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Plaid ${path} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function syncInstitution(
  env: Env,
  inst: InstitutionKey,
): Promise<{
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: string[];
}> {
  const accessToken = accessTokenFor(env, inst);
  if (!accessToken) {
    console.warn(`No access token for ${inst} — skipping`);
    return { added: [], modified: [], removed: [] };
  }

  const cursorKey = `cursor:${inst}`;
  let cursor = (await env.SYNC_STATE.get(cursorKey)) ?? "";

  const added: PlaidTransaction[] = [];
  const modified: PlaidTransaction[] = [];
  const removed: string[] = [];

  // Plaid paginates via has_more; loop until drained.
  while (true) {
    const resp: PlaidSyncResponse = await plaidFetch(env, "/transactions/sync", {
      access_token: accessToken,
      cursor,
      count: 500,
    });
    added.push(...resp.added);
    modified.push(...resp.modified);
    removed.push(...resp.removed.map((r) => r.transaction_id));
    cursor = resp.next_cursor;
    if (!resp.has_more) break;
  }

  // Only persist the cursor AFTER all pages succeeded. If Notion writes fail
  // later, the caller can throw and we'll re-sync the same deltas next run.
  await env.SYNC_STATE.put(cursorKey, cursor);

  return { added, modified, removed };
}
