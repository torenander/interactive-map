-- G2 migration 0004 — row-level security. Verbatim from docs/DATA-MODEL.md § Migration 0004.
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
