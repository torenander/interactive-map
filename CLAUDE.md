# areamap

Personal map annotation tool for rating London neighbourhoods during a property search. Full spec: `SPEC.md`.

## Stack

MapLibre GL JS, Protomaps pmtiles, Terra Draw, Vite, React, TypeScript, Tailwind, Supabase, PostGIS, h3-js, vite-plugin-pwa

## Rules

- Work from `docs/OBJECTIVES.md`. Never mark a goal done without running its `done_when` commands, and never weaken one to make it pass.
- Never tick a task box for work you have not watched run.
- Do not build anything under a goal's `out_of_scope` or under "Not goals".
- `areas.geom` is the source of truth; `area_cells` is derived. If they disagree, rebuild the cells from geometry.
- All writes to `areas` go through the `save-area` edge function — the one place cells are derived (h3-js, server side). Never write `areas` or `area_cells` directly from the client; deletes of whole areas are the only direct call (FK cascade cleans cells).
- `dimension` stays `'overall'`. No rating-dimension UI.
- `rating` is -2..2 in the database; the UI emits only -1, 0, +1.
- No geometry union, clipping or self-intersection repair. Overlap is a rendering concern: semi-transparent, newest on top.
- Schema changes go through `supabase/migrations/`, never the Supabase dashboard. Regenerate `src/db/types.ts` after every migration.
- RLS is enabled in the migration that creates a table, not later.
- Mobile viewport 390x844 is the primary target. Verify there before desktop.
- Never render a save as complete before the server has it. Offline writes queue in IndexedDB under a client-generated uuid.
- OpenStreetMap attribution renders on the map. Do not remove it.

## Commands

```bash
npm run dev
npm run build
npm run test
npm run test:e2e
npx supabase db reset
```

## Docs

- `docs/OBJECTIVES.md` — what to build next, and the exit criteria that decide when it is done.
- `docs/ARCHITECTURE.md` — why each technology and geometry decision was made.
- `docs/DATA-MODEL.md` — schema, migrations 0001–0004, write queue, GeoJSON export.
- `docs/TESTING.md` — what is tested, what deliberately is not, and the test commands.
- `docs/CLAUDE-MD-INSTRUCTIONS.md` — the rules this file is written against.
