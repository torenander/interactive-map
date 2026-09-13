// When a pending flush should start.
//
// Extracted from MapShell so the decision can be tested without a browser. The bug this
// exists to gate (scratchpad/attack-app.md § 2) was a MISSING trigger, not a wrong one:
// `runFlush` was reachable only from the `online` event and the manual Sync now button,
// so a queue that outlived a reload taken offline sat there — `online` fired while the
// Supabase session was still null, the flush returned at its own guard, and nothing
// called it again once the session arrived.
//
// Deliberately pure and deliberately not a hook: there is no React test renderer in this
// project (no @testing-library, no jsdom — vitest runs in Node), so a hook-shaped seam
// could not be gated at all. This shape can be, exhaustively and in milliseconds.

export type FlushTriggerInputs = {
  /** The map — and therefore the queue reads that populate the counts — is up. */
  mapReady: boolean
  /** A Supabase session exists. Null during and after an offline reload. */
  hasSession: boolean
  queuedAreas: number
  queuedFeatures: number
}

/**
 * Whether the arrival of a session (or of queued work while signed in) should start a
 * flush.
 *
 * Both queues count: a queue holding only a moved point is as stranded as one holding an
 * area, and before this the banner would say "will sync" over either of them forever.
 */
export function shouldFlushOnSessionArrival(inputs: FlushTriggerInputs): boolean {
  if (!inputs.mapReady) return false
  // The condition the defect turned on. With no session there is nothing to flush AS, and
  // runFlush would return at its first line anyway — what was missing is that this is
  // re-evaluated when a session later appears.
  if (!inputs.hasSession) return false
  return inputs.queuedAreas + inputs.queuedFeatures > 0
}

// ---------------------------------------------------------------------------
// When a flush that left work behind should be tried again.
//
// `shouldFlushOnSessionArrival` above answers "has something changed that makes a flush
// worth starting". That question has a blind spot, and it is the one that stranded a
// queue after an offline reload: a FAILED flush changes nothing. The queue lengths are
// identical, the session is identical, `mapReady` is identical — so the effect watching
// those deps does not re-run, and if the `online` edge has already been spent there is
// nothing left to re-fire the flush. The queue then sits there claiming it "will sync"
// forever, which is data loss dressed as a banner.
//
// So a flush that leaves entries queued while the browser believes it is online arms its
// own retry. Bounded, not perpetual: a write the server genuinely rejects would otherwise
// be re-sent every few seconds for the lifetime of the tab. The attempt counter resets on
// the next `online` edge and on any pass that actually drains something, so a real
// reconnect always gets a fresh ladder.
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

export type FlushRetryInputs = {
  /** `navigator.onLine`. Offline, the `online` event is the trigger; no timer needed. */
  online: boolean
  /** Entries still in both queues after the pass that just finished. */
  queuedTotal: number
  /** Retries already spent in this episode. */
  attempt: number
}

export type FlushRetryDecision = { retry: false } | { retry: true; delayMs: number }

export function nextFlushRetry(inputs: FlushRetryInputs): FlushRetryDecision {
  if (inputs.queuedTotal <= 0) return { retry: false }
  // Offline there is nothing to retry INTO, and the `online` event will drive the flush
  // the moment connectivity returns. Burning the ladder against a disconnected network
  // would leave nothing for the reconnect that actually matters.
  if (!inputs.online) return { retry: false }
  if (inputs.attempt < 0 || inputs.attempt >= RETRY_BACKOFF_MS.length) return { retry: false }
  return { retry: true, delayMs: RETRY_BACKOFF_MS[inputs.attempt] }
}
