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

- [ ] Pass `showCoordinatePoints: true`, `editable: true` and
      `snapping: { toCoordinate: true, toLine: true }` to `TerraDrawPolygonMode`
      (`src/map/MapShell.tsx:229`)
- [ ] Widen the `finish` filter at `:238` so `context.action === 'edit'` reaches the save
      path — today it returns early and geometry edits are silently discarded
- [ ] Route edited geometry through `handleSave` / `save-area` so cells rebuild; confirm
      `enqueueWrite` carries the edited `geom` offline
- [ ] Add a `finish-area` button to the bottom control band (`:520`) calling
      `draw.current.finish()`; lower `pointerDistance` to ~20 only if `touch-draw.spec.ts`
      stays green
- [ ] Write `tests/e2e/draw-precision.spec.ts`
