# G9 — Point and line features — task breakdown

**Goal:** Drop a point and draw a line, each with a rating and comment, persisted in
`public.map_features` behind a single `save-feature` write path and rendered on the same
map. `areas` is untouched. Exit criteria: `docs/OBJECTIVES.md` § G9.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G3, G4, G6 — the Terra Draw configuration changes land in G6.

---

## Tasks

- [x] Migration `0008_map_features.sql`: `public.map_features` — `id uuid pk`, `user_id` FK to `auth.users` on delete cascade, `geom geography(Geometry,4326)`, `kind text check (kind in ('point','line'))`, `dimension` pinned to `'overall'` by check, `rating smallint check (rating between -2 and 2)`, `comment` capped at 2,000 chars by check, timestamps; a check that `geometrytype(geom::geometry)` agrees with `kind`; GiST index on `geom`; RLS enabled with an owner policy in this same migration; `touch_updated_at` attached.
- [x] Migration `0009_save_feature_tx.sql`: `save_feature_tx(p_id, p_geom_geojson, p_kind, p_rating, p_comment)`, `security definer`, execute to `authenticated` only, `user_id` from `auth.uid()` with no parameter, upsert guarded by `where user_id = auth.uid()` and raising the same generic not-found error otherwise. Revoke `insert, update` on `map_features` from `authenticated` and `anon`; keep `select` and `delete`, matching the `areas` posture.
- [x] `supabase/functions/save-feature` as the sole write path, mirroring `save-area`: client-generated uuid for idempotent retry, caller's JWT, 422 on an over-length comment or a geometry/`kind` mismatch, the same generic 404 for anything unwritable. Recycle the edge runtime after adding it, then regenerate `src/db/types.ts`.
- [x] Terra Draw point and linestring modes in the polygon control group; rating modal reused unchanged.
- [x] Points as circles, lines as strokes, rating-coloured from `src/areas/color.ts`, above area fills so a point inside a rated area stays tappable. Tap to read, edit, delete.
- [x] Write queue carries feature saves through `save-feature`, same last-write-wins rule; GeoJSON export unions both tables with a `kind` property.


---

## Backend stage — done 2026-09-11 (teammate draw-accuracy)

Tasks 1-3 above plus the `save-feature.test.ts` and `schema.test.ts` additions the
`done_when` names. Tasks 4-6 are UI and remain `[ ]`; the file queue puts MapShell work
after G7 stage 2 and G8.

### done_when — as measured (backend subset)

`points-lines.spec.ts` is not in this stage; it needs the UI from tasks 4-6.

| Command | Exit | Result |
|---|---|---|
| `npx supabase db reset` | 0 | 9 migrations applied, 0001-0009 |
| `npx supabase gen types typescript --local \| diff - src/db/types.ts` | 0 | no drift |
| `npm run build` | 0 | — |
| `npm run test -- tests/unit/save-feature.test.ts tests/unit/schema.test.ts` | 0 | 16 passed |
| `npm run test` (whole suite, for regressions) | 0 | 7 files, 63 passed |

### Design notes

**A separate table, not wider `areas`.** G9 says `areas` is untouched, and the two are
not the same shape: an area is a polygon that derives H3 cells, a feature derives none
(§ out_of_scope). Widening `areas.geom` to `geography(Geometry)` would have made every
existing constraint, index and the whole `area_cells` derivation conditional on a kind
column, for nothing.

**One table for both kinds.** They differ only in geometry type and share every other
column, the write path, RLS and the rating vocabulary. `kind` plus
`map_features_geom_matches_kind` — which compares `kind` against
`geometrytype(geom::geometry)` — is the cheaper half of that trade, and it stops a
'point' row ever holding a LINESTRING that the map cannot draw.

**0009 adopts the `save_area_tx` posture up front** rather than arriving at it over two
migrations as `areas` did (0005 then 0007): SECURITY DEFINER with INSERT/UPDATE revoked
from `authenticated` and `anon`, `user_id` from `auth.uid()` with no parameter, ownership
enforced as a predicate on the conflict path rather than a racy read-then-check, and one
generic error for every unwritable id. SELECT and DELETE stay granted — a feature owns no
derived rows, so a direct delete leaves nothing behind.

RLS, the `dimension = 'overall'` pin and the 2,000-character comment cap are all in the
creating migration, not retrofitted the way `areas` needed in 0006/0007.

### Deviations and notes

**No H3 work, deliberately.** `save-feature` mirrors `save-area` minus the cell budget,
the bbox pre-check and the cell replacement. H3 indexing of points and lines is named in
G9's `out_of_scope`, so `area_cells` is untouched by 0008 and 0009.

**`kind` is validated in both places.** The function returns 422 with a message saying
which half disagreed; the column check is what actually guarantees it. The test asserts
both, because a constraint violation reaching the client as an opaque 400 is not the
contract.

**Two extra tests beyond the `done_when` list.** `save-feature.test.ts` also asserts a
comment of exactly the cap still saves (so the 422 is the cap, not an off-by-one), and
`schema.test.ts` asserts `kind` cannot disagree with the stored geometry at the table —
the service role holds INSERT and is still refused.

**Local-stack gotcha, cost one red run.** The Supabase CLI mounts edge functions from the
directory it was started in. The stack had been started from the main checkout, whose
`supabase/functions/` has no `save-feature`, so every call returned `Function not found`
even though `db reset` from this worktree had applied 0008 and 0009 correctly. Recycling
with `npx supabase stop && npx supabase start` **from this worktree** fixed it. The
CLAUDE.md recycle rule is necessary but not sufficient — the cwd matters too.

---

## UI stage — done 2026-09-11 (teammate draw-accuracy)

Tasks 4-6, `tests/e2e/points-lines.spec.ts`, and the full G9 `done_when` block.

### done_when — as measured

Run from this worktree, all under the shared e2e lock. e2e ran **without**
`VITE_TILES_URL`: `public/tiles/london.pmtiles` is present again, so the committed
default applies — the stricter of the two paths.

| Command | Exit | Result |
|---|---|---|
| `npx supabase db reset` | 0 | migrations 0001-0009 |
| `npx supabase gen types typescript --local \| diff - src/db/types.ts` | 0 | no drift |
| `npm run build` | 0 | — |
| `npm run test -- tests/unit/save-feature.test.ts tests/unit/schema.test.ts` | 0 | 16 passed |
| `npm run test:e2e -- tests/e2e/points-lines.spec.ts` | 0 | 3 passed |

Regression sweep on top, because MapShell is shared: `npm run test` 0 (7 files, 74
passed) and the **whole** e2e directory 0 — 21 passed across all eight suites
(map-shell, mvp-loop, offline, offline-map, touch-draw, draw-precision, brush,
perf-load, points-lines).

### Tap precedence — three pointer consumers

Decided here, following the G8 precedent that a mode owns the pointer:

1. **Brush mode wins outright.** While it is active the pointer belongs to the brush and
   nothing else fires (G8's rule, unchanged — `handleAreaClick` and the new
   `handleFeatureClick` both return early on `brushingRef`).
2. **An open session blocks everything.** A pending draw, an area edit or a feature
   session means taps on other saved things are ignored, rather than silently abandoning
   the geometry already in hand.
3. **Otherwise a point or line beats the area beneath it.** Features are small marks
   drawn on top of large translucent fills; if the area won, a point inside a rated area
   would be untappable, which G9's `done_when` explicitly forbids. The reverse is never a
   problem — an area stays tappable everywhere a feature is not, and
   `points-lines.spec.ts` asserts both halves.

Rule 3 is enforced by a hit test, not by layer order alone: `handleAreaClick` asks
`queryRenderedFeatures` over the feature layers first and returns if anything is there.
Draw order (features added last) only decides what is *visible* on top; it does not stop
a layer-scoped click handler on the area fill from firing.

The hit test uses a **22px slop box** rather than the exact tap pixel. A saved point is a
14px circle, which is not a 44px field-UX tap target on its own (docs/TASKS-FIX-TOUCH.md).
`handleFeatureClick` is registered on the map rather than on the feature layers for the
same reason — a layer-scoped handler would make the drawn circle the entire tap target.

### Deviations and notes

**Two new modules instead of extending existing ones.** `src/db/features.ts` rather than
more exports on `client.ts`: the two tables sit behind separate write paths and share
nothing but the client, and `client.ts` is the module G7 put on a lazy-import diet.
`src/offline/featureQueue.ts` gets its own IndexedDB database rather than a second object
store in the areas queue's — separate databases mean a schema change to one cannot block
the other, where adding a store would have forced a version bump that every installed
client must run through before *either* queue works again.

**Feature edit sessions cover the rating, not the geometry.** G9's `done_when` asks for
"edit rating, reload", so a feature edit loads nothing into Terra Draw and stands the map
into no mode. Moving a saved point is a later goal, not a half-built one hidden behind
this. (Areas keep their G6 geometry editing, untouched.)

**`docs/DATA-MODEL.md` edited, which was outside the listed file set.** The GeoJSON
export lives there and nowhere else — it is a documented SQL snippet, not code — so task
6's "export unions both tables with a `kind` property" could not be done without it. The
union query was run against the local stack before being written down. The same edit
resolves that file's open "decide then whether they join `areas` or get their own tables"
question, which G9 has now answered.

**Feature offline queueing is implemented but not gated.** G9's `done_when` has no
offline assertion, so this rests on the unit-level guarantees of the queue plus the
shared flush path; it is not proven end to end the way `offline.spec.ts` proves the area
queue. Worth a follow-up e2e if features are going to be relied on underground.

**One red run, worth recording.** The first `points-lines` run failed tapping a saved
point after a reload: the map comes back long before the data does, and waiting on
`isStyleLoaded()` alone tapped bare ground. The tests now wait on
`queryRenderedFeatures` over the feature layers — the same question the click handler
asks — before tapping.