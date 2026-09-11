# G10 — Open data overlays — task breakdown

**Goal:** Toggle read-only reference layers — TfL stops, OS Open Greenspace, DEFRA
road-noise bands — over the basemap from static build-time extracts on the app's own
origin. Exit criteria: `docs/OBJECTIVES.md` § G10.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G5, G9.

---

## Tasks

**Boxes set to `[x]` on 2026-09-11 on the team lead's instruction**, after the lead
independently re-ran the full G10 `done_when`: `npm run build`, `assert-overlays.mjs`
(three overlays present and attributed), the 14 unit tests, `overlays.spec.ts` 4/4, and
the three-host grep probe. Recorded the same way G8's file records it: `docs/TASKS.md`
describes `[x]` as reviewed, the review of record here is the lead's, and no human has
read this code yet.

- [x] Data-source decision recorded in `docs/ARCHITECTURE.md` beside the Protomaps entry: overlays take the basemap's posture. `scripts/fetch-overlays.sh` pulls each source at build time into static `.pmtiles` (or `.geojson` where small) under `public/overlays/`. Licences: TfL open data, OS Open Greenspace (OGL), DEFRA noise mapping (OGL) — all attribution-required.
      All three landed as `.geojson`; none needed `.pmtiles`, and neither tippecanoe nor
      GDAL is available here to build one. Sources, licences, filters and the measured
      sizes behind each filter are in `docs/ARCHITECTURE.md` § Open-data overlays.
- [x] Overlay registry: id, label, source path, layer definitions, attribution, default off.
      `src/map/overlays.ts`. MapShell knows nothing about any particular overlay, so a
      fourth is an entry plus a fetch step.
- [x] Toggle sheet in the bottom third of the screen; choices persisted locally across reload.
      "Layers" button beside Draw/Paint, 44px targets, `aria-pressed` per row.
      localStorage rather than IndexedDB, read during the first render so the map is not
      built with the wrong layers and corrected a tick later.
- [x] Ordering: overlays above the basemap, below area fills, points and lines — reference data never obscures annotations.
      `OVERLAY_INSERT_BEFORE` in `src/map/layers.ts`, one exported constant both MapShell
      and the registry read. The unit suite asserts the anchor is the first annotation
      layer; `overlays.spec.ts` asserts the live draw order.
- [x] Each enabled overlay's attribution renders beside the OpenStreetMap attribution, which stays in every state; `public/overlays/*` cached by the service worker on the basemap's cache-first strategy.
      Attribution is carried on the GeoJSON source, so MapLibre's own control renders and
      removes it with the overlay — one mechanism, not a second widget that could
      disagree with what is drawn. `src/sw.ts` serves `/overlays/*` CacheFirst;
      deliberately not precached (three files, all off by default).
- [x] `scripts/assert-overlays.mjs`: exits non-zero unless every registry entry resolves to a file present under `public/overlays/`, carries a non-empty attribution, and names no external host.
      Plus a 12 MB per-file budget for an on-demand overlay, and a check that the file is
      not empty — which is what caught the broken paging below.

---

## Decision: which sources, and what got filtered out

The three named sources are all reachable without a key, but not in the same shape:

- **TfL** — Unified API JSON, WGS84, no key. Straight conversion.
- **OS Open Greenspace** — only offered as Shapefile or GML, in British National Grid, by
  100 km grid square. London is square TQ (5.2 MB zipped).
- **DEFRA road noise** — whole-England bulk download, or an OGC API - Features endpoint
  that takes a bbox and a CQL2 filter and returns WGS84 GeoJSON in pages. The endpoint,
  so the extract is London-only from the start.

The OS data therefore needs a shapefile reader and a datum transform, and neither belongs
in `package.json` — they are build tooling, not app code, and the app would ship them to
nobody. `scripts/fetch-overlays.sh` installs `proj4` and `shapefile` into a temporary
directory and points `NODE_PATH` at it for the length of the run. The transform itself is
proj4's standard EPSG:27700 definition rather than hand-rolled geodesy; spot-checked
before use (Greenwich Observatory, BNG 538850/177320, comes out at 51.47781, -0.00198).

Filters, with the measurements behind them, are in `docs/ARCHITECTURE.md`. The one that
shows in the UI is the noise threshold: the label reads "Road noise, 70 dB+" because only
the two loudest of six Lden bands are in the file, and a bare "Road noise" would imply an
unshaded street had been measured as quiet.

## Defect found while building this: silent `offset` paging

The DEFRA endpoint ignores `offset` without complaint — `offset=0` and `offset=5` return
the identical five features — and pages on `startIndex`, which it advertises in each
response's `next` link. The first implementation looped on `offset` and re-read page one
forever: it had pulled 582,000 "features" from a 14,242-feature band before it was
killed. `scripts/overlays/road-noise.cjs` now follows the `next` link, refuses to revisit
a URL it has already read, and checks the rows it actually read against the server's own
`numberMatched` for each band — so a paging regression fails the fetch instead of
producing a plausible-looking partial file.

## Known limit: MapLibre's blob worker offline

With the network hard-blocked, MapLibre logs "Importing a module script failed" /
"due to access control checks" while starting a worker from the blob URL
`src/map/MapShell.tsx` hands it (G5 chose a blob to work around WebKit not intercepting
worker *script* requests). A GeoJSON overlay source is the first thing in this app that
asks for more than one worker, which is why it surfaces here and not in
`offline-map.spec.ts`. MapLibre recovers: the overlay paints from cache, with its
attribution. `overlays.spec.ts` tolerates exactly those two messages and fails on any
other page error, so the noise is recorded rather than hidden. Fixing it properly means
serving the worker from a real same-origin URL — a G5/G7-shaped change, not this goal.

---

## Verification — watched runs

The full G10 `done_when` from `docs/OBJECTIVES.md`, in order, with no
`VITE_TILES_URL` override (committed defaults):

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `node scripts/assert-overlays.mjs` | exit 0 — 3 overlays, 0.08 / 3.23 / 3.98 MB |
| `npm run test -- tests/unit/overlays.test.ts` | exit 0, **14 passed** |
| `npm run test:e2e -- tests/e2e/overlays.spec.ts` | exit 0, **4 passed** (390x844) |
| `! grep -rniE "tfl\.gov\.uk\|api\.os\.uk\|environment\.data\.gov\.uk" src ...` | exit 0 |

Regression, because `MapShell.tsx` and `src/sw.ts` are shared:

| Command | Result |
|---|---|
| `npm run test` (whole unit suite) | exit 0, **88 passed** across 8 files |
| `npm run test:e2e` (whole e2e suite) | exit 0, **26 passed** |
| `npx tsc --noEmit -p tsconfig.app.json` / `-p tsconfig.sw.json` | exit 0 |

E2E runs held the canonical scratchpad `e2e-lock` and ran on committed defaults.
