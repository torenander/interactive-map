// The gate for the offline-reload data-loss fix (scratchpad/attack-app.md § 2).
//
// Why this exists as a unit test rather than an e2e: the e2e in tests/e2e/offline.spec.ts
// covers the journey but CANNOT fail without the fix. Against a local stack the stored
// token is seconds old, so Supabase restores the session with no network call, the
// null-session window never opens, and the defect has nowhere to happen. A green that
// cannot go red is not a gate. This can go red, and the commit message records both runs.
import { describe, expect, it } from "vitest";
import {
  nextFlushRetry,
  shouldFlushOnSessionArrival,
  type FlushRetryInputs,
  type FlushTriggerInputs,
} from "../../src/offline/flushTrigger";

const base: FlushTriggerInputs = {
  mapReady: true,
  hasSession: true,
  queuedAreas: 0,
  queuedFeatures: 0,
};

describe("shouldFlushOnSessionArrival", () => {
  it("flushes when a session arrives with a queued area", () => {
    expect(shouldFlushOnSessionArrival({ ...base, queuedAreas: 1 })).toBe(true);
  });

  it("flushes when a session arrives with a queued feature", () => {
    // A queue holding only a moved point is as stranded as one holding an area.
    expect(shouldFlushOnSessionArrival({ ...base, queuedFeatures: 1 })).toBe(true);
  });

  it("flushes on a mixed queue", () => {
    expect(shouldFlushOnSessionArrival({ ...base, queuedAreas: 1, queuedFeatures: 2 })).toBe(true);
  });

  // This is the transition the defect lost. Signed out with work queued is the state an
  // offline reload leaves behind: nothing to flush as, so no flush — and before the fix
  // that was the end of it, because the arrival of a session was never re-examined.
  it("does not flush while there is no session, however much is queued", () => {
    expect(
      shouldFlushOnSessionArrival({ ...base, hasSession: false, queuedAreas: 3, queuedFeatures: 4 }),
    ).toBe(false);
  });

  it("flushes once that same queue gains a session", () => {
    const stranded = { ...base, hasSession: false, queuedAreas: 3, queuedFeatures: 4 };
    expect(shouldFlushOnSessionArrival(stranded)).toBe(false);
    expect(shouldFlushOnSessionArrival({ ...stranded, hasSession: true })).toBe(true);
  });

  it("does not flush an empty queue, so a plain sign-in is not a write", () => {
    expect(shouldFlushOnSessionArrival(base)).toBe(false);
  });

  it("does not flush before the map is ready, when the queue counts are not yet read", () => {
    expect(shouldFlushOnSessionArrival({ ...base, mapReady: false, queuedAreas: 1 })).toBe(false);
  });

  // The no-spin argument the fix rests on: a failed flush leaves the counts unchanged, so
  // the same inputs must keep producing the same answer. If this were stateful, the effect
  // that depends on those counts could re-fire itself forever.
  //
  // Read with the block below, though: this purity is also this function's blind spot. It
  // cannot SEE a failed flush, so it can never be the thing that retries one. That is what
  // stranded the queue in task #44, and it is why `nextFlushRetry` exists.
  it("is pure, so a failed flush cannot make it oscillate", () => {
    const inputs = { ...base, queuedAreas: 2 };
    const answers = Array.from({ length: 5 }, () => shouldFlushOnSessionArrival(inputs));
    expect(answers).toEqual([true, true, true, true, true]);
    expect(inputs).toEqual({ ...base, queuedAreas: 2 });
  });
});

// The second half of the task #44 fix. Root cause, measured on Chromium with the app
// console captured (1 failure in 16 isolated runs of tests/e2e/offline.spec.ts):
//
//   trigger:effect {qa: 1, trigger: true}   <- queue read lands while still offline
//   runFlush:enter {busy: false, onLine: false}
//   runFlush:areas {flushed: [], failed: [1]}   <- the save fails, network is down
//   event:online                                <- 2ms later, connectivity returns
//   runFlush:enter {busy: true}  -> SKIPPED     <- DROPPED: a flush was still in flight
//   <nothing, ever>                             <- queue stranded, server holds 0 rows
//
// Two things had to change. MapShell now COALESCES a request that lands mid-flush instead
// of dropping it, which closes exactly that interleaving. And a pass that leaves work
// queued while the browser reports itself online arms a bounded retry — because no input
// `shouldFlushOnSessionArrival` watches transitions after a failure, so without a timer a
// missed edge of ANY kind is unrecoverable.
const retryBase: FlushRetryInputs = { online: true, queuedTotal: 1, attempt: 0 };

describe("nextFlushRetry", () => {
  it("retries a pass that left work queued while online", () => {
    expect(nextFlushRetry(retryBase)).toEqual({ retry: true, delayMs: 1_000 });
  });

  it("does not retry once the queue is empty", () => {
    expect(nextFlushRetry({ ...retryBase, queuedTotal: 0 })).toEqual({ retry: false });
  });

  // Offline there is nothing to retry into, and the `online` event will drive the flush
  // the moment connectivity returns. Burning the ladder against a dead network would leave
  // nothing for the reconnect that actually matters.
  it("does not retry while offline", () => {
    expect(nextFlushRetry({ ...retryBase, online: false })).toEqual({ retry: false });
  });

  it("backs off, so a server that keeps refusing is not hammered", () => {
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => {
      const decision = nextFlushRetry({ ...retryBase, attempt });
      return decision.retry ? decision.delayMs : null;
    });
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
  });

  // Bounded on purpose. A write the server genuinely rejects (not a transport failure)
  // fails identically every time; re-sending it every 30s for the lifetime of the tab
  // would be a background loop nobody asked for. MapShell resets the counter on the next
  // `online` edge and on any pass that actually drains something, so a real reconnect
  // always gets a fresh ladder.
  it("gives up after the ladder is spent", () => {
    expect(nextFlushRetry({ ...retryBase, attempt: 6 })).toEqual({ retry: false });
    expect(nextFlushRetry({ ...retryBase, attempt: 99 })).toEqual({ retry: false });
  });

  it("is pure", () => {
    const inputs = { ...retryBase, attempt: 2 };
    expect(nextFlushRetry(inputs)).toEqual(nextFlushRetry(inputs));
    expect(inputs).toEqual({ ...retryBase, attempt: 2 });
  });
});
