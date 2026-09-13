# Objectives

One goal per block, ordered. Each `done_when` entry is a command that must exit 0. A goal is done when every entry passes, and not before.

## How to work from this file

1. Pick the first goal whose `blocked_by` is satisfied and which is not marked done.
2. Break it into tasks. Write them into `docs/TASKS.md` under a heading for that goal, as unchecked boxes, before writing any code.
3. Implement one task at a time. Tick its box the moment it is genuinely finished, not at the end of the goal.
4. When all tasks are ticked, run every `done_when` command. If any fails, add tasks and continue.
5. Only when all `done_when` commands exit 0, mark the goal done in `docs/TASKS.md` with the date.

## Rules

- Do not mark a goal complete on your own judgement. Run the commands.
- Do not weaken, skip or rewrite a `done_when` check to make it pass. If a check is wrong, stop and say so.
- Do not build anything under `out_of_scope`. Out of scope means the code does not exist, not that it is hidden behind a flag.
- If `blocked_by` is unmet, stop.
- Never tick a box for work you have not verified running.

---

## G1 — Map shell

**objective**
Render a MapLibre map of London from a self-hosted Protomaps `.pmtiles` file, with a working "centre on me" control. No drawing, no database.

**done_when**
```
npm run build
npm run test:e2e -- tests/e2e/map-shell.spec.ts
```
`map-shell.spec.ts` asserts: the canvas renders, the initial viewport is within Greater London, OSM attribution is present in the DOM, and clicking the geolocate control fires a `geolocate` event with a mocked position.

**out_of_scope**
Drawing, Supabase, auth, offline caching.

**blocked_by**
`public/tiles/london.pmtiles` present locally.

---

## G2 — Schema and client

**objective**
Migrations 0001–0004 from `docs/DATA-MODEL.md` applied, types generated, typed Supabase client with email auth.

**done_when**
```
npx supabase db reset
npx supabase gen types typescript --local | diff - src/db/types.ts
npm run test -- tests/unit/schema.test.ts
```
`schema.test.ts` asserts against a local database: inserting an area populates `area_cells` with at least one row; `rating = 3` is rejected; updating `geom` replaces the cell set rather than appending to it; deleting an area cascades to its cells; a second user's `select` on another user's area returns zero rows.

**out_of_scope**
Any UI. Points, lines, extra dimensions.

**blocked_by**
None.

---

## G3 — MVP loop

**objective**
Draw a polygon, rate it, comment on it, save it, see it on reload, edit it, delete it.

**done_when**
```
npm run build
npm run test -- tests/unit/
npm run test:e2e -- tests/e2e/mvp-loop.spec.ts
```
`mvp-loop.spec.ts` runs at 390x844 and asserts the full round trip: draw a polygon, the rating modal appears, submit with a comment, the polygon renders with fill, reload the page and it is still there, open it and change the rating, reload and the new rating persists, delete it, reload and it is gone.

**out_of_scope**
Offline. Brush painting. Points and lines. Multiple dimensions. Sharing.

**blocked_by**
G1, G2.

---

## G4 — Offline writes

**objective**
A save made with no connectivity is queued locally and flushed on reconnect. Nothing is lost and nothing is reported as saved before the server has it.

**done_when**
```
npm run test -- tests/unit/queue.test.ts
npm run test:e2e -- tests/e2e/offline.spec.ts
```
`queue.test.ts` asserts: a queued entry survives a page reload; flushing the same entry twice produces one row, not two; a failed flush leaves the entry in the queue.
`offline.spec.ts` asserts: with the network blocked, drawing and saving shows queued state and not success; on restoring the network the area appears in the database exactly once.

**out_of_scope**
Merge or conflict resolution beyond last-write-wins on `updated_at`.

**blocked_by**
G3.

---

## G5 — Installable PWA with offline basemap

**objective**
Installable on iOS and Android, London tiles served from cache, map usable with no connectivity.

**done_when**
```
npm run build
node scripts/assert-pwa.mjs
npm run test:e2e -- tests/e2e/offline-map.spec.ts
```
> **Check amended 2026-09-10 (lead):** the original command piped
> `npx lighthouse --only-categories=pwa` into `assert-pwa.mjs`, but Lighthouse removed
> the PWA category in v12 (current is 13.4.1: accessibility, best-practices,
> performance, seo, agentic-browsing) — the command cannot execute at all, on any
> machine. Not weakened to pass: replaced with a direct probe that is stricter than
> the old audit. `assert-pwa.mjs` must launch the built app itself (preview on 4173),
> and exit non-zero unless: the manifest link resolves and contains name, start_url,
> display standalone/fullscreen, and icons at 192 and 512; a service worker controls
> the page after first load; and a reload with the network blocked still serves the
> app shell. The old Lighthouse audit never verified actual offline behaviour; this
> does.
`offline-map.spec.ts` asserts the map renders tiles with the network blocked after one warm load.

**out_of_scope**
App store distribution. Push notifications.

**blocked_by**
G3.

---

## G6 — Drawing precision

**objective**
A polygon can be drawn accurately with one thumb at 390x844: every placed vertex is
visible, any vertex can be dragged to correct it before or after saving, the ring is
closed by an explicit control rather than by re-tapping the first vertex, and vertices
snap to the borders of existing areas. Geometry edits reach the server through
`save-area` so `area_cells` is rebuilt from the new geometry.

**done_when**
```
npm run build
npm run test
npm run test:e2e -- tests/e2e/draw-precision.spec.ts
npm run test:e2e -- tests/e2e/touch-draw.spec.ts
npm run test:e2e -- tests/e2e/mvp-loop.spec.ts
grep -q "showCoordinatePoints: true" src/map/MapShell.tsx
grep -q "editable: true" src/map/MapShell.tsx
grep -q "snapping:" src/map/MapShell.tsx
! grep -q "context.action !== 'draw'" src/map/MapShell.tsx
! grep -riq "crosshair" src/
```
`draw-precision.spec.ts` runs at 390x844 (the only Playwright project) and asserts:
a coordinate-point marker renders for **every** placed vertex, not just the two
`closingPoint` markers today's defaults produce; dragging a placed vertex moves the
corresponding polygon coordinate; the ring closes via a `finish-area` control without
tapping the first vertex, and the saved ring equals the tapped vertices; dragging a
vertex of an already-saved area, saving, and reloading persists the new geometry **and**
leaves `area_cells` rebuilt to match it (queried with the service-role key, as
`touch-draw.spec.ts` does); and a vertex dropped near an existing area's border stores a
coordinate exactly equal to that border's coordinate.
`touch-draw.spec.ts` and `mvp-loop.spec.ts` must stay green unchanged — `editable: true`
adds canvas drag handling, which is exactly where the WebKit ghost-click race lives.

**out_of_scope**
Crosshair / centre-reticle placement mode — a separate input model, worth its own goal
once draggable vertices show whether occlusion is still the binding constraint.
Higher-zoom (z15+) basemap tiles. Geometry union, clipping or self-intersection repair.
Points, lines, brush painting.

**blocked_by**
G3, G4.

---

## G7 — Load performance

**objective**
First map paint is not gated on work the map does not need: tiles are cached per range rather than by downloading the whole archive, Terra Draw and the Supabase client load after the map exists, and the MapLibre worker is fetched in parallel with the app shell instead of behind it. Offline capability is unchanged.

**done_when**
```
npm run build
node scripts/assert-bundle-budget.mjs
npm run test:e2e -- tests/e2e/perf-load.spec.ts
npm run test:e2e -- tests/e2e/offline-map.spec.ts
npm run test:e2e -- tests/e2e/offline.spec.ts
```
`assert-bundle-budget.mjs` sums gzip sizes of the entry chunk plus every `modulepreload`ed chunk in `dist/index.html` and exits non-zero if that total exceeds 380,000 B, or if any of those chunks contains the string `TerraDraw` or `GoTrueClient`. Dynamically imported chunks are excluded — that is the point.
`perf-load.spec.ts` runs at 390x844 and asserts, on a reload with the service worker already controlling: zero `.pmtiles` requests are issued without a `Range` header, and the `maplibre-gl-worker` resource starts no later than the entry chunk's `responseEnd`.
`offline-map.spec.ts` and `offline.spec.ts` are unchanged regression gates: offline capability is a shipped invariant, not a thing to renegotiate.

**out_of_scope**
Cross-origin glyph/sprite hosting. `cache-control` headers. `runFlush`'s refetch-all and `refreshSource`'s whole-collection `setData`. `save-area` latency. Tile content, bbox or maxzoom. Removing the worker-URL workaround — "the map is never created against an unresolved worker URL" must still hold.

**blocked_by**
G5.

---

## G8 — Brush painting of H3 cells

**objective**
Paint an area by dragging a finger: touched res-10 H3 cells accumulate, the selection becomes one polygon on release, and that polygon saves through `save-area` like a drawn one. Erase mode removes cells. One area per session.

**done_when**
```
npm run build
npm run test -- tests/unit/brush.test.ts
npm run test:e2e -- tests/e2e/brush.spec.ts
! grep -rn 'from("area_cells")' src --include="*.ts" --include="*.tsx"
```
`brush.test.ts` asserts, against the selection module with no map: a three-position stroke yields all three cells; a cell added twice appears once; erase removes only cells under the erase stroke; a one-cell selection converts to a single-ring polygon; two disconnected clusters are rejected rather than yielding two rings; undo restores the exact pre-stroke set; past 5,000 cells is refused.
`brush.spec.ts` runs at 390x844 and asserts: a touch drag paints visible cells; the rating modal appears on release; submitting writes one `areas` row with a non-zero `area_cells` count; reload shows it as a polygon fill; the in-progress selection is not rendered as a saved area before submit.
The grep probe holds the invariant that the client never writes `area_cells`; the brush derives cells for display only.

**out_of_scope**
More than one area per session. Brush-editing a saved area. Resolutions other than 10. Cell-level ratings. Geometry union or repair. Any change to the `save-area` contract.

**blocked_by**
G3, G6.

---

## G9 — Point and line features

**objective**
Drop a point and draw a line, each with a rating and comment, persisted in their own table behind their own single write path, rendered on the same map. `areas` is untouched.

**done_when**
```
npx supabase db reset
npx supabase gen types typescript --local | diff - src/db/types.ts
npm run build
npm run test -- tests/unit/save-feature.test.ts tests/unit/schema.test.ts
npm run test:e2e -- tests/e2e/points-lines.spec.ts
```
`save-feature.test.ts` asserts: a point payload with `kind: 'line'` is rejected; `rating = 3` is rejected; a 2,001-char comment returns 422; the same uuid posted twice yields one row; another user's id returns the generic 404; a direct client `insert` into `map_features` is refused by the database.
`schema.test.ts` gains: deleting a user cascades to their features; a second user's `select` on another user's feature returns zero rows; no `map_features` row has `dimension <> 'overall'`.
`points-lines.spec.ts` runs at 390x844 and asserts the round trip for both kinds — place/draw, rate, comment, save, reload, edit rating, reload, delete, reload and gone — and that a point inside an existing area is still tappable.

**out_of_scope**
H3 indexing of points or lines. Brush interaction with features. Snapping, routing, line simplification. Merging into `areas`. Multi-part geometries.

**blocked_by**
G3, G4, G6.

---

## G10 — Open data overlays

**objective**
Toggle read-only reference layers — TfL stops, OS Open Greenspace, DEFRA road-noise bands — over the basemap from static build-time extracts on the app's own origin. No runtime third-party requests, nothing keyed or metered in the path, and overlays work offline once cached.

**done_when**
```
npm run build
node scripts/assert-overlays.mjs
npm run test -- tests/unit/overlays.test.ts
npm run test:e2e -- tests/e2e/overlays.spec.ts
! grep -rniE "tfl\.gov\.uk|api\.os\.uk|environment\.data\.gov\.uk" src --include="*.ts" --include="*.tsx"
```
`overlays.test.ts` asserts: default state is all-off; toggle state survives reload; every entry has an attribution; ordering puts overlays below area, point and line layers.
`overlays.spec.ts` runs at 390x844 and asserts: enabling an overlay renders its features and adds its attribution to the DOM; disabling removes both; OSM attribution is present in every state; with the network blocked after one warm load an enabled overlay still renders; no request leaves the app's origin while toggling.
The grep probe holds that no third-party data host appears in application source.

**out_of_scope**
Joining overlay data to `area_cells` or to ratings. Overlay-derived scoring or suggestions. Live or scheduled refresh (the fetch script is run by hand, like the basemap extract). Any keyed, metered or uncapped-billing service in the runtime path. User-supplied overlay files.

**blocked_by**
G5, G9.

---

## G11 — Desktop

**objective**
The app is usable with a mouse and keyboard at 1440x900: no unrecoverable state, no
surface stretched across the window, and hover tells you what is clickable. Mobile stays
the primary target — every existing 390x844 gate keeps passing unchanged, and the desktop
work is additive rather than a breakpoint fork.

**done_when**
```
npm run build
npm run test
npm run test:e2e -- --project=mobile
npm run test:e2e -- --project=desktop --workers=1
grep -q "dragRotate.disable()" src/map/MapShell.tsx
grep -q "touchPitch.disable()" src/map/MapShell.tsx
grep -q 'data-testid="cancel-drawing"' src/map/MapShell.tsx
grep -q "Escape" src/areas/RatingModal.tsx
! grep -q "844 \* (2 / 3)" tests/e2e/map-shell.spec.ts
```
`--project=mobile` is the whole suite at 390x844, green with no edits to its assertions —
the "mobile first, not mobile only" check. It runs *every* spec in `tests/e2e/`, including
`desktop.spec.ts`, because the mobile project sets no `testMatch`: 37 tests today, where
the pre-G11 suite was 27 and G11 itself brought it to 33. That started as an oversight and is kept deliberately — the WebKit
run of `desktop.spec.ts` caught a focus bug the desktop run did not, and accidental
coverage that catches real bugs gets promoted rather than scoped away. The assertions stay
meaningful in both projects rather than vacuous in one: the 640 px sheet cap holds at
390 px, and `tests/e2e/input.ts` dispatches on `hasTouch` so each project exercises its own
input model. Config comment in `playwright.config.ts`, convention in `docs/TESTING.md`.
> **Check amended 2026-09-11 (perf-probe, lead-approved):** the desktop command carries
> `--workers=1` explicitly. Measured on the development machine: at 5 workers a full
> desktop run went 32/32 and then failed 3; at 2 workers, 32/32 then 2 failed then 2
> failed; at 1 worker, five consecutive runs were deterministic once the `perf-load`
> assertion defect (fixed in b46323d) is excluded — run 4's single failure, at 11 ms
> against 10 ms, was that defect and not contention. Every failing test passed when run
> alone. The mobile
> project at the same 5 workers was 6/6 clean, so this is weight rather than worker count
> — Chromium at 1440x900 costs far more per worker than WebKit at 390x844. Not weakened to
> pass: no assertion, threshold or timeout was changed, and the gate is stricter in
> practice because it stops failing intermittently on merit. Cost is 174-192 s against
> roughly 100 s. Convention, reasoning and the `ci.yml` implication: `docs/TESTING.md`.
`--project=desktop` (Chromium, 1440x900, `hasTouch: false`) did not exist when this block
was written — the command exited 1 with `Project(s) "desktop" not found` until the project
landed, which is what made it a gate rather than a description. It runs `tests/e2e/desktop.spec.ts` plus the suites that
are viewport-agnostic once input is abstracted: `map-shell`, `mvp-loop`, `offline`,
`offline-map`, `perf-load`, `points-lines`, `draw-precision`, `brush`, `overlays`.
`desktop.spec.ts` asserts: Escape during a polygon draw leaves no drawing controls on
screen and a fresh draw still works; `cancel-drawing` ends a session the same way; a
right-drag leaves `getBearing()` and `getPitch()` at 0; the rating sheet and queued banner
are each no wider than 640 px at 1440x900; Escape closes the sheet, focus lands inside it
on open, and Tab from the last control stays inside; and the cursor over a saved area,
line and point is `pointer`, not `grab`.
All five grep probes failed at drafting time — none of those strings existed — and pin the
behaviours with no cheaper assertion.

**out_of_scope**
PWA work — `scripts/assert-pwa.mjs` already runs a plain desktop Chromium context and
passes 10/10, so desktop install is verified, not missing; the wide-form-factor
`screenshots` entry is cosmetic and stays out. A compass or reset-north control: rotation
is removed rather than made recoverable. Keyboard-complete drawing (placing vertices
without a pointer). Breakpoint forks or a separate desktop layout. Moving the control
cluster off the bottom band. Mouse paths for `touch-draw.spec.ts` — it exists to
reproduce a WebKit touch race and is mobile-only by design. The parallel-run flakiness
(task #22). Tightening `perf-load`'s cache bound, which the recon measured at 3.8x mobile
usage at 2560x1440 and must not drop below ~4 MB without re-measuring there.

**blocked_by**
G6.

---

## G12 — Same-origin MapLibre worker

**objective**
MapLibre's worker is started from a real same-origin URL rather than a blob built from a
fetched copy of its source, so a worker the service worker can serve is the one the
browser asks for. The offline gate stops tolerating "Importing a module script failed"
and asserts zero page errors instead. The Vite 8 / rolldown non-emission workaround
survives in whatever form the new path needs — the map must never be created against an
unresolved worker URL, and the worker must still be fetched exactly once, started by the
document.

**done_when**
```
npm run build
npm run test:e2e -- --project=mobile
npm run test:e2e -- --project=desktop --workers=1
npm run test:e2e -- --project=mobile tests/e2e/perf-load.spec.ts
node scripts/assert-bundle-budget.mjs
! grep -q "createObjectURL" src/map/MapShell.tsx
! grep -q "Importing a module script failed" tests/e2e/overlays.spec.ts
```
`overlays.spec.ts`'s offline test currently ends with a filter that tolerates exactly two
WebKit messages and fails on anything else. That allowance is deleted: the assertion
becomes `expect(pageErrors).toEqual([])` with the network hard-blocked and an overlay
enabled, which is the condition that produced the messages in the first place. The grep
gate is what stops the allowance being reintroduced quietly, and it fails today because
that string is in the file.
The `createObjectURL` gate fails today for the same reason: the blob is still how the
worker URL is made.
`perf-load.spec.ts` must stay green *unchanged*. Two of its assertions are the real
constraint on any redesign: the worker fetch is initiated by the document, and
`maplibre-gl-worker` is fetched exactly once. A naive `<link rel="modulepreload">` breaks
the second — `vite.config.ts` records it measured at two resource entries, 50 ms and
84 ms, downloading the worker twice — so that route is already known not to work.
`assert-bundle-budget.mjs` keeps G7's 380,000 B ceiling honest across the change.

**out_of_scope**
Removing the Vite 8 / rolldown workaround itself: the bundler still does not emit the
worker chunk from MapLibre's internal `new Worker(new URL(...))`, and this goal changes
how the emitted chunk is *addressed*, not whether we have to address it. Upgrading or
patching Vite, rolldown or MapLibre to fix the emission upstream. Service-worker changes
beyond whatever the new worker URL needs to be cacheable. The `docs/TESTING.md` conventions
around locks and measurement. Anything about overlays other than that one tolerated-error
allowance.

> **Stop condition invoked 2026-09-12 — this goal is closed as unachievable, and the
> tolerated allowance in `overlays.spec.ts` stays.** Measured by perf-probe: WebKit's
> service worker never receives a same-origin worker *script* request on a network-blocked
> reload — the worker load fails and the service worker sees nothing at all — so the
> offline guarantee this goal exists to provide cannot be provided this way. G5's blob-URL
> workaround remains load-bearing.
>
> The grid matters more than the verdict, because half of it is genuinely new and reads
> like a reason to reopen this:
>
> | | WebKit | Chromium |
> |---|---|---|
> | Online | **intercepted** — new since G5 | fine |
> | Offline, same document | cache-served | fine |
> | Offline, after reload | **fails; SW never sees the request** | fine |
>
> The closure is therefore about the **offline guarantee** being unavailable, explicitly
> not about interception being unavailable. "WebKit now intercepts worker loads" is true
> and insufficient: interception online, and offline inside an already-loaded document —
> where the worker spawns from the evictable HTTP cache with the service worker uninvolved
> — does nothing for the case that matters, a reload with no network. Anyone reopening this
> should first show that the offline-reload cell has changed.
>
> Two caveats that belong with the result. The spike ran in a minimal harness — plain page,
> plain service worker, plain same-origin worker on a static server — so it answers a
> question about the browser, not about areamap's plumbing; it should not be read as
> "tested in the app". And the G5-era comment at `src/map/MapShell.tsx:71` still says WebKit
> does not intercept worker script requests at all, which is no longer accurate as written;
> correcting it belongs to whichever stage next touches that file. Method and measurements:
> `docs/TESTING.md` (8b19315).

**blocked_by**
G7, G10.

---

## G13 — Move saved points and lines

**objective**
A saved point can be dragged to a new position and a saved line's vertices can be dragged
to reshape it, at 390x844 and at 1440x900. The move saves through `save-feature` like any
other feature write, survives a reload, and queues offline instead of being lost. This
closes the gap the handoff records: rating, comment and delete already work on features;
geometry does not, while areas have had it since G6.

**done_when**
```
npx supabase db reset
npx supabase gen types typescript --local | diff - src/db/types.ts
npm run build
npm run test -- tests/unit/
npm run test:e2e -- --project=mobile tests/e2e/points-lines.spec.ts
npm run test:e2e -- --project=desktop --workers=1 tests/e2e/points-lines.spec.ts
npm run test:e2e -- --project=mobile
npm run test:e2e -- --project=desktop --workers=1
grep -q 'data-testid="move-feature"' src/map/MapShell.tsx
```
`db reset` and the types diff both pass today and must keep passing: they are the assertion
that this goal added no migration, since `save_feature_tx` already accepts a geometry
update.
`points-lines.spec.ts` gains, at both viewports: a saved point dragged to a new position
reloads at the new position and not the old one; a saved line vertex dragged reshapes the
line and the reshaped geometry survives a reload; a move made with the network blocked
renders as queued, with the database still holding the old geometry, and flushes to the new
one on reconnect; and a move that is cancelled leaves the saved geometry untouched.
The grep gate fails today and pins the control that opens a move.
The two whole-project runs are the regression gate — `MapShell.tsx` is shared, and G11's
tap precedence between brush, areas and features lives there.

**out_of_scope**
H3 for features: `area_cells` stays polygon-derived, per the G9 posture. Any schema change
— if one proves necessary, stop and raise it rather than folding a migration into this
goal. Changing an existing feature's `kind`. Adding or deleting vertices of a saved line,
as opposed to moving them. Snapping features to saved borders (G6's snapping is a polygon
concern). Multi-select or moving several features at once. Undo of a completed move beyond
the existing delete.

**blocked_by**
G9, G11.

---

## Not goals

Do not start these without a new block in this file:

- Rating dimensions beyond `'overall'`
- Multi-user, sharing, shared areas
