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
// validation. Since migration 0007 that direct write needs the service role — signed-in
// clients no longer hold INSERT/UPDATE on areas at all — so the test asserts both halves:
// the client is refused the privilege, and the constraint still rejects the value.
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
    // Two assertions, both deliberately bypassing save-area.
    //
    // First: since migration 0007 a signed-in client has no INSERT grant on areas at all
    // — the sole write path is enforced by grants, not convention — so this direct insert
    // is refused before any constraint is consulted.
    const denied = await clientA
      .from("areas")
      .insert({ user_id: userA.id, geom: TRAFALGAR_WKT, rating: 3 })
      .select()
      .single();
    expect(denied.data).toBeNull();
    expect(denied.error).not.toBeNull();
    expect(denied.error!.code).toBe("42501");

    // Second: the constraint itself, proven through the one role that still holds the
    // grant. What rejects this is `check (rating between -2 and 2)` from migration 0001
    // (SQLSTATE 23514), not app validation and not the missing privilege above.
    const { data, error } = await admin
      .from("areas")
      .insert({ user_id: userA.id, geom: TRAFALGAR_WKT, rating: 3 })
      .select()
      .single();
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
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

// G9 (docs/OBJECTIVES.md § G9 done_when) — the map_features half of the schema. A
// separate block with its own users rather than additions to the G2 one above: the
// cascade test has to delete a user to observe the FK, which would take the shared
// fixtures down with it.
//
// Features are created through `save-feature`, the sole write path — migration 0009
// revokes INSERT/UPDATE from the client roles, so there is no direct-write alternative.
// The one direct write here is by the service role, which keeps its grants, and it is
// there to prove a database constraint rather than app-level validation.
describe("G9 map_features schema constraints", () => {
  let admin: SupabaseClient<Database>;
  let apiUrl: string;
  let anonKey: string;
  let userA: { id: string; client: SupabaseClient<Database> };
  let userB: { id: string; client: SupabaseClient<Database> };
  const password = "correct-horse-battery-staple";
  const createdUserIds: string[] = [];

  async function createUser(label: string) {
    const email = `schema-feature-${label}-${randomUUID()}@example.com`;
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error(`user ${label} not created`);
    createdUserIds.push(created.user.id);
    const client = createClient<Database>(apiUrl, anonKey);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    return { id: created.user.id, client };
  }

  async function saveFeature(
    client: SupabaseClient<Database>,
    input: {
      id: string;
      geom: { type: string; coordinates: unknown };
      kind: "point" | "line";
      rating: number;
      comment?: string | null;
    },
  ) {
    const { error } = await client.functions.invoke("save-feature", { body: input });
    if (error) throw error;
  }

  function pointAt(lngOffset: number) {
    return { type: "Point", coordinates: [-0.1276 + lngOffset, 51.5072] };
  }

  beforeAll(async () => {
    const env = readLocalSupabaseEnv();
    apiUrl = env.API_URL ?? env.SUPABASE_URL;
    anonKey = env.ANON_KEY;
    admin = createClient<Database>(apiUrl, env.SERVICE_ROLE_KEY);
    userA = await createUser("a");
    userB = await createUser("b");
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("deleting a user cascades to their features", async () => {
    // A user of its own, because observing the cascade means destroying the owner.
    const doomed = await createUser("doomed");
    const id = randomUUID();
    await saveFeature(doomed.client, { id, geom: pointAt(0.01), kind: "point", rating: 1 });

    const { data: before } = await admin.from("map_features").select("id").eq("id", id);
    expect(before).toHaveLength(1);

    const { error: deleteError } = await admin.auth.admin.deleteUser(doomed.id);
    expect(deleteError).toBeNull();

    const { data: after, error: afterError } = await admin
      .from("map_features")
      .select("id")
      .eq("id", id);
    expect(afterError).toBeNull();
    expect(after).toEqual([]);
  });

  it("a second user's select on another user's feature returns zero rows", async () => {
    const id = randomUUID();
    await saveFeature(userA.client, { id, geom: pointAt(0.02), kind: "point", rating: 1 });

    const { data: seenByB, error } = await userB.client
      .from("map_features")
      .select("*")
      .eq("id", id);
    expect(error).toBeNull();
    expect(seenByB).toEqual([]);

    // The owner still sees it, so this is RLS scoping the read and not an empty table.
    const { data: seenByA } = await userA.client.from("map_features").select("id").eq("id", id);
    expect(seenByA).toHaveLength(1);
  });

  it("no map_features row can have dimension other than 'overall'", async () => {
    const id = randomUUID();
    await saveFeature(userA.client, { id, geom: pointAt(0.03), kind: "point", rating: 0 });
    const { data: saved } = await admin.from("map_features").select("dimension").eq("id", id);
    expect(saved?.[0].dimension).toBe("overall");

    // The constraint, not the write path's habit: the service role holds INSERT and is
    // still refused. CLAUDE.md pins dimension to 'overall'; migration 0008 makes that real.
    const { error } = await admin.from("map_features").insert({
      id: randomUUID(),
      user_id: userA.id,
      geom: "SRID=4326;POINT(-0.1276 51.5072)",
      kind: "point",
      dimension: "noise",
      rating: 1,
    } as never);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/dimension|violates check constraint/i);

    // And nothing in the table got past it.
    const { data: offending } = await admin
      .from("map_features")
      .select("id")
      .neq("dimension", "overall");
    expect(offending).toEqual([]);
  });

  it("kind cannot disagree with the stored geometry", async () => {
    // save-feature returns 422 for this (tests/unit/save-feature.test.ts), but the
    // guarantee has to hold at the table too — otherwise the service role, or any future
    // write path, could produce a 'point' row holding a LINESTRING that the map cannot
    // draw. This is map_features_geom_matches_kind from migration 0008.
    const { error } = await admin.from("map_features").insert({
      id: randomUUID(),
      user_id: userA.id,
      geom: "SRID=4326;LINESTRING(-0.1276 51.5072, -0.1266 51.5082)",
      kind: "point",
      rating: 1,
    } as never);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/geom_matches_kind|violates check constraint/i);
  });
});
