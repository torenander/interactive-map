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
