-- G-fix migration 0005 — atomic area write.
--
-- Why: save-area used to do three separate statements over PostgREST (upsert areas,
-- delete area_cells, insert area_cells). Three round trips are three transactions, which
-- produced two reproducible defects against the local stack:
--
--   * A crash or timeout between the delete and the insert (a large polygon hitting the
--     edge-runtime WORKER_LIMIT) left the areas row updated with ZERO cells — a partial
--     write the client was told had failed.
--   * Concurrent calls with the same id interleaved: writer A's insert could land after
--     writer B's delete, so area_cells ended up holding cells from several geometries at
--     once (65 rows for a geometry that derives 14), silently violating the documented
--     "replaces wholesale, never appends" contract. Identical concurrent saves instead
--     collided on area_cells_pkey and returned spurious 400s.
--
-- Fix: one function, one transaction. The `insert ... on conflict do update` takes a row
-- lock on public.areas for this id, so concurrent callers for the same area serialise on
-- it: the second waits for the first to commit, then deletes the cells the first
-- committed and inserts its own. Last writer wins, wholesale, with no interleaving —
-- which is exactly the last-write-wins model docs/DATA-MODEL.md § Client-side write queue
-- already documents.
--
-- SECURITY INVOKER (the default, stated explicitly because it is load bearing): the
-- function runs as the calling user, so the RLS policies from migration 0004 still govern
-- every statement in it. save-area forwards the caller's JWT, so `auth.uid()` here is the
-- end user, never the service role.
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
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_area public.areas;
begin
  if auth.uid() is null then
    raise exception 'save_area_tx requires an authenticated caller'
      using errcode = '42501';
  end if;
  if p_cells is null or array_length(p_cells, 1) is null then
    raise exception 'save_area_tx requires a non-empty cell set'
      using errcode = '22023';
  end if;

  -- Upsert first: this is the serialisation point for concurrent writers on this id.
  -- dimension is pinned to 'overall' here as well as by the check constraint in
  -- migration 0006 — the sole write path never emits anything else.
  insert into public.areas as a (id, user_id, geom, dimension, rating, comment)
  values (
    p_id,
    auth.uid(),
    st_geomfromgeojson(p_geom_geojson)::geography(Polygon, 4326),
    'overall',
    p_rating,
    p_comment
  )
  on conflict (id) do update
    set geom    = excluded.geom,
        rating  = excluded.rating,
        comment = excluded.comment
  returning a.* into v_area;

  -- Wholesale replacement, inside the same transaction as the upsert above.
  delete from public.area_cells where area_id = p_id;

  insert into public.area_cells (area_id, h3_index, resolution)
  select distinct p_id, c, p_resolution
  from unnest(p_cells) as c;

  return v_area;
end;
$$;

-- Reachable by signed-in users only. anon is revoked explicitly, not just PUBLIC: Supabase's
-- default privileges grant execute on new public-schema functions to anon as well, so a
-- `revoke ... from public` alone would leave it callable. The function is SECURITY INVOKER,
-- so RLS would refuse an anon caller anyway; this makes it refuse one statement earlier.
revoke all on function public.save_area_tx(uuid, jsonb, smallint, text, text[], smallint) from public;
revoke all on function public.save_area_tx(uuid, jsonb, smallint, text, text[], smallint) from anon;
grant execute on function public.save_area_tx(uuid, jsonb, smallint, text, text[], smallint) to authenticated;
