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

Marks carry whose run they rest on. Every box is `[x]` on **the lead's independent
validation at da87b22, 2026-09-12**: the `move-feature` grep 0, `db reset` 0 with
migrations 0001-0009 and none added, a clean types diff, build 0, unit 88/88, the whole
mobile project 37/37 at `retries=0`, and the whole desktop project 36/36 at `--workers=1
retries=0` — the full lanes subsume the suite-specific commands. draw-accuracy's evidence
below each box is what the mark was raised on and stands as recorded; the lead's run is
what it now rests on.


- [x] Read `src/map/MapShell.tsx`'s area-edit session first — G6 built this for polygons
      (load into Terra Draw's store, `SELECT_MODE`, vertices as handles, cancel by dropping
      the session since `areas` is never mutated while it is open) — and follow it rather
      than inventing a second shape for one interaction
- [x] Terra Draw select-mode flags for `point` and `linestring`, mirroring the polygon
      entry: a point is `feature.draggable`, a line is `coordinates.draggable` with
      midpoints off, since adding vertices is out of scope
- [x] A `move-feature` control on the saved-feature sheet to open a move session, and a
      cancel that restores the saved geometry by dropping the session
- [x] Route the moved geometry through `saveFeature` → `save-feature`; no new SQL, since
      `save_feature_tx`'s conflict path already sets `geom`
- [x] Offline: the feature queue carries the moved geometry, renders as queued, and flushes
      on reconnect — mirroring what the area queue does with an edited outline
- [x] Check the tap-precedence rules still hold with a move session open: brush owns the
      pointer while active, any open session blocks another, and a feature beats the area
      beneath it. A move session is a fourth state in that table, not an exception to it
- [x] Extend `points-lines.spec.ts` with the assertions above, using `tests/e2e/input.ts`
      so both projects run them, and `tests/e2e/rendered.ts` before any click on saved
      geometry — that race is what failed the G11 sweep once
- [x] Run the `done_when` block; record outputs


---

## Done 2026-09-12 (teammate draw-accuracy)

Commits: `5a9cb6e` (move sessions, MapShell + RatingModal), `6239ede` (spec).

**Schema check confirmed before writing anything.** `save_feature_tx`'s conflict path
already carries `set geom = excluded.geom` (migration 0009, line 69), so a move is the
write path that exists. No migration was added, and `db reset` + a clean types diff are
the assertion of that.

### done_when — as measured

All nine exit 0, under the canonical lock, against a still tree (`MapShell.tsx` last
touched by `5a9cb6e`; no uncommitted src during the run).

| Command | Exit | Result |
|---|---|---|
| `npx supabase db reset` | 0 | migrations 0001-0009, none added |
| `gen types \| diff - src/db/types.ts` | 0 | no drift |
| `npm run build` | 0 | — |
| `npm run test -- tests/unit/` | 0 | 8 files, 88 passed |
| mobile `points-lines.spec.ts` | 0 | 9 passed |
| desktop `points-lines.spec.ts` `--workers=1` | 0 | 9 passed |
| whole mobile project | 0 | 37 passed |
| whole desktop project `--workers=1` | 0 | 36 passed |
| `grep -q 'data-testid="move-feature"'` | 0 | — |

### Design

Follows G6's area-edit session rather than a second shape for one interaction: load the
saved geometry into Terra Draw, select mode, dismiss the sheet (its backdrop is what
stands between the user and the handles), row untouched until Save. Cancel drops the
session, which restores the saved geometry for free because `mapFeatures` is never mutated
while one is open. The feature under a move is withheld from the saved-features source so
a stale copy is not stacked under the live one.

Select-mode flags carry the polygon entry's reasoning across: a point is
`feature.draggable`, because its one coordinate *is* the feature; a line is
`coordinates.draggable` with midpoints off, since adding vertices is out of scope and a
line sliding bodily is the same easy accident that keeps areas undraggable.

**Tap precedence — the fourth state.** A move session is an open session, so it takes the
existing rule rather than an exception to it: `handleAreaClick` and `handleFeatureClick`
both already return early on an open feature session, so while a move is open the pointer
belongs to Terra Draw's handles and neither handler competes for it. Brush still owns the
pointer outright when active; a feature still beats the area beneath it. Nothing in the
G11 table needed changing — the fourth state slots into rule 2.

### A bug this exposed, worth recording

The `finish` handler split on geometry *before* action, so its point/line branch ran
unconditionally. That was correct while a finish on a feature could only mean a fresh
placement, and wrong the moment one could be dragged: a move's drag was read as a new
placement, which reopened the sheet and queued a SECOND feature instead of moving the one
in hand. Found by probing the mechanism before writing the spec, not by the spec. It now
splits on action first, which is what the polygon path already did — the asymmetry was the
bug.

### Deviations

**`RatingModal` gains an `extraAction` slot** rather than a `Move` prop. Four session
types share that sheet and it knows about none of them; an area or a brushed selection
must not grow a dead button to pay for this one. The control itself lives in `MapShell`,
which is also what the goal's grep gate requires.

**This file's two local render-waits are migrated onto `tests/e2e/rendered.ts`.** The
local helper queried both feature layers at once, so a line assertion could be satisfied
by a rendered point; the shared helper is per-layer and each call site now names the layer
its test is about.