// save-feature write-path invariants against a local Supabase instance —
// docs/OBJECTIVES.md § G9 done_when.
//
// Structured as tests/unit/save-area.test.ts is, because the two write paths are
// deliberately the same shape (supabase/functions/save-feature/index.ts mirrors
// save-area). The assertions here are the ones G9 names, and each is about a property
// that must hold in the database or the function, not in the UI:
//
//   * kind and geometry cannot disagree — `kind` is what the rendering layer branches on.
//   * rating stays inside -2..2, proven against the table rather than through validation.
//   * an over-length comment is a clean 422, not a constraint violation surfacing as 400.
//   * the same client-generated uuid posted twice is one row (offline retry contract).
//   * another user's id is indistinguishable from any other unwritable id.
//   * a direct client insert is refused by the database, so "sole write path" is a grant
//     and not a convention (migration 0009, mirroring 0007).
//
// Requires the local stack running and migrated:
//   npx supabase start
//   npx supabase db reset
//
// After editing supabase/functions/*, recycle the edge runtime (CLAUDE.md):
//   npx supabase stop && npx supabase start
// Otherwise the local runtime keeps serving the previously loaded module.
//
// The edge function is called over raw fetch rather than supabase-js `functions.invoke`
// because these assertions are about HTTP status codes and exact bodies, which invoke
// hides behind its error wrapper.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/db/types";

const TEST_TIMEOUT_MS = 60_000;
const PASSWORD = "correct-horse-battery-staple";
const MAX_COMMENT_CHARS = 2000;

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

type GeoJsonPoint = { type: "Point"; coordinates: number[] };
type GeoJsonLine = { type: "LineString"; coordinates: number[][] };
type FeatureGeom = GeoJsonPoint | GeoJsonLine;

function pointAt(lngOffset = 0, latOffset = 0): GeoJsonPoint {
  return { type: "Point", coordinates: [-0.1276 + lngOffset, 51.5072 + latOffset] };
}

function lineAt(lngOffset = 0, latOffset = 0): GeoJsonLine {
  const lng = -0.1276 + lngOffset;
  const lat = 51.5072 + latOffset;
  return {
    type: "LineString",
    coordinates: [
      [lng, lat],
      [lng + 0.002, lat + 0.001],
      [lng + 0.004, lat],
    ],
  };
}

describe("save-feature write path", () => {
  let apiUrl: string;
  let anonKey: string;
  let serviceKey: string;
  let admin: SupabaseClient<Database>;
  let userA: { id: string; token: string; client: SupabaseClient<Database> };
  let userB: { id: string; token: string; client: SupabaseClient<Database> };
  const createdUserIds: string[] = [];

  async function createUser() {
    const email = `save-feature-test-${randomUUID()}@example.com`;
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

  async function callSaveFeature(
    token: string,
    body: {
      id: string;
      geom: FeatureGeom;
      kind: string;
      rating: number;
      comment?: string | null;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${apiUrl}/functions/v1/save-feature`, {
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

  async function rowsWithId(id: string) {
    const { data, error } = await admin.from("map_features").select("*").eq("id", id);
    if (error) throw error;
    return data ?? [];
  }

  // A freshly minted access token can carry an `iat` a few milliseconds ahead of
  // PostgREST's clock, which rejects it with "JWT issued at future" — a local-stack
  // timing quirk that clears within a second. Same mitigation as save-area.test.ts.
  async function waitUntilTokenAccepted(client: SupabaseClient<Database>) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const { error } = await client.from("map_features").select("id").limit(1);
      if (!error || !/JWT issued at future/i.test(error.message)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("PostgREST kept rejecting a freshly issued JWT as future-dated");
  }

  beforeAll(async () => {
    const env = readLocalSupabaseEnv();
    apiUrl = env.API_URL ?? env.SUPABASE_URL;
    anonKey = env.ANON_KEY;
    serviceKey = env.SERVICE_ROLE_KEY;
    if (!apiUrl || !anonKey || !serviceKey) {
      throw new Error(
        `Missing API_URL/ANON_KEY/SERVICE_ROLE_KEY from \`supabase status -o env\`. ` +
          `Got keys: ${Object.keys(env).join(", ")}`,
      );
    }
    admin = createClient<Database>(apiUrl, serviceKey);
    userA = await createUser();
    userB = await createUser();
    await waitUntilTokenAccepted(userA.client);
    await waitUntilTokenAccepted(userB.client);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    for (const id of createdUserIds) {
      // Features cascade with the user (migration 0008's FK), so this is the whole cleanup.
      await admin.auth.admin.deleteUser(id);
    }
  }, TEST_TIMEOUT_MS);

  it("saves a point and a line, each with the kind it was sent as", async () => {
    const pointId = randomUUID();
    const lineId = randomUUID();

    const point = await callSaveFeature(userA.token, {
      id: pointId,
      geom: pointAt(),
      kind: "point",
      rating: 1,
      comment: "good corner shop",
    });
    expect(point.status).toBe(200);

    const line = await callSaveFeature(userA.token, {
      id: lineId,
      geom: lineAt(),
      kind: "line",
      rating: -1,
      comment: null,
    });
    expect(line.status).toBe(200);

    const [savedPoint] = await rowsWithId(pointId);
    const [savedLine] = await rowsWithId(lineId);
    expect(savedPoint.kind).toBe("point");
    expect(savedPoint.user_id).toBe(userA.id);
    expect(savedPoint.dimension).toBe("overall");
    expect(savedLine.kind).toBe("line");
    expect(savedLine.comment).toBeNull();
  }, TEST_TIMEOUT_MS);

  it("rejects a point payload declared as kind 'line'", async () => {
    const id = randomUUID();
    const res = await callSaveFeature(userA.token, {
      id,
      geom: pointAt(0.001),
      kind: "line",
      rating: 0,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/kind/i);
    // Rejected before the write, not rolled back after one.
    expect(await rowsWithId(id)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("rejects rating = 3 at the database, not just in the function", async () => {
    // Through the function first: the row must not appear whatever the status.
    const id = randomUUID();
    const viaFunction = await callSaveFeature(userA.token, {
      id,
      geom: pointAt(0.002),
      kind: "point",
      rating: 3,
    });
    expect(viaFunction.status).not.toBe(200);
    expect(await rowsWithId(id)).toHaveLength(0);

    // Then straight at the table with the service role, which holds the INSERT grant the
    // client roles no longer do. This is the constraint being tested, not app validation.
    const { error } = await admin.from("map_features").insert({
      id: randomUUID(),
      user_id: userA.id,
      geom: "SRID=4326;POINT(-0.1276 51.5072)",
      kind: "point",
      rating: 3,
    } as never);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/map_features_rating_check|violates check constraint/i);
  }, TEST_TIMEOUT_MS);

  it("returns 422 for a comment one character over the cap", async () => {
    const id = randomUUID();
    const res = await callSaveFeature(userA.token, {
      id,
      geom: pointAt(0.003),
      kind: "point",
      rating: 0,
      comment: "x".repeat(MAX_COMMENT_CHARS + 1),
    });
    expect(res.status).toBe(422);
    expect(await rowsWithId(id)).toHaveLength(0);

    // The cap itself, not an off-by-one in the guard: exactly the limit still saves.
    const okId = randomUUID();
    const ok = await callSaveFeature(userA.token, {
      id: okId,
      geom: pointAt(0.004),
      kind: "point",
      rating: 0,
      comment: "x".repeat(MAX_COMMENT_CHARS),
    });
    expect(ok.status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("posting the same uuid twice yields one row, updated in place", async () => {
    const id = randomUUID();
    const first = await callSaveFeature(userA.token, {
      id,
      geom: pointAt(0.005),
      kind: "point",
      rating: 1,
      comment: "first",
    });
    expect(first.status).toBe(200);

    const second = await callSaveFeature(userA.token, {
      id,
      geom: pointAt(0.006),
      kind: "point",
      rating: -1,
      comment: "second",
    });
    expect(second.status).toBe(200);

    // This is the offline write queue's contract: a retried flush must not duplicate.
    const rows = await rowsWithId(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(-1);
    expect(rows[0].comment).toBe("second");
  }, TEST_TIMEOUT_MS);

  it("another user's id returns the generic 404, same as any unwritable id", async () => {
    const id = randomUUID();
    const mine = await callSaveFeature(userA.token, {
      id,
      geom: pointAt(0.007),
      kind: "point",
      rating: 1,
    });
    expect(mine.status).toBe(200);

    const theirs = await callSaveFeature(userB.token, {
      id,
      geom: pointAt(0.008),
      kind: "point",
      rating: -1,
      comment: "not yours",
    });
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual({ error: "Feature not found or not writable" });

    // And it really was refused, not merely reported as refused.
    const rows = await rowsWithId(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userA.id);
    expect(rows[0].rating).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("a direct client insert into map_features is refused by the database", async () => {
    // Migration 0009 revokes INSERT/UPDATE from authenticated and anon, so "all writes go
    // through save-feature" is a grant rather than a convention a client can decline.
    const { error: insertError } = await userA.client.from("map_features").insert({
      id: randomUUID(),
      user_id: userA.id,
      geom: "SRID=4326;POINT(-0.1276 51.5072)",
      kind: "point",
      rating: 1,
    } as never);
    expect(insertError).not.toBeNull();
    expect(insertError?.message).toMatch(/permission denied|not authorized|row-level security/i);

    // UPDATE is revoked too — otherwise a client could edit a row save-feature created.
    const id = randomUUID();
    expect(
      (await callSaveFeature(userA.token, { id, geom: pointAt(0.009), kind: "point", rating: 0 }))
        .status,
    ).toBe(200);
    const { error: updateError } = await userA.client
      .from("map_features")
      .update({ rating: -2 } as never)
      .eq("id", id);
    expect(updateError).not.toBeNull();

    // SELECT and DELETE deliberately stay granted: a feature owns no derived rows, so a
    // direct delete leaves nothing behind.
    const { error: deleteError } = await userA.client.from("map_features").delete().eq("id", id);
    expect(deleteError).toBeNull();
    expect(await rowsWithId(id)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});
