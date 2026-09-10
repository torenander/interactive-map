// Flushing the queue. The save function is injected rather than imported directly so
// tests/unit/queue.test.ts can exercise flush behaviour (idempotent retry, failed flush
// leaves the entry queued) without a network or a running Supabase instance.
import { listQueuedWrites, removeQueuedWrite, type QueuedWrite } from "./queue";

export type FlushResult = {
  flushed: string[];
  failed: string[];
};

// Last-write-wins on `updated_at` is the whole conflict story (docs/DATA-MODEL.md §
// Client-side write queue) — single-user, so real conflicts are rare, and save-area's
// upsert-by-id already gives that for free server side. No merge logic here by design.
export async function flushQueuedWrites(
  save: (entry: QueuedWrite) => Promise<unknown>,
): Promise<FlushResult> {
  const entries = await listQueuedWrites();
  const flushed: string[] = [];
  const failed: string[] = [];

  for (const entry of entries) {
    try {
      await save(entry);
      await removeQueuedWrite(entry.id);
      flushed.push(entry.id);
    } catch {
      // Left in the queue — docs/OBJECTIVES.md § G4 done_when: "a failed flush leaves
      // the entry in the queue."
      failed.push(entry.id);
    }
  }

  return { flushed, failed };
}
