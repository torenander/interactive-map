// save-area — the sole write path for public.areas.
//
// Why this exists: h3 / h3_postgis are not available as Postgres extensions in any
// Supabase Postgres image, local or hosted (verified 2026-09-10 — see
// docs/ARCHITECTURE.md § "Cell derivation runs server side", superseded note, and
// supabase/migrations/0002_derive_cells.sql). Cell derivation that would have been a
// Postgres trigger happens here instead, using h3-js. This keeps the invariant that
// matters — one server-side implementation, no client-computed cells — without a
// Postgres extension that does not exist on this stack.
//
// Runs with the CALLER's JWT (not the service role), forwarded from the incoming
// request's Authorization header, so RLS (supabase/migrations/0004_rls.sql) still
// governs every read and write here exactly as it would for a direct client call.
//
// Contract: POST { id, geom, rating, comment? }
//   id      — client-generated uuid; also the areas.id, so a retried call is idempotent.
//   geom    — GeoJSON Polygon (lng/lat, closed rings), matching areas.geom.
//   rating  — -1 | 0 | 1 from the MVP UI (DB allows -2..2, see migration 0001).
//   comment — optional text.
//
// The row write and the wholesale cell replacement are ONE call to
// public.save_area_tx (supabase/migrations/0005_atomic_area_write.sql), so they are one
// transaction. The old shape — upsert, then delete cells, then insert cells, as three
// PostgREST round trips — could die between statements (leaving an updated row with zero
// cells) and could interleave with a concurrent save of the same id (leaving cells from
// two geometries mixed together). Both are fixed in the database, not here; this function
// only computes the cell set and hands it over.
//
// Deletes are NOT routed through this function: `on delete cascade` on
// area_cells.area_id (migration 0001) removes cells for free when a client deletes an
// area row directly.
import { createClient } from "npm:@supabase/supabase-js@2";
import { polygonToCells } from "npm:h3-js@4";

const RESOLUTION = 10;

// Cell budget. Two numbers, both derived from what actually breaks:
//
//   * An H3 res-10 hexagon averages ~0.0150 km². A 0.15° x 0.15° bbox at London's
//     latitude is ~172 km² ≈ 11.5k cells and saved fine; ~0.2° (~20k cells) killed the
//     edge worker with 546 WORKER_LIMIT part-way through writing, which is the whole
//     reason the write is now one transaction.
//   * MAX_CELLS is set an order of magnitude below the failure point rather than just
//     under it. 5,000 res-10 cells ≈ 75 km², an ~8.7 km square — larger than the London
//     borough of Kensington and Chelsea (12 km²). SPEC.md's use case is rating
//     neighbourhoods during a property search; nothing in it needs a single annotation
//     bigger than a borough. A generous cap that never fires in normal use beats a tight
//     one that fires on a legitimate area.
//   * BBOX_ESTIMATE_LIMIT (4x MAX_CELLS) is the cheap pre-check that runs BEFORE
//     polygonToCells, so an absurd polygon never gets to allocate its cell array at all.
//     It is deliberately loose because a bbox over-estimates a thin or diagonal polygon;
//     anything between the two limits is caught by the exact count below.
const MAX_CELLS = 5_000;
const BBOX_ESTIMATE_LIMIT = MAX_CELLS * 4;
const RES10_CELL_AREA_KM2 = 0.0150;
const KM_PER_DEGREE = 111.32;

// One response for every "you cannot write this id" outcome, whatever the underlying
// reason. Previously an id belonging to another user produced a verbatim Postgres RLS
// error ("new row violates row-level security policy ... areas") while a free id
// produced a 200, which let a signed-in user probe whether any given uuid was somebody
// else's area. Now every unauthorised-write path — another user's row, a row RLS will
// not let us update — returns exactly this pair. 404 rather than 403 on purpose: 403
// would itself confirm the row exists.
//
// Residual, and documented rather than papered over: a successful save still returns 200,
// so "free id" and "your own id" remain distinguishable from "somebody else's id" by
// status alone. That is inherent to an upsert endpoint that must actually report whether
// it wrote; what is closed here is the message-level oracle and the 403/404 distinction.
const NOT_WRITABLE_STATUS = 404;
const NOT_WRITABLE_BODY = { error: "Area not found or not writable" };

type SaveAreaRequest = {
  id: string;
  geom: { type: "Polygon"; coordinates: number[][][] };
  rating: number;
  comment?: string | null;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isValidRequest(body: unknown): body is SaveAreaRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) return false;
  if (typeof b.rating !== "number" || !Number.isInteger(b.rating)) return false;
  const geom = b.geom as Record<string, unknown> | undefined;
  if (!geom || geom.type !== "Polygon" || !Array.isArray(geom.coordinates)) return false;
  if (b.comment !== undefined && b.comment !== null && typeof b.comment !== "string") {
    return false;
  }
  return true;
}

// Rough cell count for the polygon's bounding box: degrees -> km (latitude-corrected) ->
// km² -> cells. Over-estimates any polygon that does not fill its bbox, which is the safe
// direction for a pre-check.
function estimateBboxCells(geom: SaveAreaRequest["geom"]): number {
  const ring = geom.coordinates[0];
  if (!Array.isArray(ring) || ring.length === 0) return 0;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const point of ring) {
    const [lng, lat] = point as number[];
    if (typeof lng !== "number" || typeof lat !== "number") return 0;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const heightKm = (maxLat - minLat) * KM_PER_DEGREE;
  const widthKm = (maxLng - minLng) * KM_PER_DEGREE * Math.max(Math.cos(midLat), 0.01);
  return (heightKm * widthKm) / RES10_CELL_AREA_KM2;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST only" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return jsonResponse({ error: "Function is missing SUPABASE_URL / SUPABASE_ANON_KEY" }, 500);
  }

  // Scoped to the caller's JWT — every subsequent query is subject to RLS as that user,
  // not the service role.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!isValidRequest(body)) {
    return jsonResponse({ error: "Expected { id, geom: GeoJSON Polygon, rating, comment? }" }, 400);
  }

  // Guards run BEFORE any write. The failure they replace was not a clean rejection: the
  // worker died mid-sequence, after the row had been updated and its cells deleted.
  if (estimateBboxCells(body.geom) > BBOX_ESTIMATE_LIMIT) {
    return jsonResponse(
      {
        error:
          `Polygon is too large: its bounding box alone exceeds ${BBOX_ESTIMATE_LIMIT} H3 ` +
          `cells at resolution ${RESOLUTION} (limit ${MAX_CELLS} cells, ~75 km²). Draw a ` +
          `smaller area.`,
      },
      422,
    );
  }

  let cells: string[];
  try {
    cells = polygonToCells(body.geom.coordinates, RESOLUTION, true);
  } catch (err) {
    return jsonResponse({ error: `Could not derive H3 cells: ${String(err)}` }, 422);
  }
  if (cells.length === 0) {
    return jsonResponse({ error: "Polygon resolves to zero H3 cells at resolution 10" }, 422);
  }
  if (cells.length > MAX_CELLS) {
    return jsonResponse(
      {
        error:
          `Polygon is too large: ${cells.length} H3 cells at resolution ${RESOLUTION}, ` +
          `limit ${MAX_CELLS} (~75 km²). Draw a smaller area.`,
      },
      422,
    );
  }

  // One transaction: upsert the row, delete its cells, insert the new set. See
  // supabase/migrations/0005_atomic_area_write.sql. user_id is set from auth.uid() inside
  // the function, so it cannot be spoofed from here either.
  const { data: area, error: rpcError } = await supabase
    .rpc("save_area_tx", {
      p_id: body.id,
      p_geom_geojson: body.geom,
      p_rating: body.rating,
      p_comment: body.comment ?? null,
      p_cells: cells,
      p_resolution: RESOLUTION,
    })
    .select()
    .single();

  if (rpcError) {
    // 42501 is insufficient_privilege — what RLS raises when the upsert would touch a row
    // this caller does not own, and what save_area_tx raises for an unauthenticated
    // caller. Normalised so it cannot be told apart from any other unwritable id.
    if (rpcError.code === "42501" || /row-level security/i.test(rpcError.message ?? "")) {
      return jsonResponse(NOT_WRITABLE_BODY, NOT_WRITABLE_STATUS);
    }
    return jsonResponse({ error: rpcError.message }, 400);
  }

  return jsonResponse({ area, cellCount: cells.length }, 200);
});
