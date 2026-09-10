# Architecture

Decisions and the reasoning behind them. Update this when a decision changes; do not delete the old entry, mark it superseded.

## Map engine — MapLibre GL JS

Open source fork of Mapbox GL JS, BSD-3. Vector tiles, WebGL, no API key, no usage ceiling. Mapbox GL JS went proprietary at v2 and its licence terms would need revisiting if this is ever commercialised.

Trade-off: smaller plugin ecosystem than Mapbox. Nothing the MVP needs is missing.

## Basemap tiles — Protomaps, self-hosted

A single `.pmtiles` file served over HTTP range requests. No tile server process, no per-request cost, works from static hosting or from a service worker cache.

Why not MapTiler or Mapbox: their free tiers exclude commercial use. This project may be commercialised, so the licence is a day-one constraint rather than a later problem.

Trade-off: you build and host the London extract yourself, and refresh it manually when OSM data ages. Acceptable — neighbourhood geometry changes slowly.

Attribution: OpenStreetMap contributors, required and non-negotiable, rendered on the map.

## Drawing — Terra Draw

Adapter-based, so the drawing layer is not coupled to MapLibre. Clean mode API for adding a brush mode later without rewriting the polygon path.

Why not mapbox-gl-draw: tied to one engine, and its licence follows Mapbox.

## Geometry model — polygon is truth, H3 is index

Every area is stored as a polygon. H3 cells are derived from that polygon on write and stored in `area_cells`.

This is the central decision in the project. Two consequences:

1. **Later brush painting is additive, not a migration.** A brush writes cells directly and synthesises a polygon; the existing polygon-first records keep working unchanged.
2. **Joins against open data become cheap.** TfL journey times, Ordnance Survey green space, DEFRA noise — all can be bucketed to H3 and joined on `h3_index` without spatial predicates.

Cells are always recomputable from geometry. If the two ever disagree, geometry wins and cells get rebuilt.

Resolution 10 by default (~65 m edge). Stored per row so a future change is detectable.

## No geometry union

Overlapping areas are not merged, clipped or intersected. They render semi-transparent with the most recent on top.

This is a deliberate refusal. Boolean geometry operations bring self-intersection repair, winding-order bugs and slivers, and they buy nothing for a tool where overlap carries real meaning — "this street is nice" and "this whole block is quiet" are both true and should both persist.

## Backend — Supabase

Postgres with PostGIS and H3 extensions, plus auth and row-level security in one service. Single-user today, but multi-user later is a `user_id` filter that already exists rather than a rebuild.

RLS is enabled from the first migration. Retrofitting it onto a populated table is where data leaks happen.

Trade-off: hosted dependency. Mitigated by the fact that everything is standard Postgres and exportable as GeoJSON.

## Cell derivation runs server side

A trigger (or edge function) on insert/update of `areas.geom` populates `area_cells`.

Not client side: an offline client, a stale build or a second client would each produce a slightly different index, and the drift is silent. Server-side derivation means one implementation and one truth.

**Superseded (2026-09-10).** The "trigger" half of this never became real: `h3` / `h3_postgis` are not available as Postgres extensions in any Supabase Postgres image, local or hosted — verified directly against `supabase/postgres:17.6.1.167` and `:15.14.1.170`, and against upstream (feature requests `supabase/postgres#245` and `#664`, org discussion `#9687`, open and unresolved since 2022). A `h3_polygon_to_cells` trigger cannot exist on this stack. The "or edge function" alternative this section already named is now the actual, single implementation: `supabase/functions/save-area` uses `h3-js` to compute the cell set and is the sole write path for `areas`. `area_cells.h3_index` is plain `text` (h3-js's hex string), not the `h3index` type. The invariant this section argues for is unchanged — one server-side implementation, one truth — direct client writes to `areas` are still blocked by RLS; only the edge function, running with the caller's JWT, can write successfully.

## Delivery — PWA

Requirements are geolocation, touch input and offline tile cache. All three are web platform features. A native shell adds app store review, two codebases and signing overhead for no capability gain.

Trade-off: iOS PWA install is a worse flow than an App Store download. Revisit only if the tool gets external users.

## Offline writes are queued, never dropped

A save made underground on the Tube must survive. Writes go to a local queue first and flush when connectivity returns. The UI reflects queued state honestly rather than showing a success it cannot guarantee.

## Rating dimensions — schema now, UI later

`areas.dimension` exists from the first migration, hardcoded to `'overall'`.

The reason is that the migration in the other direction is lossy. If every area has a single rating and you later split into pleasantness, noise and safety, you cannot recover which dimension an old `+1` referred to. That is fieldwork you would have to redo. One column now costs nothing.

`rating` is constrained to -2..2 at the database level while the MVP UI emits only -1, 0, 1. Widening the scale is a UI change with no migration.
