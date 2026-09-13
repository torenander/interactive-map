# Session handoff — 2026-09-13 (verification-sweep fixes, resolved)

Written for the next session picking up the adversarial-sweep fix work. Everything
below is verified against the tree, not assumed. The intermittent offline-reload
flush — the finding that blocked PR #4 — is **root-caused, fixed and independently
re-verified** (`9215786`/`0a39c8d`); the section below records the mechanism.

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
  - `7be671d`/`46f6967`/`8ea3976` docs: handoff + e2e-count corrections
  - `9215786` fix(offline): coalesce a flush requested mid-flush, retry one that left
    work queued (the fix for the section below)
  - `0a39c8d` test(offline): gate the reload flush on the server row, not the banner
- Earlier CI reds were the offline-reload e2e below (now fixed) plus intermittent Docker
  Hub image-pull rate limits on `npx supabase start` (infra noise; re-running the job
  clears those, they are not code).

## RESOLVED — offline-reload flush was a dropped mid-flight request

Fixed in `9215786` (app) + `0a39c8d` (test hardening). Root cause, from an instrumented
failing run: after an offline reload the IndexedDB queue read can land a few ms before
the browser fires `online`, so the flush already in flight is the doomed offline one.
The `online` handler's `runFlush` then hit the in-flight guard and was **discarded** —
and since a failed flush changes nothing the `flushTrigger` effect watches, nothing ever
re-fired. The session was non-null throughout (restores from storage offline) and the
banner text is a static string, so neither of the original hypotheses held. The fix:
a request arriving mid-flush is latched and served by another pass of the same flush
(no await between the loop's exit check and the guard release, so no window remains),
plus a bounded retry ladder (1s–30s) for a pass that leaves work queued while online.
Independently re-verified: offline spec 10/10 and 16/16 isolated loops, full desktop
suite 39/39, mobile overlays 6/6, unit 102/102, build green.

The original investigation record follows, kept for the mechanism detail.

## (was TOP PRIORITY) — offline-reload flush is INTERMITTENT (not just slow)

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

### Confirmed by ISOLATION, not contention (2026-09-13, this session)

A first measurement of this was contaminated (run concurrently with another agent's e2e
against the shared local Supabase, plus a `kill -9` on the shared preview port) — the exact
concurrent-contention trap. It was then **re-measured in true isolation**: exclusive e2e
lock, dedicated `PREVIEW_PORT=4373`, quiet stack, no other agent, `--workers=1
--retries=0`. Result: **2 failures in ~8 runs (~20–25%)**, e.g. runs passing in 14–16s and
others timing out at 30s. So the intermittency is a **real app bug**, not test contention,
not CI-only, not a tight wall clock.

**Captured failure state** (trace retained under `test-results/offline-*/`): at the
`toBeHidden` on `queued-banner` after `setOffline(false)`, the banner is still
`visible` for the full 30s, reading **"1 area queued — offline, will sync"**, and the
server holds 0 rows. So the reconnect flush simply never drains the queue on the failing
runs — the queue is stranded exactly as the production report described. Next step: capture
the app console during a failing run and determine why neither the `online`-event
`runFlush` nor the `flushTrigger` effect fires-to-completion — suspect the `online` handler
runs once while a dep the effect watches never subsequently transitions, so nothing
re-fires. (The banner still saying "offline" on failure is a strong hint — check whether
`navigator.onLine` / the `online` event and the app's own online state actually update in
the failing runs.)

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
- **Finding 3 (task #42, overlay hang) — FIXED AND VERIFIED** on this branch
  (`a51af27`/`66168c0`); independently re-run: desktop suite 39/39, mobile
  overlays.spec 6/6.
- **Move-precedence coverage gap (task #43)**: the G13 move-session precedence collisions
  (brush-during-move, tapping a second feature mid-move, double-tap ghost-click on Move)
  were never exercised by the field attack. One focused desktop pass. Details in
  `scratchpad/attack-app.md`.
- **PostgREST info disclosure (task #39, low) — ACCEPTED RISK, documented** in
  docs/TESTING.md. Metadata only (table/column names, already visible in the shipped JS
  bundle); no data leaks; writes revoked outside `save_area_tx`. The PostgREST
  error-verbosity knob (`client-error-verbosity`) is not exposed on hosted Supabase, and
  moving reads behind RPCs is disproportionate for a low finding. Revisit only if the
  knob ships or reads move behind RPCs anyway.

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
