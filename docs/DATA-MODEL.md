# Data model

## Tables

### `public.areas`

The source of truth. One row per drawn area.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | FK `auth.users(id)`, cascade delete |
| `geom` | `geography(Polygon, 4326)` | WGS84. `geography` not `geometry` — distance and area come out in metres without reprojection |
| `dimension` | `text` | Hardcoded `'overall'`. See ARCHITECTURE.md |
| `rating` | `smallint` | -2..2 enforced by check. MVP UI emits -1, 0, 1 |
| `comment` | `text` | Nullable |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | Maintained by trigger, not by the client |

### `public.area_cells`

Derived index. Recomputable from `areas.geom` at any time. Never written independently.

| Column | Type | Notes |
|---|---|---|
| `area_id` | `uuid` | FK `areas(id)`, cascade delete |
| `h3_index` | `text` | H3 cell id as h3-js's 15-char hex string. PK together with `area_id`. Plain text because the `h3index` type comes from h3-pg, which no Supabase Postgres image ships (see ARCHITECTURE.md § Cell derivation, superseded note) |
| `resolution` | `smallint` | Default 10. Stored so a future resolution change is detectable |

## Migration 0001 — tables

```sql
create extension if not exists postgis;
-- h3 / h3_postgis deliberately absent: not available in any Supabase Postgres
-- image, local or hosted. Cells are derived in the save-area edge function.

create table public.areas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  geom        geography(Polygon, 4326) not null,
  dimension   text not null default 'overall',
  rating      smallint not null check (rating between -2 and 2),
  comment     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index areas_geom_idx on public.areas using gist (geom);
create index areas_user_idx on public.areas (user_id);

create table public.area_cells (
  area_id     uuid not null references public.areas(id) on delete cascade,
  h3_index    text not null,
  resolution  smallint not null default 10,
  primary key (area_id, h3_index)
);

create index area_cells_h3_idx on public.area_cells (h3_index);
```

## Migration 0002 — cell derivation (superseded to edge function)

The trigger this migration originally specified cannot exist: `h3_polygon_to_cells`
comes from the h3-pg extension, which is not available in any Supabase Postgres image,
local or hosted (verified 2026-09-10; open upstream requests since 2022). The file
`supabase/migrations/0002_derive_cells.sql` is kept as an intentional no-op comment so
migration numbering still matches this document.

Derivation now lives in `supabase/functions/save-area/index.ts` — the sole write path
for areas. Contract:

- Input: `{ id, geom, rating, comment }` with a client-generated uuid as `id`, so a
  retried call is an idempotent upsert.
- Runs with the caller's JWT, not the service role — RLS applies as usual.
- Computes the cell set with h3-js `polygonToCells` at resolution 10, then hands row and
  cells to `public.save_area_tx` (migration 0005) in a single call, which replaces the
  area's cells wholesale (delete + insert) inside one transaction. Never appends.
- Rejects a polygon deriving more than 5,000 res-10 cells (~75 km²) with a 422, before
  any write — see migration 0005 for why the ceiling exists and how it was chosen — and
  a comment over 2,000 characters likewise (migration 0007).
- Every "you cannot write this id" outcome returns the same `404 {"error": "Area not
  found or not writable"}`, so another user's area id is not distinguishable from any
  other unwritable one by message or status.
- Whole-area deletes go straight to the table; the FK cascade removes cells.

Rebuild the whole index if the derivation logic ever changes: re-save each area
through `save-area` (geometry is unchanged, cells recompute).

**Known limit:** `polygonToCells` is center-containment. A polygon smaller than one
res-10 hexagon (~130 m across) can legitimately produce zero cells. Acceptable for
the MVP — nothing reads cells yet — but any future cell-consuming feature must treat
an empty cell set as "index absent", not "area absent".

## Migration 0003 — updated_at

```sql
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger areas_touch_updated_at
before update on public.areas
for each row execute function public.touch_updated_at();
```

## Migration 0004 — row-level security

```sql
alter table public.areas enable row level security;
alter table public.area_cells enable row level security;

create policy areas_owner on public.areas
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy area_cells_owner on public.area_cells
  for all
  using (
    exists (
      select 1 from public.areas a
      where a.id = area_cells.area_id and a.user_id = auth.uid()
    )
  );
```

RLS goes in before any real data exists. Enabling it on a populated table is where leaks happen.

## Migration 0005 — atomic area write

`public.save_area_tx(p_id uuid, p_geom_geojson jsonb, p_rating smallint, p_comment text,
p_cells text[], p_resolution smallint)` — `security invoker`, execute granted to
`authenticated` only. See `supabase/migrations/0005_atomic_area_write.sql` for the full
rationale; in short, the row write and the cell replacement are now one transaction
instead of three PostgREST round trips, which fixes two reproduced defects: a partial
write (row updated, cells deleted, insert never reached) when the edge worker died
mid-sequence, and interleaved concurrent saves of the same id leaving `area_cells`
holding cells from several geometries at once. Concurrent writers for one id serialise on
the row lock the upsert takes, so last-write-wins stays true for the cells as well as the
row — the model docs/DATA-MODEL.md § Client-side write queue already assumed.

The 0002 contract above is unchanged in intent; `save-area` still derives cells with
h3-js and still owns the write path. Only the number of transactions changed.

## Migration 0006 — server-owned timestamps, pinned dimension

`touch_updated_at` fires `before insert or update` (0003 was update-only), sets
`updated_at` from the server clock on both, and freezes `created_at` to its original
value on update — a client could previously insert a row with any timestamps it liked,
which makes "last-write-wins on `updated_at`" meaningless. `areas` also gains
`check (dimension = 'overall')`, so the CLAUDE.md pin is enforced rather than conventional.
Widening it later is one migration.

## Migration 0007 — sole write path, comment cap

`save_area_tx` becomes `security definer` and the client roles lose their write grants:
`insert, update` on `areas` and `insert, update, delete` on `area_cells` are revoked from
`authenticated` and `anon`. "All writes go through save-area" stops being a code
convention and becomes a privilege. `service_role` keeps everything — it is the
administrative path and never reaches a browser.

`security definer` means RLS no longer polices the statements inside the function (the
owner bypasses it), so migration 0007 restates every guarantee RLS was making, explicitly:
the caller must be authenticated; `user_id` is taken from `auth.uid()` and has no
parameter; the conflict path only updates a row whose `user_id` already matches, and
raises the same generic error otherwise, so nothing about another user's rows leaks; cells
are written only for the row the upsert returned. The ownership test is a `where` clause
on the upsert rather than a preceding `select` because a separate read would race two
callers for one fresh id.

Also adds `check (comment is null or char_length(comment) <= 2000)` — a 1 MB comment was
accepted before. `save-area` mirrors the limit with a 422 so the client gets a clean
rejection rather than a constraint violation.

## Rules

- **Geometry wins.** If `area_cells` and `areas.geom` disagree, rebuild the cells. Never reconcile in the other direction.
- **No client-side cell writes — enforced by the database since migration 0007.** Derivation is server side so there is exactly one implementation; an offline or stale client would index differently and the drift would be silent. This is no longer a convention: `authenticated` and `anon` hold no INSERT/UPDATE on `areas` and no INSERT/UPDATE/DELETE on `area_cells`, so `save_area_tx` is the only thing that can write either table. SELECT stays granted (RLS still scopes it), and DELETE on `areas` stays granted because whole-area deletes going direct is the documented contract.
- **All schema changes via `supabase/migrations/`.** No dashboard edits. Regenerate types after every migration:
  ```bash
  npx supabase gen types typescript --local > src/db/types.ts
  ```
- **`areas` is polygons only.** Points and lines live in their own table, not as a geometry-type column on `areas` — the question this rule used to leave open, answered below and settled since G9.
  - **Decided 2026-09-11 (G9).** Their own table: `public.map_features`, migrations 0008 and 0009. `areas` is untouched. Joining them onto `areas` would have made every existing constraint, index and the whole `area_cells` derivation conditional on a kind column, for no gain — an area derives H3 cells, a point or line derives none. One table covers both kinds, with `kind` (`'point' | 'line'`) kept honest against `geometrytype(geom::geometry)` by a check constraint.

## Client-side write queue

Offline saves are held locally and flushed on reconnect.

- Store in IndexedDB, not localStorage — geometry payloads exceed the localStorage budget quickly
- Queue entries carry a client-generated `uuid` used as the row `id`, and flush through the `save-area` edge function, so a retry is an idempotent upsert
- Flush is last-write-wins on `updated_at`. Single-user, so real conflicts are rare; document the behaviour rather than building merge logic
- The UI shows queued state explicitly. Never render a save as complete before the server has it

## Export

GeoJSON, so nothing is trapped in the hosted database:

Both tables in one FeatureCollection, told apart by a `kind` property — `'area'` for a
row from `areas`, and the row's own `'point'` / `'line'` for one from `map_features`. One
file rather than two, because "nothing is trapped in the hosted database" means the
export has to be everything the user drew, not everything they drew that happened to be
a polygon.

```sql
select json_build_object(
  'type', 'FeatureCollection',
  'features', coalesce(json_agg(feature), '[]'::json)
)
from (
  select json_build_object(
    'type', 'Feature',
    'geometry', st_asgeojson(geom)::json,
    'properties', json_build_object(
      'id', id, 'kind', 'area', 'rating', rating, 'comment', comment,
      'dimension', dimension, 'created_at', created_at
    )
  ) as feature
  from public.areas
  where user_id = auth.uid()

  union all

  select json_build_object(
    'type', 'Feature',
    'geometry', st_asgeojson(geom)::json,
    'properties', json_build_object(
      'id', id, 'kind', kind, 'rating', rating, 'comment', comment,
      'dimension', dimension, 'created_at', created_at
    )
  )
  from public.map_features
  where user_id = auth.uid()
) as both_tables;
```

`area_cells` is deliberately not exported: it is derived from `areas.geom` and
recomputable from it (docs/ARCHITECTURE.md § "Geometry model"), so shipping it would be
shipping a cache.
