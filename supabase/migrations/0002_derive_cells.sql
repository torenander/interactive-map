-- G2 migration 0002 — cell derivation. Verbatim from docs/DATA-MODEL.md § Migration 0002,
-- pending verification against a local `supabase db reset` (blocked_by Docker at authoring
-- time — see docs/TASKS-G2.md Task 3). If h3-pg's extension names or the
-- h3_polygon_to_cells signature differ locally, fix the call below and document the change
-- here with the reason, keeping the semantics identical: derive cells from new.geom at
-- resolution 10.
create or replace function public.derive_area_cells()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  res smallint := 10;
begin
  delete from public.area_cells where area_id = new.id;

  insert into public.area_cells (area_id, h3_index, resolution)
  select new.id, cell, res
  from h3_polygon_to_cells(new.geom::geometry, res) as cell
  on conflict do nothing;

  return new;
end;
$$;

create trigger areas_derive_cells
after insert or update of geom on public.areas
for each row execute function public.derive_area_cells();
