// Point and line features (public.map_features) — docs/OBJECTIVES.md § G9.
//
// A separate module from src/db/client.ts rather than more exports on it. Two reasons,
// in order: `areas` and `map_features` are separate tables behind separate write paths
// (save-area / save-feature), so nothing here shares code with the area functions beyond
// the client itself; and client.ts is the module G7 put on a lazy-import diet, which is
// easier to keep honest if feature support does not accrete onto it.
//
// The Supabase client is reached through `getSupabase()` so this module inherits that
// same deferral — importing it does not drag @supabase/supabase-js onto the critical path.
import { getSupabase, OfflineWriteError } from "./client";
import type { Database } from "./types";

const env = import.meta.env as Record<string, string | undefined>;
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

export type FeatureKind = "point" | "line";

export type PointGeometry = { type: "Point"; coordinates: number[] };
export type LineGeometry = { type: "LineString"; coordinates: number[][] };
export type FeatureGeometry = PointGeometry | LineGeometry;

// What `kind` each geometry type must be stored as, and the reverse. The database
// enforces the pairing too (map_features_geom_matches_kind, migration 0008); this is the
// client-side half so a mismatch never leaves the browser.
const KIND_FOR_GEOMETRY: Record<FeatureGeometry["type"], FeatureKind> = {
  Point: "point",
  LineString: "line",
};

export function kindForGeometry(geometry: FeatureGeometry): FeatureKind {
  return KIND_FOR_GEOMETRY[geometry.type];
}

export type SaveFeatureInput = {
  id: string;
  geom: FeatureGeometry;
  kind: FeatureKind;
  rating: number;
  comment?: string | null;
};

export type SaveFeatureResult = {
  feature: Database["public"]["Tables"]["map_features"]["Row"];
};

// The sole write path for `map_features` — supabase/functions/save-feature/index.ts.
// Since migration 0009 that is a grant, not a convention: INSERT and UPDATE are revoked
// from the client roles. Upserts on `id`, so posting the same client-generated uuid twice
// is idempotent, which is what makes the offline queue's retry safe.
export async function saveFeature(input: SaveFeatureInput): Promise<SaveFeatureResult> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.functions.invoke<SaveFeatureResult>("save-feature", {
    body: input,
  });
  if (error) {
    // Same distinction src/db/client.ts draws for areas: a genuine "could not reach the
    // server" is queueable, anything else (validation, auth) is a real failure that would
    // fail identically on flush. Resolves from the already-loaded module.
    const { FunctionsFetchError } = await import("@supabase/supabase-js");
    if (error instanceof FunctionsFetchError) throw new OfflineWriteError(error);
    throw error;
  }
  return data as SaveFeatureResult;
}

export type MapFeature = {
  type: "Feature";
  geometry: FeatureGeometry;
  properties: {
    id: string;
    kind: FeatureKind;
    rating: number;
    comment: string | null;
    created_at: string;
  };
};

// Same `Accept: application/geo+json` trick fetchAreas uses: PostgREST returns geography
// as WKB hex by default, and asking for geo+json makes it do the ST_AsGeoJSON conversion
// server side rather than pulling a WKB parser into the bundle.
export async function fetchFeatures(): Promise<MapFeature[]> {
  const supabase = await getSupabase();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) return [];

  const res = await fetch(
    `${supabaseUrl}/rest/v1/map_features?select=id,kind,rating,comment,created_at,geom&order=created_at.asc`,
    {
      headers: {
        apikey: supabaseAnonKey as string,
        Authorization: `Bearer ${token}`,
        Accept: "application/geo+json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`fetchFeatures failed: ${res.status} ${await res.text()}`);
  }
  const geojson = (await res.json()) as { features: MapFeature[] };
  return geojson.features;
}

// Deletes go direct, as whole-area deletes do. Migration 0009 keeps DELETE granted for
// exactly this: a feature owns no derived rows, so there is nothing for a cascade —
// or for save-feature — to clean up.
export async function deleteFeature(id: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.from("map_features").delete().eq("id", id);
  if (error) throw error;
}
