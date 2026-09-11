// Typed Supabase client + email auth. No UI — see docs/OBJECTIVES.md § G2 out_of_scope.
//
// G7: the client is created on first use rather than at module load, and
// `@supabase/supabase-js` is reached through a dynamic import. Statically it
// sat in the entry chunk — 54,627 B gzip of auth, realtime and postgrest that
// the map does not need to paint, on a critical path measured at 449,088 B.
// Nothing here is needed before the map exists: the basemap is self-hosted and
// renders signed out (see the note in src/App.tsx).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const env = import.meta.env as Record<string, string | undefined>;

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.",
  );
}

// One client per session, created lazily and shared. The promise itself is
// cached, not just the resolved client, so concurrent first callers await the
// same import instead of racing two `createClient` calls — two clients would
// mean two auth subscriptions and two token refresh timers.
let clientPromise: Promise<SupabaseClient<Database>> | null = null;

export function getSupabase(): Promise<SupabaseClient<Database>> {
  if (!clientPromise) {
    clientPromise = import("@supabase/supabase-js").then(({ createClient }) =>
      createClient<Database>(supabaseUrl as string, supabaseAnonKey as string),
    );
  }
  return clientPromise;
}

// Raised when `save-area` could not be reached at all, as opposed to refusing
// the write. Callers queue on this and surface anything else as a real
// failure. It exists so the distinction does not require importing
// `FunctionsFetchError` — that import is exactly what this module is keeping
// off the critical path, and re-exporting the vendor error class would drag it
// straight back into every caller's chunk.
export class OfflineWriteError extends Error {
  constructor(cause: unknown) {
    super("save-area could not be reached");
    this.name = "OfflineWriteError";
    this.cause = cause;
  }
}

export async function signUpWithEmail(email: string, password: string) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signInWithEmail(email: string, password: string) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// The sole write path for `areas` — see supabase/functions/save-area/index.ts and
// docs/ARCHITECTURE.md § "Cell derivation runs server side" for why this isn't a direct
// table write. Upserts on `id`, so passing the same client-generated uuid twice is
// idempotent (docs/DATA-MODEL.md's offline write queue contract).
export type SaveAreaInput = {
  id: string;
  geom: { type: "Polygon"; coordinates: number[][][] };
  rating: number;
  comment?: string | null;
};

export type SaveAreaResult = {
  area: Database["public"]["Tables"]["areas"]["Row"];
  cellCount: number;
};

export async function saveArea(input: SaveAreaInput): Promise<SaveAreaResult> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.functions.invoke<SaveAreaResult>("save-area", {
    body: input,
  });
  if (error) {
    // Resolves from the already-loaded module — `getSupabase` above awaited
    // the same import, so this costs a microtask, not a request.
    const { FunctionsFetchError } = await import("@supabase/supabase-js");
    if (error instanceof FunctionsFetchError) throw new OfflineWriteError(error);
    throw error;
  }
  return data as SaveAreaResult;
}

// Reading areas back: `areas.geom` is `geography(Polygon, 4326)`. PostgREST returns
// geography columns as WKB hex by default — confirmed empirically against the local
// stack — but requesting the table with `Accept: application/geo+json` makes PostgREST
// do the ST_AsGeoJSON conversion server side and return a real GeoJSON FeatureCollection.
// That avoids pulling in a WKB parser just to read shapes back. `deletes` are the one
// direct client write per CLAUDE.md; everything else still goes through save-area.
export type AreaFeature = {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: {
    id: string;
    rating: number;
    comment: string | null;
    created_at: string;
  };
};

export async function fetchAreas(): Promise<AreaFeature[]> {
  const supabase = await getSupabase();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) return [];

  const res = await fetch(
    `${supabaseUrl}/rest/v1/areas?select=id,rating,comment,created_at,geom&order=created_at.asc`,
    {
      headers: {
        apikey: supabaseAnonKey as string,
        Authorization: `Bearer ${token}`,
        Accept: "application/geo+json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`fetchAreas failed: ${res.status} ${await res.text()}`);
  }
  const geojson = (await res.json()) as { features: AreaFeature[] };
  return geojson.features;
}

// The one direct write against `areas` — CLAUDE.md allows whole-area deletes to bypass
// save-area since the FK cascade on area_cells (migration 0001) cleans up cells for free.
export async function deleteArea(id: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.from("areas").delete().eq("id", id);
  if (error) throw error;
}
