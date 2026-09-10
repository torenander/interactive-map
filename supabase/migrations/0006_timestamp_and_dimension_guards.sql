-- G-fix migration 0006 — server-owned timestamps, pinned dimension.
--
-- Two holes an authenticated client could drive a truck through, both reachable with a
-- plain PostgREST call (no edge function involved), both reproduced against the local
-- stack:
--
--   * public.touch_updated_at fired BEFORE UPDATE only (migration 0003), so a direct
--     INSERT could set created_at and updated_at to any value the client liked — a
--     backdated or future-dated row. docs/DATA-MODEL.md § Client-side write queue says
--     the flush is "last-write-wins on updated_at", which is only meaningful if
--     updated_at is a server clock reading. Now it always is: forced on insert as well
--     as update, and created_at is frozen to its original value on update.
--   * areas.dimension defaulted to 'overall' but accepted any text, so a PATCH could set
--     it to 'noise'. CLAUDE.md pins dimension to 'overall' and forbids rating-dimension
--     UI; a check constraint makes the pin real instead of conventional.
--
-- Widening dimension later is one migration: drop this constraint and replace it with a
-- check against the allowed set (or an enum). Nothing else in the schema assumes the
-- single value.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    -- created_at is immutable once written; ignore whatever the client sent.
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists areas_touch_updated_at on public.areas;

create trigger areas_touch_updated_at
before insert or update on public.areas
for each row execute function public.touch_updated_at();

alter table public.areas
  add constraint areas_dimension_overall check (dimension = 'overall');
