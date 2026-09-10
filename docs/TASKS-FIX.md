# Security / correctness fix pass — task log

Five findings from an adversarial probe of the `save-area` write path, all reproduced
against the local stack before the fix and all re-reproduced afterwards as failing tests
(see "Negative control" below). Exit criteria: every gate in the task brief exits 0.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after watching
the commands run).

---

## [~] Task 1 — F2/F3/F4: one transaction for the area write

**Files:** `supabase/migrations/0005_atomic_area_write.sql`,
`supabase/functions/save-area/index.ts`, `src/db/types.ts`

- [x] `public.save_area_tx(...)`, `security invoker`, `set search_path`, execute granted
      to `authenticated` and revoked from `public` and `anon` (Supabase's default
      privileges grant execute to `anon` too, so revoking PUBLIC alone is not enough).
- [x] Upsert → delete cells → insert cells, one transaction. The upsert's row lock is the
      serialisation point: concurrent writers on one id queue behind it, so the last
      committer's cells are the only cells left. No interleaving, no duplicate-key 400s,
      no partial write if the caller dies.
- [x] Edge function computes cells with h3-js exactly as before, then makes a single
      `.rpc()` call. No multi-statement writes left in the function.
- [x] `npx supabase gen types typescript --local > src/db/types.ts` after the migration.

## [~] Task 2 — F2: size guard before any write

**Files:** `supabase/functions/save-area/index.ts`

- [x] `MAX_CELLS = 5000` (~75 km² at res 10, an ~8.7 km square — larger than the London
      borough of Kensington and Chelsea, and SPEC.md's use case is neighbourhood-scale
      ratings). Observed failure point was ~20k cells (0.2° bbox, 546 WORKER_LIMIT); 12.5k
      still worked. The cap sits an order of magnitude below the break, not just under it.
- [x] Cheap bbox pre-check at 4x the cap runs before `polygonToCells`, so an absurd
      polygon never allocates its cell array. Loose on purpose — a bbox over-estimates a
      thin or diagonal polygon; the exact count check after derivation catches the rest.
- [x] Both reject with 422 and state the limit. Both run before any write.

## [~] Task 3 — F1: one response for every unwritable id

**Files:** `supabase/functions/save-area/index.ts`

- [x] `42501` (or any message mentioning row-level security) from the RPC returns
      `404 {"error": "Area not found or not writable"}` — no Postgres text, no table name.
      404 rather than 403 because 403 would itself confirm the row exists.
- [x] Residual documented in the function and in docs/DATA-MODEL.md: a successful save
      still returns 200, so "somebody else's id" is still distinguishable from "free id"
      by status. That is inherent to an upsert endpoint that must report whether it wrote;
      what is closed is the message-level oracle.

## [~] Task 4 — F5: server-owned timestamps, pinned dimension

**Files:** `supabase/migrations/0006_timestamp_and_dimension_guards.sql`

- [x] `touch_updated_at` recreated as `before insert or update`: `updated_at` always the
      server clock, `created_at` set on insert and frozen to `old.created_at` on update.
- [x] `check (dimension = 'overall')` on `areas`. Widening it later is one migration; the
      migration says so.

## [~] Task 5 — Tests

**Files:** `tests/unit/save-area.test.ts`, `package.json` (dev dep `h3-js`)

- [x] Six concurrent same-id saves with different geometries: all 200, and `area_cells`
      is exactly the derived cell set of the geometry actually stored (derived locally
      with h3-js, read back through PostgREST as GeoJSON).
- [x] Six concurrent identical saves: zero non-2xx responses, exactly one row.
- [x] Oversized polygon against an existing id: 4xx, and the row plus its cells are
      byte-identical afterwards.
- [x] Direct insert with forged `created_at` / `updated_at`: server values win, and
      `created_at` survives an update that tries to move it.
- [x] `dimension` PATCH to `'noise'`: rejected by `areas_dimension_overall`.
- [x] Another user's id through `save-area`: 404 with the fixed body, victim's row
      untouched, and the same user can still write a free id.
- [x] `h3-js` as a devDependency so the test derives the expected cell set with the same
      implementation the server uses. It is not imported by app code.

**Local-stack quirk, not a product bug:** a freshly minted access token can carry an `iat`
a few milliseconds ahead of PostgREST's clock, which rejects it with "JWT issued at
future". `beforeAll` waits for the token to be accepted once per user rather than
retrying inside the concurrency tests, where a retry would change what is measured.

## [~] Task 6 — Negative control

Running `tests/unit/save-area.test.ts` against the pre-fix `save-area` (both migrations
applied, so the F5 tests legitimately still pass) fails 4 of 6:

```
× concurrent different geometries  → 42 cells stored for a 14-cell geometry   (F4)
× concurrent identical saves       → 4 non-2xx duplicate-key responses        (F3)
× oversized polygon                → 546 WORKER_LIMIT, row already mutated    (F2)
× another user's id                → 400 with the verbatim RLS message        (F1)
```

Note when reproducing: the local edge runtime runs `--policy=per_worker` and keeps the
loaded module in a live worker. Editing a function file is not enough — the worker only
picks up new code after it is recycled (`npx supabase stop && npx supabase start` is the
reliable way). Verify which version is live before trusting a result.
