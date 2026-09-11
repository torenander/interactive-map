-- G9 migration 0009 — save_feature_tx, and the grants that make it the sole write path.
--
-- Same posture as public.save_area_tx (migrations 0005 and 0007), arrived at there the
-- hard way and adopted here from the start rather than retrofitted:
--
--   * SECURITY DEFINER, so INSERT/UPDATE can be revoked from the client roles entirely.
--     "All writes go through save-feature" is then a grant, not a convention a client can
--     simply decline to follow via PostgREST.
--   * Because DEFINER means RLS no longer polices the statements inside the function —
--     the owner bypasses it — every guarantee the map_features_owner policy was providing
--     is restated here as an explicit check. That is the part that has to be right.
--   * user_id comes from auth.uid(). There is no parameter for it, so it cannot be
--     spoofed by the caller.
--   * Ownership is enforced as a predicate on the conflict path, not a prior SELECT. A
--     read-then-check would race two callers for the same fresh id: both read "no owner",
--     and the loser overwrites the winner's row. Here the update simply matches nothing
--     and the raise below fires.
--   * One generic error for every unwritable id — somebody else's row, or one RLS would
--     refuse — so save-feature can map them all to a single 404 and leak nothing about
--     which uuids exist.
--
-- No H3 derivation, so unlike save_area_tx this is a single statement and needs no
-- separate cell-replacement step. Points and lines are out of scope for H3 indexing
-- (docs/OBJECTIVES.md § G9 out_of_scope); area_cells is untouched by this migration.
create or replace function public.save_feature_tx(
  p_id           uuid,
  p_geom_geojson jsonb,
  p_kind         text,
  p_rating       smallint,
  p_comment      text
)
returns public.map_features
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_feature public.map_features;
begin
  -- (1) Authenticated callers only. With RLS bypassed inside a DEFINER function this is
  -- the only thing standing between an anon JWT and the table, so it comes first.
  if v_uid is null then
    raise exception 'save_feature_tx requires an authenticated caller'
      using errcode = '42501';
  end if;

  -- (2) Reject an unknown kind here as well as at the column check. The column check
  -- would catch it too, but as a constraint violation the edge function would have to
  -- parse; this raises the same coded error shape everything else here uses.
  if p_kind is null or p_kind not in ('point', 'line') then
    raise exception 'save_feature_tx: kind must be point or line'
      using errcode = '22023';
  end if;

  -- (3) dimension is pinned to 'overall' here as well as by the column check — the sole
  -- write path never emits anything else.
  insert into public.map_features as f (id, user_id, geom, kind, dimension, rating, comment)
  values (
    p_id,
    v_uid,
    st_geomfromgeojson(p_geom_geojson)::geography(Geometry, 4326),
    p_kind,
    'overall',
    p_rating,
    p_comment
  )
  on conflict (id) do update
    set geom    = excluded.geom,
        kind    = excluded.kind,
        rating  = excluded.rating,
        comment = excluded.comment
    where f.user_id = v_uid
  returning f.* into v_feature;

  if v_feature.id is null then
    raise exception 'save_feature_tx: feature is not writable by this caller'
      using errcode = '42501';
  end if;

  return v_feature;
end;
$$;

-- anon is revoked explicitly, not just PUBLIC: Supabase's default privileges grant
-- execute on new public-schema functions to anon as well, so `revoke ... from public`
-- alone would leave it callable.
revoke all on function public.save_feature_tx(uuid, jsonb, text, smallint, text) from public;
revoke all on function public.save_feature_tx(uuid, jsonb, text, smallint, text) from anon;
grant execute on function public.save_feature_tx(uuid, jsonb, text, smallint, text) to authenticated;

-- The grants that make the function the only writer, mirroring what 0007 did for areas.
-- SELECT stays (RLS scopes what it returns) and DELETE stays — deleting a whole feature
-- direct is the same documented contract whole-area deletes have, and a feature owns no
-- derived rows for a cascade to clean up. service_role keeps everything: it is the
-- break-glass path and is never handed to a browser.
revoke insert, update on public.map_features from authenticated, anon;
