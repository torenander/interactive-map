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

- [ ] Add `scripts/assert-bundle-budget.mjs` (gzip budget + forbidden-marker scan)
- [ ] Add `tests/e2e/perf-load.spec.ts` with the two load-path assertions
- [ ] Replace `warmPmtilesCache` with per-range caching keyed on URL+Range (`src/sw.ts:86-124`)
- [ ] Gate any full-archive prefetch behind an explicit user action; default off
- [ ] Confirm `offline-map.spec.ts` still passes against the per-range cache
- [ ] `await import()` Terra Draw inside `map.on('load')` (`src/map/MapShell.tsx:14-15`, `:227`)
- [ ] `await import()` the Supabase client off the pre-map path (`src/db/client.ts`)
- [ ] Preload the worker from `index.html`; keep the resolved-URL guarantee (`MapShell.tsx:41-51`)
- [ ] Run all five `done_when` commands; record outputs

---

# Measured baselines (this worktree, local preview build)

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
