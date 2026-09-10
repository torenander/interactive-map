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
- **App shell**: GitHub Pages at `https://torenander.github.io/interactive-map/` —
  LIVE and verified (3x webkit render probes, full touch smoke suite). Tiles: full
  Greater London at z14, committed in-repo as `public/tiles/london-z14.pmtiles`
  (55.9 MB, same-origin — the interim Supabase Storage tiles and the whole cross-origin
  CORS surface are gone; the interim storage object is deleted).
- **CD**: ACTIVE. `.github/workflows/deploy.yml` on main; Pages source is
  "GitHub Actions"; every push to main (except docs/*.md-only) builds with repo
  variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_TILES_URL=/interactive-map/tiles/london-z14.pmtiles`) and deploys. `ci.yml`
  runs the full gate suite on the same push and is the authoritative quality signal.
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

- Tor's login exists on the hosted instance (credentials in `~/.areamap-login`,
  chmod 600; the password also appears once in the build session's transcript — rotate
  via the Supabase dashboard or admin API if that matters).
- Commit authorship is `tor.enander@redeploy.com` on a now-public repo; Tor declined
  a rewrite so far — re-offer before the repo is shared widely.
- Next feature milestones live in `docs/OBJECTIVES.md` § Not goals (brush painting,
  open-data overlays, points/lines) — each needs a new goal block before any code.

## How to run it

Fresh clone: `README.md` § Kom igång (verified by a clean-worktree agent). Tests:
`docs/TESTING.md`. All gates in one line: push and let CI run, or execute the
`done_when` blocks in `docs/OBJECTIVES.md` top to bottom.
