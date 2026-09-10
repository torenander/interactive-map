# Production deploy runbook

A numbered, runnable path from a clean checkout to a hosted Supabase project
and a static-host deploy. Run each numbered step top to bottom. Steps marked
**(manual)** cannot be scripted without live hosted credentials — do them by
hand, or hand the exact dashboard location to whoever has the account.

Prereqs: Supabase CLI (`npx supabase --version`), a Supabase account, and a
static host of your choice (Netlify, Vercel, Cloudflare Pages, GitHub Pages,
S3+CloudFront, ...). Run all commands from the repo root.

## 1. Supabase CLI auth

```bash
npx supabase login
```
**(manual)** Opens a browser OAuth flow (or pass `--token <access-token>` for
a non-interactive run — generate one at
https://supabase.com/dashboard/account/tokens).

## 2. Create or link the hosted project

New project:
```bash
npx supabase projects create areamap --org-id <your-org-id> --region eu-west-2 --db-password '<strong-password>'
```
`--org-id` comes from `npx supabase orgs list`. Pick a region close to where
you'll use the app; `eu-west-2` (London) matches this project's data.

Then link the local repo to it:
```bash
npx supabase link --project-ref <project-ref>
```
`<project-ref>` is the 20-char id shown by `projects create`/`projects list`
and in the dashboard URL (`https://supabase.com/dashboard/project/<ref>`).
This prompts for the DB password from step 2 unless `-p` is passed.

## 3. Push schema migrations

```bash
npx supabase db push --linked
```
Applies `supabase/migrations/0001`–`0007` **in filename order** — `db push`
always does this automatically; the important thing is not to cherry-pick or
hand-apply a subset out of order, since 0005/0006/0007 each `create or
replace` the same `save_area_tx` function and 0007 revokes grants that 0001's
table creation assumed were open. `0001_tables.sql` runs `create extension if
not exists postgis` — confirmed bundled on both hosted Postgres images this
project has been tested against (17.6.1.167, 15.14.1.170), so this succeeds
with no extra step. No `h3`/`h3_postgis` extension is used anywhere (cell
derivation is server-side JS in the edge function, not a DB extension — see
migration 0001's deviation note).

Verify: `npx supabase migration list --linked` should show all seven
(`0001`–`0007`) as applied on the remote.

## 4. Deploy the edge function

```bash
npx supabase functions deploy save-area --project-ref <project-ref>
```
This is the sole write path for `areas` (CLAUDE.md) — required before the
app can save anything. No other functions exist in `supabase/functions/`.

## 5. Storage bucket for the pmtiles archive

**(manual, one-time)** The CLI's `storage` subcommand group (`ls cp mv rm`)
has no bucket-*create* verb — create the bucket via the dashboard:

1. Dashboard → Storage → New bucket → name `tiles`, **Public bucket** = on.
2. Dashboard → Storage → Settings (or Project Settings → Storage) → confirm
   the project's global upload size limit is raised above 125 MB (the file is
   `public/tiles/london.pmtiles`, currently ~131 MB / 125 MiB). Free-tier
   projects sometimes default lower than this — raise it before uploading or
   the next step 413s.
   `supabase/config.toml`'s `file_size_limit = "50MiB"` is the **local** dev
   stack's setting only; it has no effect on the hosted project.

Upload the file (CLI, once the bucket exists and the limit is raised — the
`storage` command group is experimental and needs the flag below; verified
against this project's local stack, substituting `--local` for `--linked`,
that this exact form of the command succeeds and the file is retrievable
afterwards):
```bash
npx supabase storage cp public/tiles/london.pmtiles ss:///tiles/london.pmtiles --linked --experimental
```
(`ss://` is the CLI's storage-path prefix; the first `tiles` segment is the
bucket name from step 1, not the local `public/tiles/` dev path — the
uploaded object ends up at `tiles/london.pmtiles` inside the bucket.)
Or drag-and-drop the file into the bucket from the dashboard if you'd rather
watch a progress bar for a 125 MB upload than trust a CLI copy over your
connection.

Get the public URL: Dashboard → Storage → `tiles` bucket → `london.pmtiles` →
Copy URL, or construct it directly:
```
https://<project-ref>.supabase.co/storage/v1/object/public/tiles/london.pmtiles
```
This is the value for `VITE_TILES_URL` in step 7. Public Supabase Storage
buckets send permissive CORS headers by default, which `src/sw.ts`'s pmtiles
route depends on for cross-origin range caching (see that file's comments) —
no separate CORS configuration step is needed.

## 6. Auth configuration

**(manual)** Dashboard → Authentication → Providers → **Email** → confirm
enabled (on by default for new projects, but verify).

Dashboard → Authentication → Providers → Email → **Confirm email** → turn
**OFF**.

Why this exact toggle: `src/auth/SignIn.tsx` is sign-in only — there is no
sign-up UI, no password-reset flow, and `src/db/client.ts`'s
`signInWithEmail`/`signUpWithEmail` never pass a `redirectTo` (confirmed by
reading both files — nothing in `src/auth/**` or `src/db/client.ts` assumes
`localhost` or any other origin, so no code change was needed here). The one
account is created out of band (`supabase.auth.admin.createUser` via the
dashboard's Authentication → Users → Add user, or the admin API) with a
password, and signs in directly. With "Confirm email" left on, that
dashboard-created user is stuck in an unconfirmed state with no in-app flow
to resend or click a confirmation link, and sign-in fails. Turning it off is
correct for this single-user, no-self-serve-signup app; if you later add a
real sign-up flow, replace this with SMTP configuration
(Authentication → Settings → SMTP Settings) instead of leaving confirmation
off.

## 7. Build

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co \
VITE_SUPABASE_ANON_KEY=<anon-key-from-dashboard-api-settings> \
VITE_TILES_URL=https://<project-ref>.supabase.co/storage/v1/object/public/tiles/london.pmtiles \
npm run build
```
All three are optional overrides — unset, the build defaults to the local
dev stack (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`) and the same-origin
`/tiles/london.pmtiles` path (`VITE_TILES_URL`), which is what every existing
test exercises. Output is `dist/`.

`VITE_SUPABASE_ANON_KEY`: Dashboard → Project Settings → API → `anon`
`public` key (not `service_role`).

## 8. Deploy `dist/`

Host-agnostic: upload the contents of `dist/` to any static host that serves
files as-is with correct MIME types (Netlify, Vercel, Cloudflare Pages,
S3+CloudFront all work with zero extra config — point them at `dist/` as the
publish directory). Two things every host must get right:
- `dist/sw.js` must be served with `Cache-Control` that doesn't stick around
  indefinitely (most static hosts already set short/no-cache on non-hashed
  filenames like `sw.js`; verify if yours doesn't) — a stale service worker
  otherwise never picks up a new deploy for existing visitors.
- No server-side routing/redirect config is needed — this is a single route,
  no client-side router (confirmed: no `react-router` or similar dependency).

### GitHub Pages subsection

GitHub Pages project sites (not a custom domain / user site) serve from
`https://<user>.github.io/<repo>/` — a subpath, not `/`. Every root-relative
path this app emits (JS/CSS asset URLs, the manifest's `start_url`/`scope`,
icon paths, the service worker's own scope) must be prefixed with `/<repo>/`
or the deploy 404s on every asset.

This is handled by `VITE_BASE`, added to `vite.config.ts` for this purpose —
unset (default `/`), it changes nothing from steps above. For a GitHub Pages
project site:
```bash
VITE_BASE=/<repo>/ \
VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... VITE_TILES_URL=... \
npm run build
```
This sets Vite's `base`, and both the manifest's `start_url`/`scope` and the
icon paths in `vite.config.ts`'s `VitePWA({ manifest: {...} })` block follow
it — vite-plugin-pwa derives the service worker's own registration scope
from Vite's `base` automatically, so all three stay consistent without a
separate setting. Verified: a default (`VITE_BASE` unset) build's
`dist/manifest.webmanifest` still has `"start_url":"/","scope":"/"` and
root-relative icon paths, byte-identical in shape to pre-change output.

Deploy `dist/` to the `gh-pages` branch (or via the `actions/deploy-pages`
GitHub Action) per GitHub's normal Pages flow — outside this runbook's scope
since `.github/**` is off-limits for this change (a concurrent `ci` branch
owns CI/workflow files).

## 9. Post-deploy smoke checklist

Run through this against the live deployed URL:

- [ ] Sign-in works against hosted auth (the dashboard-created account, step
      6) — confirms `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are correct
      and email confirmation is off.
- [ ] Save round-trip: draw an area, rate it, save, reload, confirm it's
      still there — confirms the `save-area` edge function (step 4) and RLS
      grants (migration 0007) are correctly deployed.
- [ ] Tiles load and render on first visit (cold cache) — confirms
      `VITE_TILES_URL` (step 5/7) resolves and the bucket serves range
      requests with CORS.
- [ ] Reload once more, then go offline (airplane mode or devtools "Offline")
      and reload again — map still renders. Confirms the service worker's
      background full-file cache fill completed and cross-origin range
      caching in `src/sw.ts` works against the real Storage bucket, not just
      the same-origin local fixture this repo's e2e tests use.
- [ ] Browser offers an install prompt (or "Add to Home Screen" on mobile)
      — confirms the manifest and service worker registration are both
      reachable at the paths the browser expects (relevant if deployed under
      a subpath — see GitHub Pages subsection).

Nothing in this checklist can be scripted without a live hosted project, a
real bucket upload, and a real static-host deploy — do it by hand once steps
1–8 are complete.
