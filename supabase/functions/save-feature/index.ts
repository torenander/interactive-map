// save-feature — the sole write path for public.map_features.
//
// Mirrors supabase/functions/save-area/index.ts deliberately: same auth posture, same
// idempotency contract, same single generic response for every unwritable id. Where it
// differs from save-area it is because points and lines derive no H3 cells
// (docs/OBJECTIVES.md § G9 out_of_scope), so there is no cell budget, no bbox pre-check
// and no wholesale cell replacement — the write is one statement.
//
// Runs with the CALLER's JWT (not the service role), forwarded from the incoming
// request's Authorization header, so RLS (supabase/migrations/0008_map_features.sql)
// governs every read here exactly as it would for a direct client call. The write itself
// goes through save_feature_tx, which is SECURITY DEFINER and re-checks ownership
// itself — see supabase/migrations/0009_save_feature_tx.sql.
//
// Contract: POST { id, geom, kind, rating, comment? }
//   id      — client-generated uuid; also map_features.id, so a retried call is idempotent.
//   geom    — GeoJSON Point or LineString (lng/lat), matching `kind`.
//   kind    — 'point' | 'line'.
//   rating  — -1 | 0 | 1 from the MVP UI (DB allows -2..2, see migration 0008).
//   comment — optional text, 2,000 characters max.
//
// Deletes are NOT routed through this function: a feature owns no derived rows, so a
// direct client delete has nothing to leave behind. DELETE stays granted for that reason.
import { createClient } from "npm:@supabase/supabase-js@2";

// Mirrors `map_features_comment_check` in migration 0008, so an over-length comment comes
// back as a clean 422 rather than a constraint violation surfacing as a 400.
const MAX_COMMENT_CHARS = 2000;

// One response for every "you cannot write this id" outcome, whatever the underlying
// reason — another user's row, or one RLS would refuse. 404 rather than 403 on purpose:
// 403 would itself confirm the row exists. Carried over from save-area, including its
// documented residual: a successful save still returns 200, so "free id" and "your own
// id" remain distinguishable from "somebody else's id" by status alone.
const NOT_WRITABLE_STATUS = 404;
const NOT_WRITABLE_BODY = { error: "Feature not found or not writable" };

const KINDS = ["point", "line"] as const;
type Kind = (typeof KINDS)[number];

// What each kind must be carrying. The database enforces this too
// (map_features_geom_matches_kind), but a constraint violation reaches the client as an
// opaque 400; checking here produces a 422 that says which half disagreed.
const GEOMETRY_FOR_KIND: Record<Kind, string> = {
  point: "Point",
  line: "LineString",
};

type SaveFeatureRequest = {
  id: string;
  geom: { type: string; coordinates: unknown };
  kind: Kind;
  rating: number;
  comment?: string | null;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isValidRequest(body: unknown): body is SaveFeatureRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) return false;
  if (typeof b.kind !== "string" || !KINDS.includes(b.kind as Kind)) return false;
  if (typeof b.rating !== "number" || !Number.isInteger(b.rating)) return false;
  const geom = b.geom as Record<string, unknown> | undefined;
  if (!geom || typeof geom.type !== "string" || !Array.isArray(geom.coordinates)) return false;
  if (b.comment !== undefined && b.comment !== null && typeof b.comment !== "string") {
    return false;
  }
  return true;
}

function isPosition(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

// Returns the reason the geometry is unusable, or null if it is fine. Shape is checked
// as well as type: a LineString of one point, or of anything other than positions, is
// accepted by `Array.isArray` and then fails deep inside PostGIS.
function geometryProblem(geom: SaveFeatureRequest["geom"], kind: Kind): string | null {
  const expected = GEOMETRY_FOR_KIND[kind];
  if (geom.type !== expected) {
    return `kind '${kind}' requires a GeoJSON ${expected}, got ${geom.type}`;
  }
  const coordinates = geom.coordinates as unknown[];
  if (kind === "point") {
    return isPosition(coordinates) ? null : "Point coordinates must be [lng, lat]";
  }
  if (coordinates.length < 2) {
    return "LineString needs at least two positions";
  }
  return coordinates.every(isPosition)
    ? null
    : "LineString coordinates must all be [lng, lat]";
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
    return jsonResponse(
      { error: "Expected { id, geom: GeoJSON Point|LineString, kind: 'point'|'line', rating, comment? }" },
      400,
    );
  }

  // Guards run BEFORE the write, so a rejected request never reaches the table.
  if ((body.comment ?? "").length > MAX_COMMENT_CHARS) {
    return jsonResponse(
      { error: `Comment is too long: limit ${MAX_COMMENT_CHARS} characters.` },
      422,
    );
  }
  const problem = geometryProblem(body.geom, body.kind);
  if (problem) {
    return jsonResponse({ error: `Geometry does not match kind: ${problem}` }, 422);
  }

  // user_id is set from auth.uid() inside the function, so it cannot be spoofed here.
  const { data: feature, error: rpcError } = await supabase
    .rpc("save_feature_tx", {
      p_id: body.id,
      p_geom_geojson: body.geom,
      p_kind: body.kind,
      p_rating: body.rating,
      p_comment: body.comment ?? null,
    })
    .select()
    .single();

  if (rpcError) {
    // 42501 is insufficient_privilege — what save_feature_tx raises when the target row
    // belongs to somebody else and when the caller is unauthenticated, and what RLS
    // itself raises on the direct-table paths. Normalised so none of them can be told
    // apart from any other unwritable id.
    if (rpcError.code === "42501" || /row-level security/i.test(rpcError.message ?? "")) {
      return jsonResponse(NOT_WRITABLE_BODY, NOT_WRITABLE_STATUS);
    }
    return jsonResponse({ error: rpcError.message }, 400);
  }

  return jsonResponse({ feature }, 200);
});
