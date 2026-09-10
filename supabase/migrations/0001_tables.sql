-- G2 migration 0001 — tables. Verbatim from docs/DATA-MODEL.md § Migration 0001.
create extension if not exists postgis;
create extension if not exists h3;
create extension if not exists h3_postgis;

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
  h3_index    h3index not null,
  resolution  smallint not null default 10,
  primary key (area_id, h3_index)
);

create index area_cells_h3_idx on public.area_cells (h3_index);
