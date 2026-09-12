# G13 — Move saved points and lines — task breakdown

**Goal:** A saved point can be dragged to a new position and a saved line's vertices
dragged to reshape it, at both viewports, saving through `save-feature` and queueing
offline. Exit criteria: `docs/OBJECTIVES.md` § G13.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G9, G11.

Schema check, done before drafting: **no migration is needed.** `save_feature_tx`
(migration 0009) upserts with `on conflict (id) do update set geom = excluded.geom, ...`,
so a geometry update is the write path that already exists, guarded by the same ownership
predicate on the conflict path. The `done_when` below therefore asserts the schema is
*unchanged* — `db reset` and a clean types diff — rather than asking for a new one.

---

## Tasks

- [ ] Read `src/map/MapShell.tsx`'s area-edit session first — G6 built this for polygons
      (load into Terra Draw's store, `SELECT_MODE`, vertices as handles, cancel by dropping
      the session since `areas` is never mutated while it is open) — and follow it rather
      than inventing a second shape for one interaction
- [ ] Terra Draw select-mode flags for `point` and `linestring`, mirroring the polygon
      entry: a point is `feature.draggable`, a line is `coordinates.draggable` with
      midpoints off, since adding vertices is out of scope
- [ ] A `move-feature` control on the saved-feature sheet to open a move session, and a
      cancel that restores the saved geometry by dropping the session
- [ ] Route the moved geometry through `saveFeature` → `save-feature`; no new SQL, since
      `save_feature_tx`'s conflict path already sets `geom`
- [ ] Offline: the feature queue carries the moved geometry, renders as queued, and flushes
      on reconnect — mirroring what the area queue does with an edited outline
- [ ] Check the tap-precedence rules still hold with a move session open: brush owns the
      pointer while active, any open session blocks another, and a feature beats the area
      beneath it. A move session is a fourth state in that table, not an exception to it
- [ ] Extend `points-lines.spec.ts` with the assertions above, using `tests/e2e/input.ts`
      so both projects run them, and `tests/e2e/rendered.ts` before any click on saved
      geometry — that race is what failed the G11 sweep once
- [ ] Run the `done_when` block; record outputs
