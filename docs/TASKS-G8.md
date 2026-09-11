# G8 — Brush painting of H3 cells — task breakdown

**Goal:** Paint an area by dragging a finger — touched res-10 H3 cells accumulate, the
selection becomes one polygon on release, and that polygon saves through `save-area` like
a drawn one. Exit criteria: `docs/OBJECTIVES.md` § G8.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G3, G6 — the brush must not be built on a drawing pipeline that G6 is still
changing.

---

## Tasks

- [ ] Promote `h3-js` from `devDependencies` to `dependencies` (today it is test/edge-function only).
- [ ] Brush mode: pointer-down opens a session, every `pointermove` adds `latLngToCell` at res 10, pointer-up closes it. Sample every move event rather than throttling to frames and dropping cells.
- [ ] Render the live selection as its own source, distinct from saved-area fill.
- [ ] Convert with `cellsToMultiPolygon`; reject a selection producing more than one outer ring, telling the user to paint a connected shape. No union, no repair.
- [ ] Brush size (1/2/3 rings via `gridDisk`) and erase toggle, both in the bottom third of the screen.
- [ ] Undo removes the last stroke's cells, not the session.
- [ ] Save path unchanged: the synthesised polygon goes to `saveArea` → `save-area`, which rederives cells from it.
- [ ] Cap the session at `save-area`'s 5,000-cell ceiling, refusing further painting there rather than failing at save time.
