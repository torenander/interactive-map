-- G2 migration 0001 — tables. Adapted from docs/DATA-MODEL.md § Migration 0001.
--
-- DEVIATION (2026-09-10): dropped `create extension h3` / `h3_postgis`. Neither extension
-- exists in any Supabase Postgres image, local or hosted (verified directly against
-- supabase/postgres:17.6.1.167 and :15.14.1.170 — postgis is bundled, h3/h3_postgis are
-- not, on either; upstream feature requests supabase/postgres#245 and #664, org discussion
-- #9687, open since 2022, unresolved). Cell derivation moved to a Supabase Edge Function
-- using h3-js — see supabase/migrations/0002_derive_cells.sql and
-- docs/ARCHITECTURE.md § "Cell derivation runs server side" (superseded note). Because
-- there is no h3 extension, `h3_index` below is plain `text` (h3-js's hex string), not the
-- `h3index` type.
create extension if not exists postgis;

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
