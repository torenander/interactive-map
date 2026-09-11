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
preview server was killed, touch-draw's `locator.tap` on a 30 s timeout — and never the
original three. So there are no three flaky tests to fix; there is one machine that
produces non-deterministic failures wherever the timing happens to land when two things
run at once. The fix is the lock, not the tests, and no assertion or threshold was changed.

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
