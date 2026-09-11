# G6 — Drawing precision — task breakdown

**Goal:** A polygon can be drawn accurately with one thumb at 390x844 — every placed
vertex visible, any vertex draggable before or after saving, an explicit close control,
and snapping to existing area borders, with geometry edits reaching the server through
`save-area` so `area_cells` is rebuilt. Exit criteria: `docs/OBJECTIVES.md` § G6.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G3, G4.

---

## Tasks

- [x] Pass `showCoordinatePoints: true`, `editable: true` and snapping to
      `TerraDrawPolygonMode`. **Deviation:** snapping is `{ toCustom: … }`, not
      `{ toCoordinate: true, toLine: true }` — see Deviations below.
- [x] Widen the `finish` filter so coordinate edits reach the save path. The early
      return is gone; `action === 'draw'` now selects the fresh-draw branch and every
      other action updates whichever session owns the feature id.
- [x] Route edited geometry through `handleSave` / `save-area` so cells rebuild.
      Verified end to end, including the `area_cells` set, by
      `draw-precision.spec.ts` test 2. The offline branch writes the edited `geom`
      into the queue entry and repaints the area at its edited shape meanwhile.
- [x] Add a `finish-area` button. **Deviation:** Terra Draw exposes no public
      `finish()`; the button dispatches the mode's configured finish key at the map
      canvas instead — see Deviations. `pointerDistance` lowered to 20;
      `touch-draw.spec.ts` stays green.
- [x] Write `tests/e2e/draw-precision.spec.ts` — 3 tests, all passing.

Additional work the tasks above did not anticipate, needed to make vertex editing of a
*saved* area possible at all:

- [x] Register `TerraDrawSelectMode` and load a tapped area into the draw store for the
      duration of an edit session, withholding it from the `saved-areas` source so it is
      not painted twice.
- [x] Keep an edit session alive when the sheet is dismissed, and add `cancel-edit`.
      The sheet's backdrop covers the whole map, so dismissing it is the only way to
      reach the vertex handles — clearing the session on dismiss would have made
      dragging a saved area's vertex impossible.
- [x] Extract `src/map/snapping.ts` with unit tests (`tests/unit/snapping.test.ts`).

---

## done_when — as measured

Run from this worktree on 2026-09-11. e2e runs took the shared preview/Supabase lock and
set `VITE_TILES_URL=/tiles/london-z14.pmtiles` (no `london.pmtiles` in this checkout).

| Command | Exit | Result |
|---|---|---|
| `npm run build` | 0 | — |
| `npm run test` | 0 | 5 files, 28 tests passed |
| `npm run test:e2e -- tests/e2e/draw-precision.spec.ts` | 0 | 3 passed |
| `npm run test:e2e -- tests/e2e/touch-draw.spec.ts` | 0 | 1 passed |
| `npm run test:e2e -- tests/e2e/mvp-loop.spec.ts` | 0 | 1 passed |
| `grep -q "showCoordinatePoints: true" src/map/MapShell.tsx` | 0 | — |
| `grep -q "editable: true" src/map/MapShell.tsx` | 0 | — |
| `grep -q "snapping:" src/map/MapShell.tsx` | 0 | — |
| `! grep -q "context.action !== 'draw'" src/map/MapShell.tsx` | 0 | — |
| `! grep -riq "crosshair" src/` | 0 | — |

All ten pass. No check was rewritten or weakened to get there.

## Deviations

**Snapping uses `toCustom`, not `toCoordinate` / `toLine`.** Those two built-in options
only see features in Terra Draw's own store, and saved areas are not there — they render
from the `saved-areas` MapLibre GeoJSON source. `snapping.toCustom` takes a function and
uses whatever coordinate it returns, which is the only mechanism that can reach the saved
areas at all. The goal text ("snap to the borders of existing areas") is met; the option
named in the task list would have silently snapped to nothing.

**The finish button dispatches a key, it does not call `finish()`.** Terra Draw has no
public `finish()` method — the documented way to close a ring without clicking the
closing point is the mode's configured finish key. The adapter registers its keyup
listener on the map canvas (`TerraDrawMapLibreGLAdapter#getMapEventElement`), so
`handleFinishArea` dispatches the key there. Dispatching at the canvas rather than
relying on a real key press also means the button works regardless of what holds focus.

**Snapping is to vertices, not to line segments.** G6 requires a stored coordinate
"exactly equal to that border's coordinate"; snapping to a point interpolated along a
segment produces a new coordinate that equals nothing. Vertex snapping is what makes the
exact-equality assertion in `draw-precision.spec.ts` meaningful.

**Two assertions in `draw-precision.spec.ts` compare by position, not index.** PostGIS
returns a ring rotated to its own starting vertex, so index-by-index comparison against
tap order fails for reasons that have nothing to do with precision. The tests assert that
each tapped corner has exactly one stored coordinate on it, which is the property G6
actually claims.

**Nothing here unions, clips or repairs geometry.** Snapping changes where a vertex is
placed and nothing else; two areas sharing a border hold two independent rings with equal
coordinates (`docs/ARCHITECTURE.md` § "No geometry union").
