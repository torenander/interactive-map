# G7 — Load performance — done 2026-09-11

**Goal:** First map paint is not gated on work the map does not need — per-range tile
caching, Terra Draw and the Supabase client loaded after the map exists, and the MapLibre
worker fetched in parallel with the app shell. Offline capability unchanged. Exit
criteria: `docs/OBJECTIVES.md` § G7.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G5.

---

## Tasks

Split into two stages so that G6 and G7 are not editing `src/map/MapShell.tsx`
at the same time. Stage 2 starts once G6's MapShell work is committed.

### Stage 1 — no MapShell edits

- [x] Add `scripts/assert-bundle-budget.mjs` (gzip budget + forbidden-marker scan)
- [x] Add `tests/e2e/perf-load.spec.ts` with the two load-path assertions
- [x] Replace `warmPmtilesCache` with per-range caching keyed on URL+Range (`src/sw.ts`)
- [x] Gate any full-archive prefetch behind an explicit user action; default off
- [x] Confirm `offline-map.spec.ts` still passes against the per-range cache
- [~] Announce the worker from the document head (`vite.config.ts` plugin) — the link
      is injected, but MapShell's own `fetch()` does not reuse it yet, so the worker is
      fetched twice. Consuming it is stage 2.

### Stage 2 — all MapShell edits, after G6 commits

- [x] `await import()` Terra Draw inside `map.on('load')`
- [x] `await import()` the Supabase client off the pre-map path — `db/client.ts` creates
      the client lazily; `FunctionsFetchError` is replaced by a local `OfflineWriteError`
      so the queue-vs-fail distinction no longer needs the vendor module
- [x] Start the worker fetch from the document head and have MapShell await it, keeping
      the guarantee that the map is never created against an unresolved worker URL
- [x] Run all five `done_when` commands; record outputs

---

# Final results — every `done_when` command exit 0

Run against the real `playwright.config.ts` on 2026-09-11, after G6 closed.

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node scripts/assert-bundle-budget.mjs` | **364,234 B gzip**, budget 380,000 — PASS |
| `npm run test:e2e -- tests/e2e/perf-load.spec.ts` | 1 passed (7.2 s) |
| `npm run test:e2e -- tests/e2e/offline-map.spec.ts` | 1 passed (2.1 s) |
| `npm run test:e2e -- tests/e2e/offline.spec.ts` | 1 passed (3.4 s) |

G6's suites re-run as regression gates, since deferring Terra Draw moves when drawing
initialises: `draw-precision.spec.ts` 3 passed, `touch-draw.spec.ts` 1 passed,
`mvp-loop.spec.ts` 1 passed. `npm run test` 28 passed.

## What moved

| | Before | After |
|---|---|---|
| Critical-path JS | 449,088 B gzip | **364,234 B** |
| Tile bytes cached to paint one viewport | 55,891,073 B | **544,046 B** (5 entries) |
| MapLibre worker fetches | 2 (or 1, late) | **1**, starting at 42 ms vs entry end 46 ms |
| First tile range request | 1,820 ms (deployed, throttled) | 129 ms (local preview) |

## Two gate corrections made along the way

Both strengthened the gates; neither moved a threshold.

1. `perf-load`'s original assertion counted `.pmtiles` requests without a `Range` header.
   It passed against the unfixed code: WebKit — the only Playwright project here — does
   not surface service-worker-originated requests to `page.on('request')`. Replaced with
   a cached-byte count, which failed honestly at 55,891,073 B.
2. The bundle budget's `TerraDraw` marker tested for a name any caller can write, and
   destructuring the dynamic import left those names in the entry chunk. Replaced with an
   internal error string. Verified against a build with terra-draw forced back onto the
   critical path: exit 1, 407,759 B.

## Still open, deliberately

`docs/TASKS.md` still files G7 under "G6–G10 — planned, not started". That section covers
four goals owned by three teammates, so rolling up its status is a single shared edit for
the lead rather than something to race here.

# Stage 1 baselines (measured, superseded by the table above)

# Measured baselines (pre-G7, local preview build)

| Check | Today | Exit |
|---|---|---|
| `assert-bundle-budget.mjs` | 440,217 B gzip, both markers present | **1** |
| `perf-load.spec.ts` | 1 no-Range `.pmtiles` request; worker starts 53 ms vs entry end 31 ms | **1** |
| `offline-map.spec.ts` | passes (2.6 s) | 0 |
| `offline.spec.ts` | passes (3.8 s) | 0 |

Both new gates fail today. The 380,000 B budget is measured, not guessed: a real
`manualChunks` split gives maplibre 275,740 + react 67,517 + app 19,673 = **362,930 B**
once Terra Draw (23,946) and Supabase (54,627) are dynamically imported. Static
`manualChunks` alone still totals 441,503 B and fails — the budget forces real deferral.

Notes for the implementer: Vite 8/rolldown rejects object-form `manualChunks`
("manualChunks is not a function") — use the function form. The offline suites need
`VITE_TILES_URL=/tiles/london-z14.pmtiles`; the default `london.pmtiles` path expects the
untracked maxzoom-15 dev archive and times out without it.
