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
// Upserts the area row, then replaces area_cells wholesale for that area — deleting the
// previous set before inserting the newly computed one, never appending to it.
//
// Deletes are NOT routed through this function: `on delete cascade` on
// area_cells.area_id (migration 0001) removes cells for free when a client deletes an
// area row directly.
import { createClient } from "npm:@supabase/supabase-js@2";
import { polygonToCells } from "npm:h3-js@4";

const RESOLUTION = 10;

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

function ringToWkt(ring: number[][]): string {
  return `(${ring.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`;
}

function polygonToEwkt(geom: SaveAreaRequest["geom"]): string {
  return `SRID=4326;POLYGON(${geom.coordinates.map(ringToWkt).join(", ")})`;
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
  const userId = userData.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!isValidRequest(body)) {
    return jsonResponse({ error: "Expected { id, geom: GeoJSON Polygon, rating, comment? }" }, 400);
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

  const { data: area, error: areaError } = await supabase
    .from("areas")
    .upsert(
      {
        id: body.id,
        user_id: userId,
        geom: polygonToEwkt(body.geom),
        dimension: "overall",
        rating: body.rating,
        comment: body.comment ?? null,
      },
      { onConflict: "id" },
    )
    .select()
    .single();
  if (areaError) {
    return jsonResponse({ error: areaError.message }, 400);
  }

  // Replace the cell set wholesale: delete the previous set, then insert the new one.
  // Not wrapped in a single DB transaction (two round trips) — acceptable for now per
  // docs/DATA-MODEL.md's single-user, last-write-wins model; a failed insert after a
  // successful delete would leave an area with zero cells, recoverable by saving again.
  const { error: deleteError } = await supabase.from("area_cells").delete().eq("area_id", body.id);
  if (deleteError) {
    return jsonResponse({ error: deleteError.message }, 400);
  }

  const { error: insertError } = await supabase.from("area_cells").insert(
    cells.map((h3_index) => ({ area_id: body.id, h3_index, resolution: RESOLUTION })),
  );
  if (insertError) {
    return jsonResponse({ error: insertError.message }, 400);
  }

  return jsonResponse({ area, cellCount: cells.length }, 200);
});
