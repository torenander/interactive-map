# G9 — Point and line features — task breakdown

**Goal:** Drop a point and draw a line, each with a rating and comment, persisted in
`public.map_features` behind a single `save-feature` write path and rendered on the same
map. `areas` is untouched. Exit criteria: `docs/OBJECTIVES.md` § G9.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G3, G4, G6 — the Terra Draw configuration changes land in G6.

---

## Tasks

- [ ] Migration `0008_map_features.sql`: `public.map_features` — `id uuid pk`, `user_id` FK to `auth.users` on delete cascade, `geom geography(Geometry,4326)`, `kind text check (kind in ('point','line'))`, `dimension` pinned to `'overall'` by check, `rating smallint check (rating between -2 and 2)`, `comment` capped at 2,000 chars by check, timestamps; a check that `geometrytype(geom::geometry)` agrees with `kind`; GiST index on `geom`; RLS enabled with an owner policy in this same migration; `touch_updated_at` attached.
- [ ] Migration `0009_save_feature_tx.sql`: `save_feature_tx(p_id, p_geom_geojson, p_kind, p_rating, p_comment)`, `security definer`, execute to `authenticated` only, `user_id` from `auth.uid()` with no parameter, upsert guarded by `where user_id = auth.uid()` and raising the same generic not-found error otherwise. Revoke `insert, update` on `map_features` from `authenticated` and `anon`; keep `select` and `delete`, matching the `areas` posture.
- [ ] `supabase/functions/save-feature` as the sole write path, mirroring `save-area`: client-generated uuid for idempotent retry, caller's JWT, 422 on an over-length comment or a geometry/`kind` mismatch, the same generic 404 for anything unwritable. Recycle the edge runtime after adding it, then regenerate `src/db/types.ts`.
- [ ] Terra Draw point and linestring modes in the polygon control group; rating modal reused unchanged.
- [ ] Points as circles, lines as strokes, rating-coloured from `src/areas/color.ts`, above area fills so a point inside a rated area stays tappable. Tap to read, edit, delete.
- [ ] Write queue carries feature saves through `save-feature`, same last-write-wins rule; GeoJSON export unions both tables with a `kind` property.
