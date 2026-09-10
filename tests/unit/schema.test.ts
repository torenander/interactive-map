// Schema constraints against a local Supabase instance — docs/OBJECTIVES.md § G2 done_when,
// docs/TESTING.md "Schema constraints ... (checks, cascades, RLS isolation)".
//
// Requires the local stack running and migrated:
//   npx supabase start
//   npx supabase db reset
//
// Connection details are read from `supabase status -o env` rather than hardcoded, so this
// works against whatever ports/keys the local stack actually has.
//
// Cell derivation is no longer a Postgres trigger — h3 / h3_postgis do not exist as
// Postgres extensions anywhere (see supabase/migrations/0002_derive_cells.sql). Creating an
// area now means invoking the `save-area` edge function (the sole write path — see
// supabase/functions/save-area/index.ts), which `supabase start` serves locally. The one
// exception is the rating check: that must be proven directly against the areas table, not
// through the function, so it is the database constraint being tested and not app-level
// validation.
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

type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };

// Two polygons far enough apart that they share no H3 res-10 cells, and each large
// enough (res 10 hexagons are ~65 m edge, ~130 m tip-to-tip) to reliably contain at
// least one cell center — a smaller box can legitimately resolve to zero cells, which
// is real h3-js behaviour (polygonToCells is center-containment, not intersection), not
// a bug: Trafalgar Square area, and Greenwich, a few km east.
const TRAFALGAR: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-0.13, 51.505],
      [-0.125, 51.505],
      [-0.125, 51.51],
      [-0.13, 51.51],
      [-0.13, 51.505],
    ],
  ],
};
const GREENWICH: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-0.012, 51.476],
      [-0.007, 51.476],
      [-0.007, 51.481],
      [-0.012, 51.481],
      [-0.012, 51.476],
    ],
  ],
};
// WKT form of TRAFALGAR, for the one test that must bypass save-area and write the
// areas table directly.
const TRAFALGAR_WKT =
  "SRID=4326;POLYGON((-0.13 51.505, -0.125 51.505, -0.125 51.51, -0.13 51.51, -0.13 51.505))";

type SaveAreaResult = {
  area: Database["public"]["Tables"]["areas"]["Row"];
  cellCount: number;
};

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

  async function saveArea(
    client: SupabaseClient<Database>,
    input: { id: string; geom: GeoJsonPolygon; rating: number; comment?: string | null },
  ): Promise<SaveAreaResult> {
    const { data, error } = await client.functions.invoke<SaveAreaResult>("save-area", {
      body: input,
    });
    if (error) throw error;
    return data as SaveAreaResult;
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

  it("inserting an area (via save-area) populates area_cells with at least one row", async () => {
    const id = randomUUID();
    createdAreaIds.push(id);

    const result = await saveArea(clientA, { id, geom: TRAFALGAR, rating: 1 });
    expect(result.area.id).toBe(id);
    expect(result.cellCount).toBeGreaterThan(0);

    const { data: cells, error: cellsError } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", id);
    expect(cellsError).toBeNull();
    expect(cells!.length).toBeGreaterThan(0);
  });

  it("rating = 3 is rejected by the database, not just app validation", async () => {
    // Deliberately bypasses save-area: a direct table insert, so what rejects this is
    // the `check (rating between -2 and 2)` constraint in migration 0001.
    const { data, error } = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: TRAFALGAR_WKT, rating: 3 })
      .select()
      .single();
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("updating geom replaces the cell set rather than appending", async () => {
    const id = randomUUID();
    createdAreaIds.push(id);

    await saveArea(clientA, { id, geom: TRAFALGAR, rating: 0 });

    const { data: before } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", id);
    const beforeIds = new Set((before ?? []).map((c) => c.h3_index));
    expect(beforeIds.size).toBeGreaterThan(0);

    await saveArea(clientA, { id, geom: GREENWICH, rating: 0 });

    const { data: after } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", id);
    const afterIds = new Set((after ?? []).map((c) => c.h3_index));
    expect(afterIds.size).toBeGreaterThan(0);

    for (const cellId of beforeIds) {
      expect(afterIds.has(cellId)).toBe(false);
    }
  });

  it("deleting an area cascades to its cells", async () => {
    const id = randomUUID();

    await saveArea(clientA, { id, geom: TRAFALGAR, rating: -1 });

    const { data: cellsBefore } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", id);
    expect(cellsBefore!.length).toBeGreaterThan(0);

    // Deletes go direct — cascade (migration 0001) handles the cells, no function needed.
    const { error: deleteError } = await clientA.from("areas").delete().eq("id", id);
    expect(deleteError).toBeNull();

    const { data: cellsAfter } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", id);
    expect(cellsAfter).toEqual([]);
  });

  it("a second user's select on another user's area returns zero rows", async () => {
    const id = randomUUID();
    createdAreaIds.push(id);

    await saveArea(clientA, { id, geom: TRAFALGAR, rating: 1 });

    const { data: seenByB, error: selectError } = await clientB
      .from("areas")
      .select("*")
      .eq("id", id);
    expect(selectError).toBeNull();
    expect(seenByB).toEqual([]);
  });
});
