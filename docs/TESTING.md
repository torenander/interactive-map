# Testing conventions

## What gets tested

**Unit (vitest)** — the parts where a bug corrupts data silently:
- H3 derivation from a polygon
- Offline write queue: persistence across reload, idempotent retry, failed flush behaviour
- Rating validation
- Schema constraints against a local Supabase instance (checks, cascades, RLS isolation)

**E2E (Playwright)** — one flow per goal, not exhaustive coverage. Eleven spec files run
across two projects: `--project=mobile` (WebKit, iPhone 14 at 390x844, 37 tests — every
spec) and `--project=desktop --workers=1` (Chromium at 1440x900, 36 tests; the flag is
required, see the G11 amendment in `docs/OBJECTIVES.md`).
- `map-shell.spec.ts` — map renders, viewport, attribution, geolocate
- `mvp-loop.spec.ts` — draw, rate, save, reload, edit, delete
- `draw-precision.spec.ts` — vertex handles, explicit finish, snapping to saved borders
- `touch-draw.spec.ts` — the WebKit ghost-click race; mobile only, by design
- `brush.spec.ts` — paint, erase, stroke undo, one polygon on release
- `points-lines.spec.ts` — point and line round trips, moves, offline queue
- `overlays.spec.ts` — toggles, attribution, same-origin, offline
- `desktop.spec.ts` — mouse and keyboard behaviours
- `perf-load.spec.ts` — no whole-archive download, worker not serialized
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

**Amended 2026-09-11 (second):** one of the contention-shaped failures turned out to have
its own cause. `draw-precision.spec.ts` clicked a saved area with no wait for the geojson
source to re-tile after the save, so on a loaded machine the click beat the render and hit
nothing. Fixed in 89e9a67 **on the code asymmetry, not on a reproduction** — it failed once
inside a 40-command sweep and never again in 20 isolated runs or 10 full desktop runs on a
quiet machine. `points-lines.spec.ts` carries seven such waits because that suite hit the
race for real; the sibling suites had none. This mechanism is also a candidate explanation
for the `preventScroll` observation recorded as unresolved — a click landing where the
saved area is not yet painted looks identical to one landing where it has been scrolled
away — and that remains unproven.

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

### A broken measurement looks more convincing than a real one

Three harnesses produced confident numbers while measuring nothing in a single day. The
pattern is worth more than any of them individually: a broken measurement fails uniformly,
and uniformity reads as signal. Real results are ragged.

- A lock guard tested `[ -d "$LOCK" ]`, which is true precisely when somebody else holds
  the lock. Two agents each believed they held it, with no error on either side.
- A rate measurement passed `--screenshot` and `--video`, which are config-only. Playwright
  exited on `unknown option` before starting a browser, 20 times. The tally read as a 100%
  failure rate, complete with 20 artifact directories — all empty.
- A verification script's `exit=%s` column printed `$?` from its own guard rather than from
  the test command, so passing runs reported `exit=1`.

Guards that follow from it, in every measurement harness:

- **A run with no test-count summary is a harness error, not a result.** Abort and say how
  many valid runs you had; do not let it count as a failure.
- **Read one artifact per measurement, never only the tally.** All three above were caught
  by opening a log or noticing a blank column, never by the summary line.
- **Suspect uniformity.** 20/20 identical failures is far more likely to be a broken
  harness than a 100% failure rate. The genuine result that followed was ragged —
  26.8 to 32.2 seconds across 20 passes.

### Spiking a browser behaviour: isolate it, do not test it through the app

G12 asked whether WebKit's service worker can intercept a same-origin worker script load,
which decides whether `src/map/MapShell.tsx`'s blob-URL workaround can go. Measured in a
standalone harness — a plain page, a plain service worker, a plain worker script on a local
static server — rather than through areamap, so the answer is about the browser and not
about this app's plumbing. The service worker logged every request it saw, which is what
separates *intercepted and served* from *served by the HTTP cache* from *never happened*:

| Condition | Worker | SW saw the request |
|---|---|---|
| WebKit, online | spawned | **yes** |
| WebKit, offline, same document | spawned | no — HTTP cache |
| **WebKit, network-blocked reload** | **failed** | **no** |
| Chromium, online and offline | spawned | yes |

The third row decides it, and the second is why the first two alone would have misled:
offline in an already-loaded document the worker still spawned, from the evictable HTTP
cache, with the service worker never involved. Only a reload — a fresh document that cannot
reuse what the previous one had — shows the request failing outright.

Two method notes worth reusing:

- **Log what the service worker saw.** Without it, "the worker spawned" cannot be
  distinguished from "the worker spawned *because of the service worker*", and those give
  opposite answers.
- **Use this repo's offline mechanism, not a third one.** `context.setOffline(true)` makes
  WebKit throw an internal error on the next navigation, which killed the first attempt at
  the deciding cell. `offline-map.spec.ts:111-123` already documents the working pattern:
  let the navigation through — the service worker answers it before the network — and
  hard-block everything else.

The finding that survives: WebKit now **does** intercept worker script loads online, so the
G5-era claim that it never does is no longer accurate as written. It buys nothing, because
the blob URL exists for the offline path and offline is exactly where interception still
does not happen. A premise can expire in a way that changes the sentence without changing
the decision — and someone who re-tests only the online half will conclude the workaround is
removable.

### Write the cell grid down before comparing anything

Before running a comparison, list the cells — every combination of the variable you care
about and the configuration you will run it in — and mark which you will actually fill.
It costs a minute and it catches the error below, which no amount of care does.

Two investigations here failed the same way within an hour, in opposite directions:

- A `preventScroll` fix was "bisected" to one line. Every run *with* the bug was a full
  parallel two-project run; every run *without* it was a single spec in isolation.
  Configuration and the variable moved together in all four comparisons, so the result
  showed nothing.
- A flakiness hypothesis compared 5 workers against 1. The source tree was also being
  edited between runs. Same shape, and it took a timestamp check prompted by somebody
  else's pushback to notice the comparison was not clean.

Neither was carelessness. In both cases the investigator ran the variable they were
interested in against whichever configuration was convenient, and the configuration
rode along unexamined precisely because it was not the thing under study. Each was caught
by the other person, which is not a control you can rely on.

The grid also makes a deliberately empty cell legible. Three filled cells and one
unfilled, with a stated reason, is a more honest artifact than four cells where one was
inferred — and "we could have run it and decided it would not change anything" is a
result worth recording rather than a gap to hide.

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

### The mobile project runs every spec, on purpose

The mobile project sets no `testMatch`, so it runs all of `tests/e2e/` — including
`desktop.spec.ts`. Mobile is 37 tests, not the 27 it began at: every spec, including the six
desktop ones and G13's additions. This began as an oversight and is kept deliberately, because the WebKit run of
`desktop.spec` is what caught the rating sheet's Tab-containment bug. Coverage that catches
real bugs by accident is worth keeping once you know about it.

The assertions stay meaningful in both projects rather than going vacuous: the 640px sheet
cap holds at 390px, and `tests/e2e/input.ts` dispatches on `hasTouch`, so each project
drives the same spec through its own input model.

### Measured: the mobile lane does fail under load

Ten full mobile runs at default parallelism with eight CPU burners on a ten-core machine
(load average 53, verified in the process table rather than assumed):

| Condition | Rate |
|---|---|
| Mobile, default workers, under load | **1 failed / 10 runs** |
| Mobile, default workers, quiet | 0 failed / 6 runs |

All five failures fell in one run, across five distinct tests — three brush, one desktop
Escape, one draw-precision — every one a 30 s timeout, with seven more never reaching the
runner. That is the load signature: it takes out whatever is executing, not a particular
test. The failing run was also the one whose webServer build competed with the burners.

So the mobile lane carries the same exposure as the desktop lane did, and `--workers=1`
does not apply to it. It is not capped here: a real 390x844 phone is single-user and the
lane is fast, so the cost of capping is paid on every run against a risk that only appears
when something else saturates the machine. The gate below makes it visible instead.

One thing left unexplained rather than theorised: runs 7-10 completed in 50-54 s against
1.1-1.6 m for runs 2-6, under nominally identical load. Thermal or scheduler behaviour is a
guess, and a guess in this file is worth less than the admission.

### CI fails a build when a test passes only on retry

`playwright.config.ts` sets `retries: 2` under CI, so without a check a flaky-then-passed
test is indistinguishable from a solid one in the build result. `ci.yml` tees each e2e
lane's output and a following step fails the build if either reports flaky tests.

This is deliberately not "set retries to 0". Both make the build red; this one says *which
kind* of red. A hard failure and a flaky pass look identical at `retries: 0`, and that
difference is the first thing anyone diagnosing it needs — the retry itself is evidence the
test can pass, which rules out a deterministic break. The measurement above is why the
distinction is worth keeping: the mobile lane has a real, low, load-dependent rate, and a
build that goes red without saying "this passed on the second try" sends someone hunting a
break that is not there.

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

The same applies in `ci.yml`, where it is now applied: the e2e gate is two steps, one per
project, and the desktop step carries `--workers=1`. A bare `npm run test:e2e` runs both
projects together — today 73 executions, 37 in the mobile lane plus 36 in the desktop one,
where 27 used to run — at default parallelism on a two-core runner, which is exactly the
configuration this section says does not work.

**That gap was recorded here and not applied, and CI failed on it twice.** Writing a
constraint down is not the same as enforcing it, and nothing gated the distance between the
two: no goal's `done_when` runs `ci.yml`, so a workflow can contradict a documented
invariant indefinitely without any gate noticing. Worth remembering when the next
convention lands in this file — ask what would fail if somebody ignored it, and if the
answer is nothing, say so where it is written.

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
