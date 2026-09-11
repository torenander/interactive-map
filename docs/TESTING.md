# Testing conventions

## What gets tested

**Unit (vitest)** — the parts where a bug corrupts data silently:
- H3 derivation from a polygon
- Offline write queue: persistence across reload, idempotent retry, failed flush behaviour
- Rating validation
- Schema constraints against a local Supabase instance (checks, cascades, RLS isolation)

**E2E (Playwright, iPhone 14 viewport, 390x844)** — one flow per goal, not exhaustive coverage:
- `map-shell.spec.ts` — map renders, viewport, attribution, geolocate
- `mvp-loop.spec.ts` — draw, rate, save, reload, edit, delete
- `offline.spec.ts` — save with network blocked, flush on reconnect
- `offline-map.spec.ts` — tiles from cache with network blocked

**Not tested** — third-party surface, low value:
- MapLibre rendering internals
- Tile loading and pmtiles range requests
- Terra Draw internals

## Rules

- Every PR that touches `src/areas` or a migration needs a test.
- Every PR that touches `src/ui` needs a mobile-viewport screenshot in the description.
- A test that asserts nothing about behaviour is not a test. `expect(true).toBe(true)`, a test with no assertion, or a test that only checks a function did not throw does not count towards a goal's exit criteria.
- Do not change an existing assertion to make a new implementation pass. If the assertion is wrong, say so and stop.
- Mobile viewport first. Desktop is verified after, never instead.

## One machine, one run at a time

Anything that drives a browser, serves the app, or writes `dist/` must hold the lock in
`scripts/e2e-lock.sh` for its whole duration:

```bash
OWNER=my-agent-name
scripts/e2e-lock.sh acquire "$OWNER" || exit 1
trap 'scripts/e2e-lock.sh release "$OWNER"' EXIT
npm run test:e2e
```

**`npm run build` counts.** This is not caution — two builds running at once corrupt each
other's output deterministically, and the second one dies with `Unable to find a place to
inject the manifest`, because both write `dist/sw.js` and the PWA plugin reads back what
the other build already replaced. A build racing a live `vite preview` rewrites the hashed
assets underneath it. Reserving the lock only for Playwright runs leaves exactly that hole.

**The lock gates edits as well as runs.** While somebody else holds it, do not edit
anything a run reads — `tests/e2e/*`, `src/*`, `vite.config.ts`, `playwright.config.ts`.
Vite rebuilds and Playwright reads spec files as it goes, so an edit mid-run surfaces as a
failure whose stack trace points at a line that no longer exists, or at a comment. That is
an afternoon lost to a phantom bug, and it has already happened here once: a full run
under the lock failed against a stack trace pointing at a comment, because another agent
was editing `perf-load.spec.ts` while it executed.

The run lock cannot express "hold the source still", so a measurement that needs a stable
tree has two options: ask the file's owner for an explicit freeze and wait for their
confirmation, or run in a throwaway worktree at a fixed commit (below), which is immune by
construction and is the better answer whenever the measurement matters.

`scripts/e2e-lock.sh status` says who holds it, and whether that process is still alive.
A lock whose holder is gone reports `stale` and acquisition fails with exit 2 naming the
dead PID, rather than making every waiter sit out its full timeout. Clearing a stale lock
is a deliberate `rm -rf` after checking, never automatic — "the PID is gone" and "the
process forked" are indistinguishable from outside.

### What was flaky, and what was not

One full-suite run failed three tests (draw-precision border-snap, overlays offline,
perf-load) and was reported as suite flakiness. It is not. Eleven full-suite runs later:

| Condition | Runs | Result |
|---|---|---|
| No contention | 6 | 27/27 every time |
| Induced contention (CPU load, or a build fired mid-run) | 5 | 2 runs failed, 3 clean |

Every contention-induced failure hit a **different** test — mvp-loop's `beforeAll` when the
preview server was killed, touch-draw's `locator.tap` on a 30 s timeout. So contention
produces non-deterministic failures wherever the timing happens to land when two things run
at once, and the fix for those is the lock rather than the tests.

**Amended 2026-09-11:** that conclusion was right about the machine and wrong to stop
there. One of the three original failures, `perf-load`, had a findable cause of its own —
its `workerStart <= entryEnd` check compared two service-worker cache hits milliseconds
apart and failed at 11 ms against 10 ms even at `workers=1` under the lock. It is now a
structural assertion (see `docs/TASKS-G7.md`). The lesson worth keeping: "fails in a suite,
passes in isolation" looks like contention, and a test whose assertion is itself a race
produces exactly the same signature. Rule out the assertion before blaming the machine.

Why contention was possible at all despite both agents "holding the lock": one of the two
acquisition loops had the guard bug below and had silently lost the lock it believed it
held. That is the whole mechanism.

Two failure modes this replaced, both real:

- The inlined loop this helper supersedes guarded with `[ -d "$LOCK" ]`, which is true
  precisely when *somebody else* holds the lock. An exhausted acquisition fell through the
  guard and ran unlocked, then released a lock it never owned on exit. Two agents could
  each believe they held it, and neither would see an error.
- Ownership by PID alone is not enough: two scripts sharing a parent shell have the same
  parent PID and could release each other. The owner name in the lock decides, and
  `release` refuses when it does not match.

An unconditional `rmdir` on release is the same defect wearing different clothes, and it
stays harmless only for as long as acquisition is correct. Both halves are guarded here;
do not reintroduce either by inlining "just three lines" into a new script.

### Testing at your own commit in a shared worktree

Several agents share one worktree, so `src/` often carries somebody else's uncommitted
work. That makes "does my test fail before the feature exists?" unanswerable in place — a
red-first spec will pass on its first run because the implementation is already sitting
there, unstaged.

Do not stash or revert their files. Commit your own work, then check out a throwaway
worktree at your commit, where their uncommitted changes do not exist:

```bash
git worktree add -f ../g11-red HEAD
cp .env ../g11-red/.env                                   # gitignored, needed to boot
ln -sfn "$PWD/public/tiles/london.pmtiles" ../g11-red/public/tiles/london.pmtiles
( cd ../g11-red && PREVIEW_PORT=4673 npx playwright test --project=desktop <spec> )
git worktree remove --force ../g11-red
```

It must live under the repo root's tree so Node still resolves `node_modules` by walking
up. Two things that hid reds the first time: the tiles archive and `.env` are both
gitignored, so without them the app never boots and every test fails for the wrong reason;
and `test.describe.configure({ mode: 'serial' })` skips the remaining tests after the
first failure, showing one red where there were six. Switch the throwaway copy to
sequential and non-serial so every assertion fails on its own merits.

### What this constrains in CI

The lock is not a courtesy about CPU. `dist/` is shared mutable state, and the e2e suite
reads from the same directory the build writes — which is why two builds destroy each
other rather than merely slowing each other down. The suite therefore assumes exclusive
access to the machine *and* to `dist/`. That is a property to design around, not a bug to
fix.

The consequence: two CI jobs on one runner sharing a checkout cannot both run e2e. If that
is ever attempted, it will present as flaky tests — a different test failing each time,
never reproducible in isolation — rather than as a build collision, and cost somebody an
afternoon chasing the tests instead of the runner. Give each concurrent job its own
checkout, or serialize them.

### Desktop runs one worker at a time

The desktop project runs with `--workers=1`, and `docs/OBJECTIVES.md` § G11 carries the
flag in its `done_when` line for that reason. Measured on this machine: at 5 workers a full
desktop run went 32/32 then failed 3; at 2 workers, 32/32 then 2 then 2; at 1 worker, five
consecutive runs with every test clean except the `perf-load` assertion bug fixed
separately above. Mobile at the same 5 workers was 6/6 clean, so this is about weight —
Chromium at 1440x900 costs far more per worker than WebKit at 390x844 — not about the
tests.

The cost is 174-192 s against roughly 100 s. A deterministic three-minute gate is worth
more than a ninety-second coin flip; a gate that fails intermittently on merit teaches
people to re-run it, which is how a real failure gets waved through.

The same applies when the desktop lane reaches `ci.yml`: it needs its own step with the
flag, not a second project bolted onto the existing `npm run test:e2e` invocation.

## Commands

```bash
npm run test              # vitest, all unit
npm run test -- tests/unit/queue.test.ts
npm run test:e2e          # playwright, mobile viewport
npm run test:e2e -- tests/e2e/mvp-loop.spec.ts
npx supabase db reset     # rebuild local DB from migrations before schema tests

scripts/e2e-lock.sh status          # who holds the machine, and are they alive
scripts/e2e-lock.sh acquire NAME    # blocks; non-zero rather than running unlocked
scripts/e2e-lock.sh release NAME    # refuses to release somebody else's lock
```
