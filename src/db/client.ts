// Typed Supabase client + email auth. No UI — see docs/OBJECTIVES.md § G2 out_of_scope.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const env = import.meta.env as Record<string, string | undefined>;

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.",
  );
}

export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey,
);

export async function signUpWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
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
  const { data, error } = await supabase.functions.invoke<SaveAreaResult>("save-area", {
    body: input,
  });
  if (error) throw error;
  return data as SaveAreaResult;
}
