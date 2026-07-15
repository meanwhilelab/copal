import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";

/**
 * Replay-safe writes. The key row is *claimed* before the write runs (response
 * NULL), so concurrent duplicates and post-crash retries never double-execute:
 *
 * - first caller wins the INSERT (unique index), runs the write, stores the result;
 * - a concurrent duplicate loses the INSERT, then waits on the claim row and
 *   returns the stored response once it appears;
 * - a caller whose write threw releases the claim so a later retry can run;
 * - a claim orphaned by a hard crash goes stale and is taken over.
 */
const CLAIM_STALE_MS = 60_000;
const POLL_MS = 50;
const POLL_TRIES = 200; // ~10s ceiling waiting on an in-flight sibling

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withIdempotency<T>(
  db: Db,
  clientId: string,
  key: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!key) return run();

  for (let round = 0; round < 3; round++) {
    // Claim the key. onConflictDoNothing → empty result means someone else holds it.
    const claimed = await db
      .insert(idempotencyKeys)
      .values({ clientId, key, response: null })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });

    if (claimed.length > 0) {
      const rowId = claimed[0]!.id;
      try {
        const result = await run();
        await db
          .update(idempotencyKeys)
          .set({ response: result as object })
          .where(eq(idempotencyKeys.id, rowId));
        return result;
      } catch (err) {
        // Release the claim so a retry with the same key can proceed.
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, rowId)).catch(() => {});
        throw err;
      }
    }

    // Lost the claim — wait for the owner's stored response.
    for (let i = 0; i < POLL_TRIES; i++) {
      const existing = await db.query.idempotencyKeys.findFirst({
        where: and(eq(idempotencyKeys.clientId, clientId), eq(idempotencyKeys.key, key)),
      });
      if (!existing) break; // owner's write failed and released the claim → re-claim
      if (existing.response != null) return existing.response as T;
      if (Date.now() - existing.createdAt.getTime() > CLAIM_STALE_MS) {
        // Orphaned by a crash: take it over.
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id)).catch(() => {});
        break;
      }
      await sleep(POLL_MS);
    }
  }
  throw new Error("idempotency: could not resolve claim for key");
}
