// Schema constraints against a local Supabase instance — docs/OBJECTIVES.md § G2 done_when,
// docs/TESTING.md "Schema constraints ... (checks, cascades, RLS isolation)".
//
// Requires the local stack running and migrated:
//   npx supabase start
//   npx supabase db reset
//
// Connection details are read from `supabase status -o env` rather than hardcoded, so this
// works against whatever ports/keys the local stack actually has.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/db/types";

function readLocalSupabaseEnv(): Record<string, string> {
  let raw: string;
  try {
    raw = execFileSync("npx", ["supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "Could not read `supabase status -o env`. Is the local stack running? " +
        "Run `npx supabase start` and `npx supabase db reset` first.\n" +
        String(err),
    );
  }

  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}

// Two small polygons far enough apart that they share no H3 res-10 cells:
// Trafalgar Square area, and Greenwich, a few km east.
const POLY_TRAFALGAR =
  "SRID=4326;POLYGON((-0.1280 51.5070, -0.1270 51.5070, -0.1270 51.5080, -0.1280 51.5080, -0.1280 51.5070))";
const POLY_GREENWICH =
  "SRID=4326;POLYGON((-0.0100 51.4780, -0.0090 51.4780, -0.0090 51.4790, -0.0100 51.4790, -0.0100 51.4780))";

describe("G2 schema constraints", () => {
  let admin: SupabaseClient<Database>;
  let anonUrl: string;
  let anonKey: string;
  let userA: { id: string; email: string; password: string };
  let userB: { id: string; email: string; password: string };
  let clientA: SupabaseClient<Database>;
  let clientB: SupabaseClient<Database>;
  const createdAreaIds: string[] = [];

  async function signedInClient(email: string, password: string) {
    const client = createClient<Database>(anonUrl, anonKey);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  beforeAll(async () => {
    const env = readLocalSupabaseEnv();
    const apiUrl = env.API_URL ?? env.SUPABASE_URL;
    const serviceRoleKey = env.SERVICE_ROLE_KEY;
    anonUrl = apiUrl;
    anonKey = env.ANON_KEY;
    if (!apiUrl || !serviceRoleKey || !anonKey) {
      throw new Error(
        `Missing API_URL/SERVICE_ROLE_KEY/ANON_KEY from \`supabase status -o env\`. Got keys: ${Object.keys(env).join(", ")}`,
      );
    }

    admin = createClient<Database>(apiUrl, serviceRoleKey);

    const password = "correct-horse-battery-staple";
    const emailA = `schema-test-a-${randomUUID()}@example.com`;
    const emailB = `schema-test-b-${randomUUID()}@example.com`;

    const { data: createdA, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (errA || !createdA.user) throw errA ?? new Error("user A not created");
    const { data: createdB, error: errB } = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (errB || !createdB.user) throw errB ?? new Error("user B not created");

    userA = { id: createdA.user.id, email: emailA, password };
    userB = { id: createdB.user.id, email: emailB, password };

    clientA = await signedInClient(userA.email, userA.password);
    clientB = await signedInClient(userB.email, userB.password);
  });

  afterAll(async () => {
    if (createdAreaIds.length > 0) {
      await admin.from("areas").delete().in("id", createdAreaIds);
    }
    if (userA) await admin.auth.admin.deleteUser(userA.id);
    if (userB) await admin.auth.admin.deleteUser(userB.id);
  });

  it("inserting an area populates area_cells with at least one row", async () => {
    const { data: area, error } = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: POLY_TRAFALGAR, rating: 1 })
      .select()
      .single();
    expect(error).toBeNull();
    expect(area).not.toBeNull();
    createdAreaIds.push(area!.id);

    const { data: cells, error: cellsError } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", area!.id);
    expect(cellsError).toBeNull();
    expect(cells!.length).toBeGreaterThan(0);
  });

  it("rating = 3 is rejected", async () => {
    const { data, error } = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: POLY_TRAFALGAR, rating: 3 })
      .select()
      .single();
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("updating geom replaces the cell set rather than appending", async () => {
    const { data: area, error } = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: POLY_TRAFALGAR, rating: 0 })
      .select()
      .single();
    expect(error).toBeNull();
    createdAreaIds.push(area!.id);

    const { data: before } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", area!.id);
    const beforeIds = new Set((before ?? []).map((c) => c.h3_index));
    expect(beforeIds.size).toBeGreaterThan(0);

    const { error: updateError } = await clientA
      .from("areas")
      .update({ geom: POLY_GREENWICH })
      .eq("id", area!.id);
    expect(updateError).toBeNull();

    const { data: after } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", area!.id);
    const afterIds = new Set((after ?? []).map((c) => c.h3_index));
    expect(afterIds.size).toBeGreaterThan(0);

    for (const id of beforeIds) {
      expect(afterIds.has(id)).toBe(false);
    }
  });

  it("deleting an area cascades to its cells", async () => {
    const { data: area, error } = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: POLY_TRAFALGAR, rating: -1 })
      .select()
      .single();
    expect(error).toBeNull();

    const { data: cellsBefore } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", area!.id);
    expect(cellsBefore!.length).toBeGreaterThan(0);

    const { error: deleteError } = await clientA.from("areas").delete().eq("id", area!.id);
    expect(deleteError).toBeNull();

    const { data: cellsAfter } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", area!.id);
    expect(cellsAfter).toEqual([]);
  });

  it("a second user's select on another user's area returns zero rows", async () => {
    const { data: area, error } = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: POLY_TRAFALGAR, rating: 1 })
      .select()
      .single();
    expect(error).toBeNull();
    createdAreaIds.push(area!.id);

    const { data: seenByB, error: selectError } = await clientB
      .from("areas")
      .select("*")
      .eq("id", area!.id);
    expect(selectError).toBeNull();
    expect(seenByB).toEqual([]);
  });
});
