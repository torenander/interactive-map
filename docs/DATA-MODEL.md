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
- Computes the cell set with h3-js `polygonToCells` at resolution 10 and replaces the
  area's cells wholesale (delete + insert). Never appends.
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

## Rules

- **Geometry wins.** If `area_cells` and `areas.geom` disagree, rebuild the cells. Never reconcile in the other direction.
- **No client-side cell writes.** Derivation is server side so there is exactly one implementation. An offline or stale client would index differently and the drift would be silent.
- **All schema changes via `supabase/migrations/`.** No dashboard edits. Regenerate types after every migration:
  ```bash
  npx supabase gen types typescript --local > src/db/types.ts
  ```
- **Polygons only for now.** Points and lines are planned but not in the MVP schema. When they arrive, decide then whether they join `areas` with a geometry-type column or get their own tables — do not pre-build it.

## Client-side write queue

Offline saves are held locally and flushed on reconnect.

- Store in IndexedDB, not localStorage — geometry payloads exceed the localStorage budget quickly
- Queue entries carry a client-generated `uuid` used as the row `id`, and flush through the `save-area` edge function, so a retry is an idempotent upsert
- Flush is last-write-wins on `updated_at`. Single-user, so real conflicts are rare; document the behaviour rather than building merge logic
- The UI shows queued state explicitly. Never render a save as complete before the server has it

## Export

GeoJSON, so nothing is trapped in the hosted database:

```sql
select json_build_object(
  'type', 'FeatureCollection',
  'features', coalesce(json_agg(
    json_build_object(
      'type', 'Feature',
      'geometry', st_asgeojson(geom)::json,
      'properties', json_build_object(
        'id', id, 'rating', rating, 'comment', comment,
        'dimension', dimension, 'created_at', created_at
      )
    )
  ), '[]'::json)
)
from public.areas
where user_id = auth.uid();
```
