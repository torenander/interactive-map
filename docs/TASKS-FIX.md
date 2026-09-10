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

## [~] Task 7 — Sole write path as a database guarantee (scope addendum)

**Files:** `supabase/migrations/0007_sole_write_path.sql`,
`supabase/functions/save-area/index.ts`

- [x] `save_area_tx` recreated as `security definer` with `set search_path`, and the four
      compensating checks written explicitly because RLS no longer applies inside it:
      authenticated caller or raise; `user_id` from `auth.uid()` with no input parameter;
      the conflict path guarded by `where a.user_id = v_uid` plus a raise when nothing
      comes back; cells written only for the row the upsert returned.
- [x] The ownership guard is a `where` clause on the upsert, not a preceding `select` —
      a read-then-check would race two callers for one fresh id, and the loser would
      update the winner's row. Same errcode as the other refusals, so the F1
      normalisation is not reintroduced (there is a test for exactly that).
- [x] `revoke insert, update on public.areas` and
      `revoke insert, update, delete on public.area_cells` from `authenticated, anon`.
      SELECT stays (RLS still scopes it); DELETE on `areas` stays (documented contract,
      and the cascade needs no grant on `area_cells`). `service_role` keeps everything.
- [x] Appended as 0007 rather than rewriting 0005: 0005 and 0006 are already committed,
      and DATA-MODEL.md's own rule is to append. 0005 stays readable as "why one
      transaction", 0007 as "why one writer".

## [~] Task 8 — Comment cap (scope addendum)

**Files:** `supabase/migrations/0007_sole_write_path.sql`,
`supabase/functions/save-area/index.ts`

- [x] `check (comment is null or char_length(comment) <= 2000)` on `areas` — 1 MB of text
      was accepted before. 2000 characters is about a page of prose; a field note is a
      sentence or two.
- [x] `MAX_COMMENT_CHARS = 2000` in `save-area`, checked with the other guards before any
      write, returning 422 with the limit stated.

## [~] Task 9 — Test changes forced by Task 7

**Files:** `tests/unit/schema.test.ts`, `tests/unit/save-area.test.ts`

Three existing tests wrote `areas` directly as a signed-in client, which is now refused.
Each was made **stronger**, never weaker — every one keeps its original assertion and adds
the privilege assertion in front of it:

- [x] schema.test.ts "rating = 3 is rejected by the database": asserts the client is
      refused (42501) AND that the same insert through the service role still trips
      `check (rating between -2 and 2)` (23514). The constraint is still what is being
      tested; it is now also proven that the client cannot reach it.
- [x] save-area.test.ts timestamps: client insert refused (42501) AND forged timestamps
      still lose to the server clock on the service-role path, `created_at` still frozen
      across an update.
- [x] save-area.test.ts dimension: client update refused (42501) AND the constraint still
      rejects `'noise'` for a role that can write.
- [x] New: every revoked path attempted and refused (insert/update areas, insert/update/
      delete area_cells, including a garbage `h3_index`), nothing landed, and the two
      paths that must stay open still work — SELECT, and a direct whole-area DELETE whose
      cascade still clears the cells.
- [x] New: comment of 2001 characters → 422 with the pre-existing row byte-identical
      afterwards, 2000 characters → 200 (so the guard is a limit, not a blanket refusal),
      and the constraint rejects an over-long comment on the service-role path.
- [x] The RLS isolation tests in schema.test.ts are untouched and still pass.

## [~] Task 10 — Negative control

Running `tests/unit/save-area.test.ts` against the pre-fix `save-area` (both migrations
applied, so the F5 tests legitimately still pass) fails 4 of 6:

```
× concurrent different geometries  → 42 cells stored for a 14-cell geometry   (F4)
× concurrent identical saves       → 4 non-2xx duplicate-key responses        (F3)
× oversized polygon                → 546 WORKER_LIMIT, row already mutated    (F2)
× another user's id                → 400 with the verbatim RLS message        (F1)
```

Removing `0007_sole_write_path.sql` and resetting fails the four addendum tests for the
right reasons — no privilege error where one is required (`expected undefined to be
'42501'`), the dimension update reaching the check constraint instead of being refused
(`expected '23514' to be '42501'`), and the over-long comment accepted by the database
(the edge function's own 422 still fires, since that half lives in the function).

Note when reproducing: the local edge runtime runs `--policy=per_worker` and keeps the
loaded module in a live worker. Editing a function file is not enough — the worker only
picks up new code after it is recycled (`npx supabase stop && npx supabase start` is the
reliable way). Verify which version is live before trusting a result.
