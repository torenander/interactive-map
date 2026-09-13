# Session handoff — 2026-09-13 (verification-sweep fixes, mid-flight)

Written for the next session picking up the adversarial-sweep fix work. Everything
below is verified against the tree, not assumed. The one thing genuinely open and
important is the **intermittent offline-reload flush** — read that section first.

## Branch / PR state

- Work branch: `feat/sweep-fixes`, pushed, open as **PR #4** into `main`.
- `main` is at `9def30b` (the shipped G6–G13 app + move-features release; live and green).
- PR #4 head is `66168c0`. Commits ahead of main, oldest first:
  - `946cc73` docs: fix seven stale/false claims (audit)
  - `9785bd8` docs(readme): fresh-clone Prerequisites + stale status line
  - `f5911d4` docs(testing): e2e figure 73 executions, not 65
  - `807d27e` fix(offline): flush when the session arrives, not only when the network does (finding 2)
  - `2609ec8` test(offline): gate the session-arrival flush trigger (pure-function unit test)
  - `a51af27` test(overlays): the sheet must be reachable while a session is open (finding 3)
  - `66168c0` fix(overlays): keep Layers reachable while a session is open (finding 3)
- **PR #4 CI is RED** — not mergeable yet. Cause is the offline-reload e2e below, plus
  intermittent Docker Hub image-pull rate limits on `npx supabase start` (infra noise;
  re-running the job clears those, they are not code).

## TOP PRIORITY — offline-reload flush is INTERMITTENT (not just slow)

`tests/e2e/offline.spec.ts:192` ("a queued write survives a reload taken while offline,
and flushes on reconnect") **fails on CI and is flaky locally**. Measured this session on
the desktop project, `--workers=1`, `--retries=0`:

- Run A: passed in 6.8s.
- Run B: the queued area **never reached the server** — 0 rows after the 30s test timeout.

So this is NOT merely a tight-timeout / CI-load problem (that was the first hypothesis and
it is wrong). The offline-reload flush **intermittently does not drain the queue at all**,
even locally. That means finding 2's fix (`807d27e`, the `flushTrigger` effect) is likely
**incomplete**: the pure-function unit test (`2609ec8`, `tests/unit/flush-trigger.test.ts`)
proves the trigger *logic* and passes, but the real integration after an offline reload
still loses the write on some runs. This is a data-loss reliability bug and it blocks PR #4.

Investigate the actual runtime ordering after `page.reload()` while offline, then
`setOffline(false)`:
- Is `session` genuinely non-null when the `online` event fires (fresh token → supabase
  restores from storage synchronously, so it usually is), or is there a window where the
  `online` handler's `runFlush` runs, sees a state that makes it no-op, and nothing
  re-fires it? The `flushTrigger` effect keys on `session`/`mapReady`/queue-length deps —
  if none of those *transition* after the missed flush, the effect never re-runs.
- Suspect: the queue length or `mapReady` settling in an order where both the `online`
  handler and the effect each see a not-yet-ready condition, so neither flushes.
- Capture a Playwright trace on failure (retain-on-failure) and read the app console.
- Fix the app so the flush is reliable, then make the e2e wait on the true completion
  signal (poll `admin.from('areas')` for the row) rather than racing the banner — but note
  the Playwright **test-level timeout is 30s**, so any longer poll also needs the test
  timeout raised. Do NOT merely bump timeouts; the run-B evidence shows the flush itself
  fails, so a timeout change alone would be masking a real bug.

The unit test and `flushTrigger.ts` extraction are good and should stay; the gap is the
integration path.

## Other open findings (recorded, non-urgent — none is data loss)

- **Finding 1 (task #41, WebKit prod sign-in)**: investigated, NOT a repo bug. In
  Playwright's *bundled* WebKit the token POST dies with a transport error (no preflight
  even sent); Chromium, curl, and the local stack all work; hosted CORS is correct. Almost
  certainly a bundled-WebKit artifact. **Needs Tor's real-iPhone Safari sign-in test** to
  close: if it works, add a one-line note to docs/TESTING.md and drop it; if it fails, it
  is an infra/transport question, still no repo fix. Protocol in
  `scratchpad/webkit-auth-mechanism.md`.
- **Finding 3 (task #42, overlay hang) — FIXED** on this branch (`a51af27`/`66168c0`),
  pending the overlay-fix agent's final gate results and lead re-verification.
- **Move-precedence coverage gap (task #43)**: the G13 move-session precedence collisions
  (brush-during-move, tapping a second feature mid-move, double-tap ghost-click on Move)
  were never exercised by the field attack. One focused desktop pass. Details in
  `scratchpad/attack-app.md`.
- **PostgREST info disclosure (task #39, low)**: unauthenticated 42501/PGRST204 responses
  name grants and columns (PostgREST defaults). Not a broken guard — every write path
  auth-checks before validation and all table writes are revoked (verified against the
  hosted project this session). Config-hardening candidate, weigh against debuggability.

## What the sweep confirmed HELD (don't re-litigate)

Backend guards all held under attack (auth-before-validation; INSERT/UPDATE revoked;
RLS enforced on the hosted project). Docs drift and the fresh-clone break (undocumented
`pmtiles` CLI + `playwright install`) are fixed. Fresh-clone prerequisites are now in the
README.

## Environment / conventions

- e2e lock: `bash scripts/e2e-lock.sh {acquire <owner>|release <owner>|status}` —
  ownership-checked, builds take it too (dist/ is shared mutable state). It now DETECTS a
  stale lock (dead holder) and refuses to auto-steal; clear a genuinely-orphaned one with
  the `rm -rf` it prints, after verifying no `playwright test`/`vite preview` is running.
- e2e needs `VITE_TILES_URL=/tiles/london-z14.pmtiles` unless the untracked z15
  `public/tiles/london.pmtiles` is present; run `npm run build` before the preview server;
  kill a stray `:4173` (`lsof -ti:4173 | xargs kill -9`) if "port already used".
- Supabase edge functions mount from the directory the CLI was started in — recycle only
  from this worktree.
- Desktop e2e runs `--workers=1` (measured, dated amendment in OBJECTIVES). Mobile lane
  runs every spec including desktop.spec on purpose (caught a WebKit Tab bug).
- CI (`ci.yml`) runs e2e per-project in separate steps with a flaky-count gate (a
  retried-green fails). PR branches trigger once (push scoped to main).
