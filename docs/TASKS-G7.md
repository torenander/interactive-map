# G7 — Load performance — task breakdown

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

- [ ] `await import()` Terra Draw inside `map.on('load')` (`src/map/MapShell.tsx:14-15`)
- [ ] `await import()` the Supabase client off the pre-map path — three MapShell
      touchpoints: `:13` (`FunctionsFetchError`), `:19` (`db/client`), plus `App.tsx`,
      `auth/SignIn.tsx` and `auth/useSession.ts`
- [ ] Wire MapShell to the preloaded worker URL, keeping the guarantee that the map is
      never created against an unresolved worker URL (`MapShell.tsx:41-51`)
- [ ] Run all five `done_when` commands; record outputs

---

# Stage 1 results (measured, real `playwright.config.ts`)

| Gate | Result | Exit |
|---|---|---|
| `node scripts/assert-bundle-budget.mjs` | 449,088 B gzip, both markers present | **1 — expected red** |
| `perf-load.spec.ts` | cache assertion green; worker fetched twice | **1 — expected red** |
| `offline-map.spec.ts` | passes (1.3 s) | 0 |
| `offline.spec.ts` | passes (3.2 s) | 0 |

Both reds are stage 2 work, recorded rather than designed around: the thresholds are
untouched. The budget is red because Terra Draw and Supabase are still statically
imported by `MapShell.tsx`; `perf-load` is red because the injected preload is not yet
reused by MapShell's `fetch()` (two worker resource entries, 50 ms and 84 ms).

The tile-caching half of `perf-load` is green: **pmtiles-v1 holds 544,046 B across 5
entries after painting one viewport, against 55,891,073 B before** — the same paint for
1/103rd of the bytes, and nothing thrown away when a visit ends early.

The budget baseline moved from 440,217 B to 449,088 B during stage 1 because G6 added
snapping and `TerraDrawSelectMode` to the same critical-path chunk. The 380,000 B target
is unchanged and still reachable — it assumes both dependencies leave the critical path.

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
