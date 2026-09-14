# Session handoff — 2026-09-14 (sweep fixes shipped; session closed)

Written at the close of the team-lead session that finished the adversarial-sweep fix
work. Everything below is verified against production, not assumed. Nothing is
mid-flight; the open items are two recorded GitHub issues and nothing else.

## What shipped (all merged to main, deployed, live-verified)

- **PR #4** (`feat/sweep-fixes`, merged 2026-09-13): the offline-reload flush data-loss
  fix, the overlay-reachability fix, doc corrections, PostgREST accepted-risk note.
  - Flush root cause: after an offline reload, the IndexedDB queue read can land before
    the browser fires `online`; the doomed offline flush was in flight when the `online`
    request arrived, the in-flight guard dropped it, and nothing the trigger effect
    watches ever transitioned again. Fixed in `9215786` (mid-flush requests latch and
    coalesce into another pass; bounded 1s–30s retry ladder in `nextFlushRetry`) and
    test-hardened in `0a39c8d` (poll the server row, 120s ceiling). Gates: 16/16 and
    10/10 isolated loops, desktop 39/39, unit 102/102, independently re-run.
- **PR #5** (`test/move-precedence`, merged 2026-09-13): move-precedence coverage — all
  three G13 collisions pass (the app honours precedence; no bug found). Includes the
  WebKit sign-in closure note in TESTING.md (Tor verified real-iPhone Safari sign-in
  works; bundled-WebKit artifact, no repo fix).
- **PR #6** (`fix/overlay-base-path`, merged 2026-09-14): reference overlays 404'd in
  production because `overlays.ts` and `sw.ts` hardcoded root-relative `/overlays/*`
  paths, ignoring `VITE_BASE=/interactive-map/`. Both now use `import.meta.env.BASE_URL`
  (`9c0a0bc`); root-base output is byte-identical. Also caps the CI mobile e2e lane at
  `--workers=1` (`4e66bb3`) — three distinct marginal-test failures across two runs of an
  overlay-URL-only diff proved lane contention on the 2-core runner, same disease the
  desktop lane already fixed. **Live-verified**: overlay geojson 200s under the base
  path and the Green space polygons render in production with their OS attribution.

## Live production verification (2026-09-14, Playwright against the deployed site)

Verified working: map render at 390x844 and 1440x900; draw session lifecycle (start,
vertex, undo, cancel); Layers reachable mid-draw with count badge (the PR #4 fix, live);
overlay sheet + toggles; overlay data rendering (post-PR #6); dynamic overlay
attribution; OSM attribution; locate control. Not testable without credentials: the
signed-in write path — covered by the e2e suites and Tor's real-device test.

## Open items (recorded, not in flight)

- **Issue #8** — gray first paint after each deploy: for a few minutes post-deploy,
  Fastly serves mixed ETags across pmtiles range requests; pmtiles' FetchSource rejects
  the archive (one error per initial tile, basemap gray until interaction), and the
  service worker's per-range tile cache freezes the stale-ETag response so the failure
  persists for that profile after the CDN converges. Diagnosed live with full console
  capture; wiping the SW cache restores clean loads. Fix directions in the issue
  (purge-on-mismatch, deploy-versioned tile filename, or refetch-on-mismatch). This is
  pre-existing, not introduced by PR #6.
- **Issue #7** — closed. The mobile-lane flakiness it described was systemic contention,
  resolved by the `--workers=1` cap in PR #6.

## Environment / conventions (unchanged, still true)

- e2e lock: `bash scripts/e2e-lock.sh {acquire|release|status}` — required for anything
  that drives a browser, serves the app, or writes `dist/`; detects stale holders.
- e2e needs `VITE_TILES_URL=/tiles/london-z14.pmtiles` and `npm run build` first; both
  CI lanes now run `--workers=1` (desktop per G11 amendment, mobile per PR #6).
- Edge functions mount from the directory the Supabase CLI started in.
- This sandbox has a known-pre-existing local failure set (map-shell attribution /
  tile-decode timeouts) that reproduces identically at origin/main — control against a
  throwaway worktree before blaming a diff.
