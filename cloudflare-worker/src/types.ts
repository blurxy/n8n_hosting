export interface Env {
  SYNC_STATE: KVNamespace;

  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ACCESS_TOKEN_CHASE: string;
  PLAID_ACCESS_TOKEN_CAPITAL_ONE: string;
  PLAID_ACCESS_TOKEN_SYNCHRONY: string;
  PLAID_ENV: "sandbox" | "development" | "production";
  PLAID_WEBHOOK_VERIFICATION_KEY_ID?: string;

  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  personal_finance_category: {
    primary: string;
    detailed: string;
  } | null;
}

export interface PlaidSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidWebhookBody {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  error?: unknown;
}

export type InstitutionKey = "chase" | "capital_one" | "synchrony";
