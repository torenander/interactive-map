# G10 — Open data overlays — task breakdown

**Goal:** Toggle read-only reference layers — TfL stops, OS Open Greenspace, DEFRA
road-noise bands — over the basemap from static build-time extracts on the app's own
origin. Exit criteria: `docs/OBJECTIVES.md` § G10.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G5, G9.

---

## Tasks

- [ ] Data-source decision recorded in `docs/ARCHITECTURE.md` beside the Protomaps entry: overlays take the basemap's posture. `scripts/fetch-overlays.sh` pulls each source at build time into static `.pmtiles` (or `.geojson` where small) under `public/overlays/`. Licences: TfL open data, OS Open Greenspace (OGL), DEFRA noise mapping (OGL) — all attribution-required.
- [ ] Overlay registry: id, label, source path, layer definitions, attribution, default off.
- [ ] Toggle sheet in the bottom third of the screen; choices persisted locally across reload.
- [ ] Ordering: overlays above the basemap, below area fills, points and lines — reference data never obscures annotations.
- [ ] Each enabled overlay's attribution renders beside the OpenStreetMap attribution, which stays in every state; `public/overlays/*` cached by the service worker on the basemap's cache-first strategy.
- [ ] `scripts/assert-overlays.mjs`: exits non-zero unless every registry entry resolves to a file present under `public/overlays/`, carries a non-empty attribution, and names no external host.
