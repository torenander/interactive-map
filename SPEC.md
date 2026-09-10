# areamap — project spec

Personal map annotation tool for evaluating neighbourhoods during a property search in London. Draw a polygon around an area, attach a rating and a comment, come back to it later.

Working name `areamap`. Rename before first commit if you want something else.

## Scope

**MVP (this is what gets built first):**
- Map, pan/zoom, geolocation
- Draw one polygon at a time
- On completion: modal for rating (-1 / 0 / +1) and free-text comment
- Persist to Supabase
- Click an existing polygon to read, edit or delete it
- Overlapping polygons render semi-transparent, most recent on top. No geometry union, no clipping.

**Deliberately out of scope for MVP:**
- Brush painting of H3 cells
- Point and line features
- Multiple rating dimensions
- Sharing, multi-user, comments from others
- Open data overlays (TfL, OS, DEFRA)

**Built in now purely to avoid a later migration:**
- `dimension` column on every record, hardcoded to `'overall'`
- H3 cell sidecar table populated on save

Do not build UI for either. They are schema only.

## Architecture

| Concern | Choice |
|---|---|
| Map engine | MapLibre GL JS |
| Basemap tiles | Protomaps `.pmtiles`, self-hosted, London extract from OSM |
| Drawing | Terra Draw, polygon mode |
| Framework | Vite + React + TypeScript |
| Styling | Tailwind |
| Backend | Supabase (Postgres + PostGIS + Auth + RLS) |
| Spatial indexing | `h3-js` client side, `h3` extension server side (**Superseded (2026-09-10):** no `h3` extension exists on Supabase Postgres; `h3-js` in the `save-area` edge function is the sole server-side implementation — see `docs/ARCHITECTURE.md`) |
| Delivery | PWA (`vite-plugin-pwa`), installable, offline tile cache |

Rationale for the non-obvious ones:

- **Protomaps over MapTiler**: single self-hosted `.pmtiles` file, OSM-derived, free for commercial use. MapTiler's free tier is not. This project may be commercialised, so the licence matters from day one.
- **Terra Draw over mapbox-gl-draw**: less coupled to a single map engine, cleaner mode API.
- **Polygon is the source of truth, H3 is an index.** Cells are derived on save and can be recomputed. Never edit cells directly.
- **PWA over native**: the requirements are geolocation, touch and offline cache. Nothing needs a native runtime.

## Data model

See `docs/DATA-MODEL.md` for the full schema and migrations.

Summary:
- `public.areas` — one row per drawn area. `geography(Polygon, 4326)`, rating, comment, `dimension`, `user_id`.
- `public.area_cells` — derived H3 index, recomputable from `areas.geom`, populated by a trigger. **Superseded (2026-09-10):** populated by the `save-area` edge function, not a trigger — see `docs/ARCHITECTURE.md`.

## Field UX constraints

The primary use is standing on a street in London holding a phone in one hand. This is not a desktop tool with a mobile view.

- Thumb-reachable controls, bottom third of the screen
- Undo on the last drawn vertex, and undo on the last saved area
- "Centre on me" button always visible
- The rating modal must be dismissible with one thumb and must not lose the drawn geometry if dismissed
- Offline: London basemap tiles precached; writes queued locally and flushed when back online. Do not silently drop a save.

## Definition of done for MVP

See `docs/OBJECTIVES.md`. Each goal there has runnable exit criteria; that file is authoritative over this section.
