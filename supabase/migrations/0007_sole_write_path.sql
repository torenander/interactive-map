-- G-fix migration 0007 — the sole write path becomes a database guarantee.
--
-- Until now "all writes to areas go through save-area" (CLAUDE.md) was a code
-- convention. RLS only ever said "you may write your own rows", so an authenticated
-- client could PostgREST its way around the edge function entirely: insert an area with
-- no cells at all, or insert area_cells rows with h3_index = 'not-an-h3-index'. Both
-- produce exactly the areas/area_cells disagreement that docs/DATA-MODEL.md's
-- "geometry wins" rule exists to recover from, and neither is detectable at read time.
--
-- Fix: take INSERT/UPDATE on areas and INSERT/UPDATE/DELETE on area_cells away from the
-- client roles, and let save_area_tx — now SECURITY DEFINER — be the only thing that can
-- perform them. What stays granted:
--   * SELECT on both tables. RLS (migration 0004) still scopes what that returns.
--   * DELETE on areas. Whole-area deletes going direct is the documented contract
--     (CLAUDE.md, docs/DATA-MODEL.md § Migration 0002); the FK cascade removes the cells
--     without needing a DELETE grant on area_cells, since cascades run as the system,
--     not as the caller.
--
-- SECURITY DEFINER means RLS no longer polices the statements inside the function: the
-- owner (postgres) bypasses it. Every guarantee RLS was providing is therefore restated
-- as an explicit check below. This is the part of the change that has to be right.
create or replace function public.save_area_tx(
  p_id          uuid,
  p_geom_geojson jsonb,
  p_rating      smallint,
  p_comment     text,
  p_cells       text[],
  p_resolution  smallint
)
returns public.areas
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_area public.areas;
begin
  -- (1) Authenticated callers only. Without RLS behind it this is the only thing
  -- standing between an anon JWT and the areas table, so it comes first.
  if v_uid is null then
    raise exception 'save_area_tx requires an authenticated caller'
      using errcode = '42501';
  end if;
  if p_cells is null or array_length(p_cells, 1) is null then
    raise exception 'save_area_tx requires a non-empty cell set'
      using errcode = '22023';
  end if;

  -- (2) user_id comes from the JWT, never from the caller's input — there is no
  -- parameter for it, and the insert below is the only place it is ever set.
  -- (3) The `where a.user_id = v_uid` on the conflict path is the ownership check. It
  -- lives inside the statement rather than in a separate SELECT-then-check on purpose:
  -- a prior SELECT would race two callers for the same fresh id, where both read "no
  -- owner" and the loser then updates the winner's row. Here the update simply matches
  -- nothing, no row is returned, and the raise below fires — with the same errcode the
  -- unauthorised paths use, which save-area maps to its one generic
  -- "not found or not writable" response. No ownership information leaks out.
  insert into public.areas as a (id, user_id, geom, dimension, rating, comment)
  values (
    p_id,
    v_uid,
    st_geomfromgeojson(p_geom_geojson)::geography(Polygon, 4326),
    'overall',
    p_rating,
    p_comment
  )
  on conflict (id) do update
    set geom    = excluded.geom,
        rating  = excluded.rating,
        comment = excluded.comment
    where a.user_id = v_uid
  returning a.* into v_area;

  if v_area.id is null then
    raise exception 'save_area_tx: area is not writable by this caller'
      using errcode = '42501';
  end if;

  -- (4) Cells are written only for the row verified above — p_id is the id that just
  -- came back from the insert/update, and nothing else is touched.
  delete from public.area_cells where area_id = v_area.id;

  insert into public.area_cells (area_id, h3_index, resolution)
  select distinct v_area.id, c, p_resolution
  from unnest(p_cells) as c;

  return v_area;
end;
$$;

revoke all on function public.save_area_tx(uuid, jsonb, smallint, text, text[], smallint) from public;
revoke all on function public.save_area_tx(uuid, jsonb, smallint, text, text[], smallint) from anon;
grant execute on function public.save_area_tx(uuid, jsonb, smallint, text, text[], smallint) to authenticated;

-- The grants that make the function the only writer. service_role keeps everything:
-- it is the break-glass/administrative path and is never handed to a browser.
revoke insert, update on public.areas from authenticated, anon;
revoke insert, update, delete on public.area_cells from authenticated, anon;

-- Comment cap. 1 MB of text was accepted here before, which is a payload-size hole
-- rather than a field note. 2000 characters is roughly a page of prose — far more than
-- "quiet street, no supermarket" needs, and small enough that a comment can never
-- dominate the row. The same limit is checked in save-area so the client gets a clean
-- 422 instead of a constraint violation.
alter table public.areas
  add constraint areas_comment_length check (comment is null or char_length(comment) <= 2000);
