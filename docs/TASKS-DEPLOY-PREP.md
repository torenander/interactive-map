# Deploy prep — cross-origin tiles, subpath deploys, production runbook

Removes the production-hostile assumptions the app hardcoded: `src/map/style.ts`
pinned the pmtiles URL to a same-origin path, and `src/sw.ts`'s range-caching
route only reliably matched that same-origin shape. In production the 125 MB
`london.pmtiles` archive lives in a Supabase Storage public bucket — a
different origin from the static-hosted app shell.

## Changes

- **`src/map/style.ts`**: `TILES_URL` now reads `VITE_TILES_URL` at build
  time, falling back to the original `pmtiles:///tiles/london.pmtiles` when
  unset — local dev and every existing test are unaffected.
- **`src/sw.ts`**: the pmtiles route matcher (`isPmtilesRequest`) now checks
  the request URL against the exact configured `VITE_TILES_URL` first, falling
  back to the original same-origin `*.pmtiles` pathname check. `vite-plugin-pwa`'s
  `injectManifest` strategy builds this file with Vite, so
  `import.meta.env.VITE_TILES_URL` resolves to a build-time literal same as
  any other module. `warmPmtilesCache`'s background-fill fetch is now explicit
  `mode: 'cors'` and throws (rather than caching) if the response comes back
  opaque — an opaque response's body can't be sliced by
  `workbox-range-requests`, so caching one would leave every subsequent range
  request permanently broken. Supabase Storage public buckets send permissive
  CORS by default, so this is expected to be a no-op in practice, but the
  guard makes a misconfigured bucket fail loudly (an error surfaced to the
  in-flight promise's `.catch`, cache left untouched, next request retries)
  instead of silently poisoning the cache. All invariants from
  `docs/TASKS-FIX-SW.md` and `docs/TASKS-G5.md` are preserved: non-blocking
  passthrough on cache miss, deduped background full-file fill, `tiles-cached`
  broadcast, no shared `Response` bodies across concurrent readers.
- **`tsconfig.sw.json`**: added `"types": ["vite/client"]` (was `[]`) — needed
  for `import.meta.env` to type-check in `src/sw.ts`; `tsc -b` failed with
  `TS2339: Property 'env' does not exist on type 'ImportMeta'` without it.
- **`.env.example`**: documents `VITE_TILES_URL` (one line + comment).
- **`vite.config.ts`**: added `VITE_BASE` (default `'/'`) driving Vite's
  `base` and the PWA manifest's `start_url`/`scope`/icon paths together, for
  subpath static-host deploys (GitHub Pages project sites). Unset, output is
  unchanged — verified byte-identical manifest shape (`start_url`/`scope`
  both `"/"`, icons at `/pwa-*.png`).
- **`docs/DEPLOY.md`** (new): numbered production runbook — Supabase login,
  project create/link, `db push` (migrations 0001–0007, order and postgis
  availability noted), `functions deploy save-area`, storage bucket creation
  and upload, auth email-confirmation toggle (with rationale), production
  build, static-host deploy with a GitHub Pages subsection, post-deploy smoke
  checklist.

## Auth / origin check (deliverable 3)

Read `src/auth/useSession.ts`, `src/auth/SignIn.tsx`, `src/db/client.ts` in
full. No `redirectTo` is ever passed to `signInWithEmail`/`signUpWithEmail`,
and nothing assumes `localhost` or any other origin — the app is sign-in-only
(no sign-up UI, no password reset), consistent with the "single account,
created out of band" comment already in `SignIn.tsx`. No code change was
needed here; documented in `docs/DEPLOY.md` § 6 with the exact reasoning, so
the "confirm email OFF" toggle it recommends is traceable to this finding
rather than asserted.

## Verification

All run from this worktree (`/Users/tor/interactive-map/.claude/worktrees/deploy-prep`,
branch `deploy-prep`), against the shared local Supabase stack (already
running — Docker-backed, not worktree-local) with `.env` and
`public/tiles/london.pmtiles` copied in from the main checkout (both are
untracked/gitignored and therefore not automatically present in a fresh
worktree — this is an artifact of worktree isolation, not a project issue).

| Command | Result |
|---|---|
| `npm run build` (default env) | exit 0 |
| `npm run test` | exit 0, 22/22 passed |
| `PREVIEW_PORT=5073 npm run test:e2e -- tests/e2e/offline-map.spec.ts` | exit 0, 1/1 passed |
| `PREVIEW_PORT=5073 npm run test:e2e -- tests/e2e/map-shell.spec.ts` | exit 0, 7/7 passed |
| `VITE_TILES_URL=https://example.test/tiles/london.pmtiles npm run build` | exit 0; `dist/sw.js` and `dist/assets/index-*.js` both contain the literal URL (`grep` confirmed) |

No runtime test was possible against the fake `VITE_TILES_URL` (no live
cross-origin Storage bucket to fetch from) — confirmed by static inspection
only, as expected; the cross-origin fetch/CORS/opaque-response path is
exercised for real by the post-deploy smoke checklist in `docs/DEPLOY.md` § 9
once a hosted project exists.

Storage CLI syntax in `docs/DEPLOY.md` § 5 (`supabase storage cp ... --experimental`)
was verified against the local stack before being written down: created a
`tiles` bucket via the Storage API (`POST /storage/v1/bucket`, no CLI
bucket-create verb exists), ran the exact `cp` command form with `--local` in
place of `--linked`, confirmed the object landed and was listable, then
deleted the test bucket/object via the Storage API to leave the local stack
as found (`--experimental storage rm` did not actually remove the object;
worked around with a direct `DELETE` call — noted here in case it affects the
hosted flow too, though § 5 doesn't rely on `rm`).

## Not runnable without hosted credentials (expected, listed in DEPLOY.md)

- `supabase login`, `projects create`/`link` — needs a real Supabase account.
- `db push` against a hosted project, `functions deploy` — needs a linked
  project.
- Storage bucket creation, upload size limit, and the actual 125 MB upload —
  needs a live bucket (CLI syntax pre-verified locally, above).
- Auth provider/confirm-email dashboard toggles — dashboard-only, no CLI
  equivalent found.
- The full post-deploy smoke checklist — needs a real deployed URL.
