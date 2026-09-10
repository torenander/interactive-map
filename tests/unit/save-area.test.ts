// save-area write-path invariants against a local Supabase instance.
//
// Every test here is a regression test for a defect that was reproduced against this
// stack before the fix (see supabase/migrations/0005_atomic_area_write.sql and
// 0006_timestamp_and_dimension_guards.sql):
//
//   * Concurrent saves of the same id interleaved the delete-then-insert cell
//     replacement: same-geometry calls collided on area_cells_pkey and returned spurious
//     400s, different-geometry calls all returned 200 and left area_cells holding cells
//     from several geometries at once.
//   * An oversized polygon killed the edge worker (546 WORKER_LIMIT) after the row had
//     been upserted and its cells deleted — a failure the client saw, with a mutated
//     server state behind it.
//   * A direct PostgREST insert could set created_at / updated_at to anything, and
//     dimension could be PATCHed off 'overall'.
//
// Requires the local stack running and migrated:
//   npx supabase start
//   npx supabase db reset
//
// Connection details come from `supabase status -o env`, following tests/unit/schema.test.ts.
// The edge function is called over raw fetch rather than supabase-js `functions.invoke`
// because these assertions are about HTTP status codes and exact bodies, which invoke
// hides behind its error wrapper.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { polygonToCells } from "h3-js";
import type { Database } from "../../src/db/types";

const RESOLUTION = 10;
const TEST_TIMEOUT_MS = 60_000;
const PASSWORD = "correct-horse-battery-staple";

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

// A ~0.005° box (roughly 350 m x 550 m in London) — big enough to contain several res-10
// cell centres, small enough that six of them at different offsets share no cells.
function boxAt(lngOffset: number, latOffset: number): GeoJsonPolygon {
  const lng = -0.13 + lngOffset;
  const lat = 51.5 + latOffset;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng, lat],
        [lng + 0.005, lat],
        [lng + 0.005, lat + 0.005],
        [lng, lat + 0.005],
        [lng, lat],
      ],
    ],
  };
}

// Bigger than the function's 5,000-cell budget: a 0.4° x 0.4° box is ~1,500 km², two
// orders of magnitude over. This is the shape that used to kill the worker mid-write.
const OVERSIZED: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-0.4, 51.3],
      [0.0, 51.3],
      [0.0, 51.7],
      [-0.4, 51.7],
      [-0.4, 51.3],
    ],
  ],
};

const TRAFALGAR_WKT =
  "SRID=4326;POLYGON((-0.13 51.505, -0.125 51.505, -0.125 51.51, -0.13 51.51, -0.13 51.505))";

function derivedCells(geom: GeoJsonPolygon): Set<string> {
  return new Set(polygonToCells(geom.coordinates, RESOLUTION, true));
}

describe("save-area write path", () => {
  let apiUrl: string;
  let anonKey: string;
  let admin: SupabaseClient<Database>;
  let userA: { id: string; token: string; client: SupabaseClient<Database> };
  let userB: { id: string; token: string; client: SupabaseClient<Database> };
  const createdAreaIds: string[] = [];
  const createdUserIds: string[] = [];

  async function createUser() {
    const email = `save-area-test-${randomUUID()}@example.com`;
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !created.user) throw error ?? new Error("user not created");
    createdUserIds.push(created.user.id);

    const client = createClient<Database>(apiUrl, anonKey);
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    if (signInError) throw signInError;
    const { data: session } = await client.auth.getSession();
    const token = session.session?.access_token;
    if (!token) throw new Error("no access token after sign-in");
    return { id: created.user.id, token, client };
  }

  async function callSaveArea(
    token: string,
    body: { id: string; geom: GeoJsonPolygon; rating: number; comment?: string | null },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${apiUrl}/functions/v1/save-area`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function storedCells(areaId: string): Promise<Set<string>> {
    const { data, error } = await admin
      .from("area_cells")
      .select("h3_index")
      .eq("area_id", areaId);
    if (error) throw error;
    return new Set((data ?? []).map((row) => row.h3_index));
  }

  // geography columns come back as WKB hex from PostgREST unless GeoJSON is requested
  // explicitly — same trick src/db/client.ts uses to read areas back.
  async function storedGeom(areaId: string): Promise<GeoJsonPolygon> {
    const env = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const res = await fetch(`${apiUrl}/rest/v1/areas?id=eq.${areaId}&select=id,geom`, {
      headers: { ...env, Accept: "application/geo+json" },
    });
    if (!res.ok) throw new Error(`read geom failed: ${res.status} ${await res.text()}`);
    const geojson = (await res.json()) as {
      features: { geometry: GeoJsonPolygon }[];
    };
    if (geojson.features.length !== 1) {
      throw new Error(`expected exactly one area row, got ${geojson.features.length}`);
    }
    return geojson.features[0].geometry;
  }

  // A freshly minted access token can carry an `iat` a few milliseconds ahead of
  // PostgREST's clock, which rejects it with "JWT issued at future" — a local-stack timing
  // quirk, nothing to do with the code under test, and it clears within a second. Wait it
  // out once per user before any assertions run, rather than retrying inside the
  // concurrency tests where a retry would change what is being measured. The probe is a
  // PostgREST read because PostgREST is what performs this check; the functions gateway
  // accepts the same token happily.
  async function waitUntilTokenAccepted(client: SupabaseClient<Database>) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const { error } = await client.from("areas").select("id").limit(1);
      if (!error || !/JWT issued at future/i.test(error.message)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("PostgREST kept rejecting a freshly issued JWT as future-dated");
  }

  let serviceKey: string;

  beforeAll(async () => {
    const env = readLocalSupabaseEnv();
    apiUrl = env.API_URL ?? env.SUPABASE_URL;
    anonKey = env.ANON_KEY;
    serviceKey = env.SERVICE_ROLE_KEY;
    if (!apiUrl || !anonKey || !serviceKey) {
      throw new Error(
        `Missing API_URL/ANON_KEY/SERVICE_ROLE_KEY from \`supabase status -o env\`. Got keys: ${Object.keys(env).join(", ")}`,
      );
    }
    admin = createClient<Database>(apiUrl, serviceKey);
    userA = await createUser();
    userB = await createUser();
    await waitUntilTokenAccepted(userA.client);
    await waitUntilTokenAccepted(userB.client);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (createdAreaIds.length > 0) {
      await admin.from("areas").delete().in("id", createdAreaIds);
    }
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  it(
    "concurrent saves of the same id with different geometries leave cells matching the stored geometry",
    async () => {
      const id = randomUUID();
      createdAreaIds.push(id);

      const geoms = [0, 1, 2, 3, 4, 5].map((i) => boxAt(i * 0.02, i * 0.02));
      const results = await Promise.all(
        geoms.map((geom, i) => callSaveArea(userA.token, { id, geom, rating: 0, comment: `w${i}` })),
      );

      // Every writer settles cleanly: no duplicate-key 400s, no worker deaths.
      for (const result of results) {
        expect(result.status, JSON.stringify(result.body)).toBe(200);
      }

      // The invariant that actually broke: area_cells must be exactly the cell set of the
      // geometry that won, not a union of several writers' sets.
      const winner = await storedGeom(id);
      const expected = derivedCells(winner);
      const actual = await storedCells(id);
      expect(expected.size).toBeGreaterThan(0);
      expect([...actual].sort()).toEqual([...expected].sort());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "concurrent identical saves of the same id all succeed and produce one row",
    async () => {
      const id = randomUUID();
      createdAreaIds.push(id);
      const geom = boxAt(0, 0);

      const results = await Promise.all(
        [0, 1, 2, 3, 4, 5].map(() => callSaveArea(userA.token, { id, geom, rating: 1 })),
      );

      const nonSuccess = results.filter((r) => r.status < 200 || r.status >= 300);
      expect(nonSuccess.map((r) => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);

      const { data: rows, error } = await admin.from("areas").select("id").eq("id", id);
      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      expect([...(await storedCells(id))].sort()).toEqual([...derivedCells(geom)].sort());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an oversized polygon is rejected without touching the existing row or its cells",
    async () => {
      const id = randomUUID();
      createdAreaIds.push(id);

      const first = await callSaveArea(userA.token, {
        id,
        geom: boxAt(0, 0),
        rating: 1,
        comment: "keep me",
      });
      expect(first.status).toBe(200);

      const { data: rowBefore } = await admin.from("areas").select("*").eq("id", id).single();
      const cellsBefore = await storedCells(id);
      expect(cellsBefore.size).toBeGreaterThan(0);

      const oversized = await callSaveArea(userA.token, { id, geom: OVERSIZED, rating: -1 });
      expect(oversized.status).toBeGreaterThanOrEqual(400);
      expect(oversized.status).toBeLessThan(500);

      const { data: rowAfter } = await admin.from("areas").select("*").eq("id", id).single();
      expect(rowAfter).toEqual(rowBefore);
      expect([...(await storedCells(id))].sort()).toEqual([...cellsBefore].sort());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "saving into another user's area id is indistinguishable from any other unwritable id",
    async () => {
      const id = randomUUID();
      createdAreaIds.push(id);
      const mine = randomUUID();
      createdAreaIds.push(mine);

      expect((await callSaveArea(userA.token, { id, geom: boxAt(0, 0), rating: 1 })).status).toBe(
        200,
      );

      const stolen = await callSaveArea(userB.token, { id, geom: boxAt(0.02, 0), rating: -1 });
      expect(stolen.status).toBe(404);
      expect(stolen.body).toEqual({ error: "Area not found or not writable" });
      // No Postgres internals, no confirmation that a row with this id exists.
      expect(JSON.stringify(stolen.body)).not.toMatch(/row-level security|areas|policy/i);

      // A's row is untouched by B's attempt.
      const { data: row } = await admin.from("areas").select("user_id, rating").eq("id", id).single();
      expect(row).toEqual({ user_id: userA.id, rating: 1 });

      // And B can still write a free id, which is the case the normalised failure is
      // deliberately NOT made to look like — documented in save-area/index.ts.
      expect(
        (await callSaveArea(userB.token, { id: mine, geom: boxAt(0.02, 0), rating: 0 })).status,
      ).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it("timestamps are the server's, not the client's", async () => {
    const forged = "2000-01-01T00:00:00+00:00";

    // A signed-in client cannot write areas directly at all since migration 0007, so the
    // forgery it used to be able to perform is now refused twice over: no grant, and the
    // trigger would overwrite it anyway. Both are asserted.
    const denied = await userA.client
      .from("areas")
      .insert({ user_id: userA.id, geom: TRAFALGAR_WKT, rating: 0, created_at: forged })
      .select()
      .single();
    expect(denied.error?.code).toBe("42501");

    // The trigger itself, through the role that still holds the grant: forged timestamps
    // lose to the server clock on insert, and created_at survives an update that tries to
    // move it.
    const { data, error } = await admin
      .from("areas")
      .insert({
        user_id: userA.id,
        geom: TRAFALGAR_WKT,
        rating: 0,
        created_at: forged,
        updated_at: forged,
      })
      .select()
      .single();
    expect(error).toBeNull();
    createdAreaIds.push(data!.id);

    expect(data!.created_at).not.toBe(forged);
    expect(data!.updated_at).not.toBe(forged);
    expect(Date.now() - Date.parse(data!.created_at)).toBeLessThan(TEST_TIMEOUT_MS);

    const { data: updated, error: updateError } = await admin
      .from("areas")
      .update({ created_at: forged, updated_at: forged, rating: 1 })
      .eq("id", data!.id)
      .select()
      .single();
    expect(updateError).toBeNull();
    expect(updated!.created_at).toBe(data!.created_at);
    expect(updated!.updated_at).not.toBe(forged);
    expect(Date.parse(updated!.updated_at)).toBeGreaterThanOrEqual(Date.parse(data!.updated_at));
  });

  it("dimension cannot be moved off 'overall'", async () => {
    const id = randomUUID();
    createdAreaIds.push(id);
    expect((await callSaveArea(userA.token, { id, geom: boxAt(0, 0), rating: 0 })).status).toBe(200);

    // Refused twice: the client has no UPDATE grant on areas (migration 0007), and the
    // check constraint (migration 0006) rejects the value even for a role that does.
    const denied = await userA.client.from("areas").update({ dimension: "noise" }).eq("id", id);
    expect(denied.error?.code).toBe("42501");

    const { error } = await admin.from("areas").update({ dimension: "noise" }).eq("id", id);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/areas_dimension_overall/);

    const { data: row } = await admin.from("areas").select("dimension").eq("id", id).single();
    expect(row!.dimension).toBe("overall");
  }, TEST_TIMEOUT_MS);

  it(
    "a signed-in client cannot write areas or area_cells around save-area",
    async () => {
      const id = randomUUID();
      createdAreaIds.push(id);
      expect((await callSaveArea(userA.token, { id, geom: boxAt(0, 0), rating: 0 })).status).toBe(
        200,
      );

      // Every write path that used to be open to an authenticated client and would have
      // let it desynchronise areas from area_cells: an area with no cells, a forged or
      // garbage h3_index, a hand-edited cell set.
      const insertArea = await userA.client
        .from("areas")
        .insert({ user_id: userA.id, geom: TRAFALGAR_WKT, rating: 0 });
      expect(insertArea.error?.code).toBe("42501");

      const updateArea = await userA.client.from("areas").update({ rating: -2 }).eq("id", id);
      expect(updateArea.error?.code).toBe("42501");

      const insertCell = await userA.client
        .from("area_cells")
        .insert({ area_id: id, h3_index: "not-an-h3-index", resolution: RESOLUTION });
      expect(insertCell.error?.code).toBe("42501");

      const updateCell = await userA.client
        .from("area_cells")
        .update({ h3_index: "not-an-h3-index" })
        .eq("area_id", id);
      expect(updateCell.error?.code).toBe("42501");

      const deleteCell = await userA.client.from("area_cells").delete().eq("area_id", id);
      expect(deleteCell.error?.code).toBe("42501");

      // Nothing above landed.
      const { data: row } = await admin.from("areas").select("rating").eq("id", id).single();
      expect(row!.rating).toBe(0);
      expect([...(await storedCells(id))].sort()).toEqual([...derivedCells(boxAt(0, 0))].sort());

      // The two paths that must stay open: reading your own rows, and deleting a whole
      // area direct (the documented contract — the FK cascade takes the cells with it,
      // without any grant on area_cells).
      const { data: readable, error: readError } = await userA.client
        .from("areas")
        .select("id")
        .eq("id", id);
      expect(readError).toBeNull();
      expect(readable).toHaveLength(1);

      const { error: deleteError } = await userA.client.from("areas").delete().eq("id", id);
      expect(deleteError).toBeNull();
      expect((await storedCells(id)).size).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an over-long comment is rejected before any write",
    async () => {
      const id = randomUUID();
      createdAreaIds.push(id);
      const geom = boxAt(0, 0);
      expect(
        (await callSaveArea(userA.token, { id, geom, rating: 0, comment: "keep me" })).status,
      ).toBe(200);
      const { data: rowBefore } = await admin.from("areas").select("*").eq("id", id).single();

      const tooLong = await callSaveArea(userA.token, {
        id,
        geom,
        rating: 1,
        comment: "x".repeat(2001),
      });
      expect(tooLong.status).toBe(422);
      const { data: rowAfter } = await admin.from("areas").select("*").eq("id", id).single();
      expect(rowAfter).toEqual(rowBefore);

      // The limit itself, not an off-by-one: exactly 2000 characters is fine.
      const atLimit = await callSaveArea(userA.token, {
        id,
        geom,
        rating: 1,
        comment: "y".repeat(2000),
      });
      expect(atLimit.status).toBe(200);

      // And the database backs the function up, for any role that can still write direct.
      const { error } = await admin
        .from("areas")
        .update({ comment: "z".repeat(2001) })
        .eq("id", id);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/areas_comment_length/);
    },
    TEST_TIMEOUT_MS,
  );
});
