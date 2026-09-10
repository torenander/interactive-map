# Handoff — areamap

Written 2026-09-10 at the end of the build-out session. Audience: the next session
(human or agent) picking this project up. Everything below is verified, not assumed;
where something was still in flight at handoff time it says so explicitly.

## What this is

Personal map-annotation PWA for rating London neighbourhoods during a property search.
Draw a polygon, rate it -1/0/+1, comment, save; works offline; installable on a phone.
Spec: `SPEC.md`. Invariants: `CLAUDE.md`. Decisions and their reasons: `docs/ARCHITECTURE.md`.

## State at handoff

**All five goals in `docs/OBJECTIVES.md` are done** (G1 map shell, G2 schema+client,
G3 MVP loop, G4 offline writes, G5 installable PWA), each closed only after its
`done_when` commands exited 0, run independently of the implementer. Full log with
dates and deviations: `docs/TASKS.md`; per-goal breakdowns in `docs/TASKS-G*.md`.

**A six-agent verification sweep then attacked the finished app** (gate re-run,
fresh-clone reproducibility, adversarial security probe, test-honesty audit,
touch-only field simulation, docs-vs-reality). It produced 16 findings; all 16 are
fixed and re-verified — including three real `save-area` concurrency/atomicity bugs,
a ghost-click race that dismissed the rating modal on touch devices, and a broken
advertised test command. Fix logs: `docs/TASKS-FIX*.md`. Ledger summary at the bottom
of `docs/TASKS.md`.

**CI**: `.github/workflows/ci.yml` runs every gate (db reset, types diff, build, unit,
five e2e suites, PWA probe) on push and PR. Green on main. Tiles and Playwright
binaries are cached; the tile cache key is derived from the bbox/maxzoom constants only.

## Production (in flight at handoff)

- **Supabase hosted**: project `areamap`, ref `hqjrrkoaccgbueinuvjv`, region eu-west-2,
  free tier. Migrations 0001–0007 pushed, `save-area` edge function deployed, email
  auth on with confirm-email off (set via Management API). DB password:
  `~/.areamap-db-password` on Tor's machine (chmod 600), nowhere else.
- **App shell**: GitHub Pages at `https://torenander.github.io/interactive-map/`
  via a one-shot `gh-pages` branch deploy. **In flight**: the deploy agent was mid-run
  at handoff — stage 1 is inner-London z15 tiles on Supabase Storage (free-tier 50 MiB
  cap forces the smaller extract), stage 2 swaps to full Greater-London z14 tiles
  committed in-repo (56 MB, same-origin, no third party). Live smoke tests (webkit,
  390x844, real touch draw + save round-trip) gate each stage. If the URL above serves
  the app, at least stage 1 completed.
- **CD**: `.github/workflows/deploy.yml` on branch `cd`, built and proven
  (guard-fails-loudly run on record), deliberately NOT merged. To activate once the
  one-shot deploy is done and the tiles URL is final:
  1. `gh variable set VITE_TILES_URL --body '<final tiles URL>'`
  2. merge `cd` into main, push
  3. switch Pages source: `gh api -X PUT repos/torenander/interactive-map/pages --input - <<< '{"build_type":"workflow"}'`
  Repo variables `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are already set (anon
  key is public by design; service_role is never stored anywhere client-side).
- **Runbook**: `docs/DEPLOY.md` — numbered, executed once, corrected where reality
  diverged. Its Production section gets the final URLs when the deploy agent finishes.

## Decisions a newcomer must not re-litigate blind

1. **Cell derivation is an edge function, not a Postgres trigger.** h3-pg does not
   exist in any Supabase image, hosted or local (verified; upstream requests open
   since 2022). `save_area_tx` (migration 0005/0007) is the sole writer — SECURITY
   DEFINER with explicit auth/ownership checks, direct client writes revoked at the
   database. `docs/ARCHITECTURE.md` § Cell derivation, superseded note.
2. **G5's Lighthouse check was amended** (dated note in `docs/OBJECTIVES.md`):
   Lighthouse v12+ has no PWA category; `scripts/assert-pwa.mjs` is a stricter direct
   probe.
3. **Tile hosting**: Supabase free tier caps files at 50 MiB (hard, 402 on the config
   PATCH). GitHub Release assets send no CORS. Cloudflare R2 was rejected by Tor —
   no uncapped-billing services in this project. Final architecture: z14 extract
   in-repo, same-origin. Backblaze B2 (no card required, 10 GB free) is the documented
   upgrade if full z15 is ever wanted.
4. **No geometry union, `dimension` stays `'overall'`, mobile 390x844 first** — all
   still binding, see `CLAUDE.md`.

## Gotchas that cost real time this session

- **Local edge runtime serves stale function code** after edits (`--policy=per_worker`).
  `npx supabase stop && npx supabase start` is the reliable recycle. In CLAUDE.md now.
- **Vite 8/rolldown does not emit MapLibre's worker chunk**; the `?worker&url` +
  `setWorkerUrl` workaround in `src/map/MapShell.tsx` is load-bearing. Four DOM tests
  passed against a blank map before it — hence the `vector tiles decode and paint`
  test.
- **Green can lie**: a stale preview server on 4173 once turned a failing test green
  (`reuseExistingServer: false` now), and `queryRenderedFeatures` reports one feature
  per internal tile (dedupe via `promoteId`).
- Agent worktrees under `.claude/worktrees/` used to contaminate bare vitest globs;
  `vitest.config.ts` pins `tests/unit/**`.

## Open items (all optional, none blocking)

- Deploy agent's final report + phone ping to Tor (in flight, see above).
- CD activation (three commands above) after the tiles URL is final.
- Commit authorship is `tor.enander@redeploy.com` on a now-public repo; Tor declined
  a rewrite so far — re-offer before the repo is shared widely.
- Next feature milestones live in `docs/OBJECTIVES.md` § Not goals (brush painting,
  open-data overlays, points/lines) — each needs a new goal block before any code.
- The interim Supabase Storage tile object can be deleted once stage 2 is live.

## How to run it

Fresh clone: `README.md` § Kom igång (verified by a clean-worktree agent). Tests:
`docs/TESTING.md`. All gates in one line: push and let CI run, or execute the
`done_when` blocks in `docs/OBJECTIVES.md` top to bottom.
