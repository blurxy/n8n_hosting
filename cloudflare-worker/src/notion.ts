import type { Env, PlaidTransaction } from "./types";

const NOTION_API = "https://api.notion.com/v1";
// 2025-09-03 introduced multi-data-source databases. Required because our
// Transactions DB has more than one data source under the same database id.
const NOTION_VERSION = "2025-09-03";

// Plaid account_id → friendly name. After first webhook, grab real IDs from
// Plaid's /accounts/get response (or the webhook logs) and fill these in.
const ACCOUNT_MAP: Record<string, string> = {
  // "PLAID_ACCOUNT_ID_HERE": "Chase Freedom",
  // "PLAID_ACCOUNT_ID_HERE": "Chase Auto",
  // ...
};

function mapAccount(plaidAccountId: string): string {
  return ACCOUNT_MAP[plaidAccountId] ?? "Uncategorized";
}

function mapCategory(tx: PlaidTransaction): string {
  const pfc = tx.personal_finance_category;
  if (!pfc) return "Uncategorized";

  if (pfc.detailed === "FOOD_AND_DRINK_GROCERIES") return "Groceries";
  if (pfc.detailed?.includes("GAS")) return "Gas";

  const primaryMap: Record<string, string> = {
    FOOD_AND_DRINK: "Food & Drink",
    GENERAL_MERCHANDISE: "Shopping",
    TRANSPORTATION: "Transportation",
    TRAVEL: "Travel",
    ENTERTAINMENT: "Entertainment",
    RENT_AND_UTILITIES: "Utilities",
    MEDICAL: "Medical",
    PERSONAL_CARE: "Personal Care",
    GENERAL_SERVICES: "Subscriptions",
    INCOME: "Paycheck",
    TRANSFER_IN: "Transfer",
    TRANSFER_OUT: "Transfer",
    LOAN_PAYMENTS: "Credit Card Payment",
    BANK_FEES: "Fees & Interest",
  };
  return primaryMap[pfc.primary] ?? "Uncategorized";
}

function txToProperties(tx: PlaidTransaction) {
  const isIncome = tx.amount < 0;
  return {
    Name: { title: [{ text: { content: tx.merchant_name || tx.name } }] },
    Amount: { number: tx.amount },
    Date: { date: { start: tx.date } },
    Type: { select: { name: isIncome ? "Income" : "Expense" } },
    Category: { select: { name: mapCategory(tx) } },
    Account: { select: { name: mapAccount(tx.account_id) } },
    Status: { select: { name: tx.pending ? "Pending" : "Posted" } },
    Merchant: {
      rich_text: [{ text: { content: tx.merchant_name ?? "" } }],
    },
    "Plaid Transaction ID": {
      rich_text: [{ text: { content: tx.transaction_id } }],
    },
    "Plaid Account ID": {
      rich_text: [{ text: { content: tx.account_id } }],
    },
  };
}

async function notionFetch(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<any> {
  const resp = await fetch(NOTION_API + path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Notion ${path} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function findPageByTxId(
  env: Env,
  txId: string,
): Promise<string | null> {
  const resp = await notionFetch(
    env,
    `/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        filter: {
          property: "Plaid Transaction ID",
          rich_text: { equals: txId },
        },
        page_size: 1,
      }),
    },
  );
  return resp.results[0]?.id ?? null;
}

export async function upsertTransaction(
  env: Env,
  tx: PlaidTransaction,
): Promise<void> {
  const existing = await findPageByTxId(env, tx.transaction_id);
  const properties = txToProperties(tx);

  if (existing) {
    await notionFetch(env, `/pages/${existing}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  } else {
    await notionFetch(env, `/pages`, {
      method: "POST",
      body: JSON.stringify({
        parent: { data_source_id: env.NOTION_DATA_SOURCE_ID },
        properties,
      }),
    });
  }
}

export async function archiveTransaction(
  env: Env,
  txId: string,
): Promise<void> {
  const existing = await findPageByTxId(env, txId);
  if (!existing) return;
  await notionFetch(env, `/pages/${existing}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}

// Upsert many with a small concurrency cap to stay under Notion's 3 req/sec limit.
export async function upsertBatch(
  env: Env,
  txs: PlaidTransaction[],
): Promise<void> {
  const CONCURRENCY = 3;
  for (let i = 0; i < txs.length; i += CONCURRENCY) {
    const slice = txs.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map((tx) => upsertTransaction(env, tx)));
    if (i + CONCURRENCY < txs.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
