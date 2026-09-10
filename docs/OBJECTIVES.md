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
npx lighthouse http://localhost:4173 --only-categories=pwa --output=json --quiet | node scripts/assert-pwa.mjs
npm run test:e2e -- tests/e2e/offline-map.spec.ts
```
`assert-pwa.mjs` exits non-zero unless the installability audits pass.
`offline-map.spec.ts` asserts the map renders tiles with the network blocked after one warm load.

**out_of_scope**
App store distribution. Push notifications.

**blocked_by**
G3.

---

## Not goals

Do not start these without a new block in this file:

- Brush painting of H3 cells
- Point and line features
- Rating dimensions beyond `'overall'`
- Multi-user, sharing, shared areas
- Open data overlays (TfL, Ordnance Survey, DEFRA)
