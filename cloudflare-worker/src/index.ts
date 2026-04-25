import { INSTITUTIONS, findInstitutionByItemId, syncInstitution } from "./plaid";
import { archiveTransaction, upsertBatch } from "./notion";
import type { Env, PlaidWebhookBody } from "./types";

async function runSyncForInstitution(
  env: Env,
  inst: (typeof INSTITUTIONS)[number],
): Promise<void> {
  const { added, modified, removed } = await syncInstitution(env, inst);
  console.log(
    `[${inst}] added=${added.length} modified=${modified.length} removed=${removed.length}`,
  );

  await upsertBatch(env, [...added, ...modified]);
  for (const txId of removed) {
    await archiveTransaction(env, txId);
  }
}

export default {
  // ----- Plaid webhook receiver -----
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("plaid-notion-sync is alive", { status: 200 });
    }

    let body: PlaidWebhookBody;
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // Only act on the modern transactions webhook. Older UPDATE codes fire too,
    // but SYNC_UPDATES_AVAILABLE is what matches /transactions/sync semantics.
    const relevant =
      body.webhook_type === "TRANSACTIONS" &&
      body.webhook_code === "SYNC_UPDATES_AVAILABLE";

    if (!relevant) {
      return new Response("ignored", { status: 200 });
    }

    // ACK Plaid within their 10s window, do the actual work after returning.
    ctx.waitUntil(
      (async () => {
        const inst = await findInstitutionByItemId(env, body.item_id);
        if (!inst) {
          console.error(`No institution found for item_id=${body.item_id}`);
          return;
        }
        try {
          await runSyncForInstitution(env, inst);
        } catch (err) {
          console.error(`Sync failed for ${inst}:`, err);
        }
      })(),
    );

    return new Response("accepted", { status: 202 });
  },

  // ----- Nightly reconciliation sweep -----
  // Runs at cron in wrangler.toml. Belt-and-suspenders: catches any webhook
  // that was dropped and flips late-posting pending → posted.
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        for (const inst of INSTITUTIONS) {
          try {
            await runSyncForInstitution(env, inst);
          } catch (err) {
            console.error(`Nightly sync failed for ${inst}:`, err);
          }
        }
      })(),
    );
  },
};
