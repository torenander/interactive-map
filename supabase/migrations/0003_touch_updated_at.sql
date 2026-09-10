-- G2 migration 0003 — updated_at maintenance. Verbatim from docs/DATA-MODEL.md § Migration 0003.
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
