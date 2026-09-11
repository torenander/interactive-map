-- G9 migration 0008 — point and line features.
--
-- A separate table rather than more columns on `areas`. docs/OBJECTIVES.md § G9 is
-- explicit that `areas` is untouched, and the two are not the same shape: an area is a
-- polygon that derives H3 cells, a feature is a point or a line that derives none
-- (§ out_of_scope). Widening `areas.geom` to geography(Geometry) would have made every
-- existing constraint, index and the whole area_cells derivation conditional on a kind
-- column, for no gain.
--
-- One table for both kinds rather than one per kind: they differ only in geometry type
-- and share every other column, the same write path, the same RLS and the same rating
-- vocabulary. `kind` plus a check keeping it honest against the actual geometry is the
-- cheaper half of that trade.
create table public.map_features (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  geom        geography(Geometry, 4326) not null,
  kind        text not null check (kind in ('point', 'line')),
  -- Pinned from the first migration, unlike areas.dimension which needed 0006 to close
  -- it later. CLAUDE.md: dimension stays 'overall', no rating-dimension UI. Widening is
  -- one migration — drop this constraint, replace with a check against the allowed set.
  dimension   text not null default 'overall' check (dimension = 'overall'),
  -- Same -2..2 domain as areas.rating while the UI still emits only -1, 0, 1, so
  -- widening the scale stays a UI change with no migration.
  rating      smallint not null check (rating between -2 and 2),
  -- Same 2,000-character cap areas got in 0007. save-feature checks it too, so the
  -- caller gets a clean 422 rather than a constraint violation surfacing as a 400.
  comment     text check (comment is null or char_length(comment) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- `kind` is what every reader and the rendering layer branch on, so it must not be
  -- able to disagree with what is actually stored. Without this, a 'point' row could
  -- hold a LINESTRING and nothing would notice until the map tried to draw it.
  -- geography has no per-row type tag of its own once the column is declared
  -- `Geometry`, hence the cast.
  constraint map_features_geom_matches_kind check (
    (kind = 'point' and geometrytype(geom::geometry) = 'POINT')
    or (kind = 'line' and geometrytype(geom::geometry) = 'LINESTRING')
  )
);

create index map_features_geom_idx on public.map_features using gist (geom);
create index map_features_user_idx on public.map_features (user_id);

-- RLS in the migration that creates the table, never later (CLAUDE.md). Retrofitting it
-- onto a populated table is where data leaks happen.
alter table public.map_features enable row level security;

create policy map_features_owner on public.map_features
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Server-owned timestamps from the start, reusing the function migration 0006 hardened:
-- created_at frozen on update, updated_at always a server clock reading. The write
-- queue's last-write-wins rule (docs/DATA-MODEL.md) is only meaningful if the client
-- cannot choose updated_at.
create trigger map_features_touch_updated_at
before insert or update on public.map_features
for each row execute function public.touch_updated_at();
