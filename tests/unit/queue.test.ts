// Offline write queue — docs/OBJECTIVES.md § G4 done_when, docs/TESTING.md "Offline
// write queue: persistence across reload, idempotent retry, failed flush behaviour".
//
// Runs in vitest's default Node environment. `fake-indexeddb/auto` polyfills the global
// `indexedDB` so the same queue module code (src/offline/queue.ts) runs unchanged here
// and in the browser — no mocking of the module under test.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueuedWrites,
  enqueueWrite,
  listQueuedWrites,
  type QueuedWrite,
} from "../../src/offline/queue";
import { flushQueuedWrites } from "../../src/offline/flush";

function makeEntry(overrides: Partial<QueuedWrite> = {}): QueuedWrite {
  return {
    id: crypto.randomUUID(),
    geom: {
      type: "Polygon",
      coordinates: [
        [
          [-0.13, 51.505],
          [-0.125, 51.505],
          [-0.125, 51.51],
          [-0.13, 51.51],
          [-0.13, 51.505],
        ],
      ],
    },
    rating: 1,
    comment: "queued while offline",
    queuedAt: 1234,
    ...overrides,
  };
}

// fake-indexeddb's backing store lives for the whole process, not per test file/case —
// exactly the property the "survives a reload" test below relies on. Drain it between
// tests so one test's leftover entries can't change another's flush results.
beforeEach(async () => {
  await clearQueuedWrites();
});

describe("offline write queue", () => {
  it("a queued entry survives a page reload", async () => {
    const entry = makeEntry();
    await enqueueWrite(entry);

    // "Reload" simulated as a fresh module graph (vi.resetModules), not just a fresh
    // function call — the closest a unit test (no real browser) gets to proving the
    // data lives in durable storage rather than an in-process variable. queue.ts caches
    // no connection at module scope, so this only passes if the entry actually made it
    // into IndexedDB.
    vi.resetModules();
    const afterReload = await import("../../src/offline/queue");
    const items = await afterReload.listQueuedWrites();

    expect(items.map((i) => i.id)).toContain(entry.id);
  });

  it("flushing the same entry twice produces one row, not two", async () => {
    const entry = makeEntry();

    // Stands in for save-area's upsert-by-id semantics (docs/DATA-MODEL.md § Migration
    // 0002): calling save twice with the same id replaces the row, it doesn't add one.
    const serverRows = new Map<string, QueuedWrite>();
    const fakeSave = vi.fn(async (e: QueuedWrite) => {
      serverRows.set(e.id, e);
    });

    await enqueueWrite(entry);
    await flushQueuedWrites(fakeSave);

    // Simulate a retry of the very same entry — e.g. the app flushed successfully but
    // crashed before clearing the local queue, or the user tapped retry twice.
    await enqueueWrite(entry);
    await flushQueuedWrites(fakeSave);

    expect(fakeSave).toHaveBeenCalledTimes(2);
    expect(serverRows.size).toBe(1);
  });

  it("a failed flush leaves the entry in the queue", async () => {
    const entry = makeEntry();
    const failingSave = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    await enqueueWrite(entry);
    const result = await flushQueuedWrites(failingSave);

    expect(result.failed).toEqual([entry.id]);
    expect(result.flushed).toEqual([]);
    const remaining = await listQueuedWrites();
    expect(remaining.map((i) => i.id)).toEqual([entry.id]);
  });
});
