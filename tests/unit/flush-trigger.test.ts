// The gate for the offline-reload data-loss fix (scratchpad/attack-app.md § 2).
//
// Why this exists as a unit test rather than an e2e: the e2e in tests/e2e/offline.spec.ts
// covers the journey but CANNOT fail without the fix. Against a local stack the stored
// token is seconds old, so Supabase restores the session with no network call, the
// null-session window never opens, and the defect has nowhere to happen. A green that
// cannot go red is not a gate. This can go red, and the commit message records both runs.
import { describe, expect, it } from "vitest";
import {
  shouldFlushOnSessionArrival,
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
  it("is pure, so a failed flush cannot make it oscillate", () => {
    const inputs = { ...base, queuedAreas: 2 };
    const answers = Array.from({ length: 5 }, () => shouldFlushOnSessionArrival(inputs));
    expect(answers).toEqual([true, true, true, true, true]);
    expect(inputs).toEqual({ ...base, queuedAreas: 2 });
  });
});
