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

**(manual, one-time for bucket creation only — see correction below)** The
CLI's `storage` subcommand group (`ls cp mv rm`) has no bucket-*create* verb.
Create it via the dashboard (Dashboard → Storage → New bucket → name `tiles`,
**Public bucket** = on) or via the Storage API directly:
```bash
curl -X POST "https://<project-ref>.supabase.co/storage/v1/bucket" \
  -H "Authorization: Bearer <service-role-key>" \
  -H "apikey: <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{"id":"tiles","name":"tiles","public":true}'
```

**Correction, confirmed on a live free-tier project:** the "raise the global
upload size limit" step in earlier drafts of this doc is **not achievable on
free tier, by dashboard or API**. `GET /v1/projects/{ref}/config/storage`
(Management API, personal access token) shows `fileSizeLimit: 52428800` (50
MiB) by default; `PATCH`ing any larger value returns **HTTP 402**: *"Please
upgrade the project to a paid plan to unlock higher file size limits."* This
is a hard plan-tier ceiling, not a togglable setting — the dashboard's
storage-settings page enforces the same limit and offers no override on free
tier. `public/tiles/london.pmtiles` (~131 MB) cannot be uploaded to free-tier
Supabase Storage at all. Two real options once you hit this:

- **Interim (what production currently uses):** extract a smaller
  inner-London-only archive that fits under 50 MiB and upload that instead —
  see the Production section below for the exact command and bbox used.
- **Upgrade path:** host the full archive on Cloudflare R2 (free tier, no
  per-file size cap, CORS you configure yourself) or upgrade the Supabase
  project to Pro. Both are documented in the Production section.

Upload (CLI, once the bucket exists — the `storage` command group is
experimental and needs the flag below; verified against this project's local
stack, substituting `--local` for `--linked`, that this exact form of the
command succeeds and the file is retrievable afterwards):
```bash
npx supabase storage cp public/tiles/london.pmtiles ss:///tiles/london.pmtiles --linked --experimental
```
(`ss://` is the CLI's storage-path prefix; the first `tiles` segment is the
bucket name from step 1, not the local `public/tiles/` dev path.) Or use the
Storage API directly with `curl --data-binary @<file>` against
`POST /storage/v1/object/tiles/<name>` — this is what was actually used in
production, since the CLI's experimental `storage cp` was not re-verified
against the hosted project once the interim-extract path was chosen.

Get the public URL: Dashboard → Storage → `tiles` bucket → object → Copy URL,
or construct it directly:
```
https://<project-ref>.supabase.co/storage/v1/object/public/tiles/<name>.pmtiles
```
This is the value for `VITE_TILES_URL` in step 7. Public Supabase Storage
buckets send permissive CORS headers by default (`access-control-allow-origin: *`,
confirmed by `curl -H "Origin: ..."` against the live bucket), which
`src/sw.ts`'s pmtiles route depends on for cross-origin range caching (see
that file's comments) — no separate CORS configuration step is needed.

## 6. Auth configuration

Dashboard → Authentication → Providers → **Email** → confirm enabled (on by
default for new projects, but verify).

**Correction, confirmed on a live free-tier project: this is scriptable, not
manual.** The Management API's auth config endpoint accepts the confirm-email
toggle directly and works on free tier:
```bash
# GET first to see current field names/values (GoTrue config, not dashboard labels):
curl https://api.supabase.com/v1/projects/<project-ref>/config/auth \
  -H "Authorization: Bearer <personal-access-token>"

# Then turn confirm-email off:
curl -X PATCH https://api.supabase.com/v1/projects/<project-ref>/config/auth \
  -H "Authorization: Bearer <personal-access-token>" \
  -H "Content-Type: application/json" \
  -d '{"mailer_autoconfirm": true}'
```
This returned HTTP 200 with `mailer_autoconfirm: true` in the response — no
dashboard visit needed. (The personal access token is the same one `supabase
login` already stored; on macOS it's in the login keychain under service
"Supabase CLI".) The dashboard path, if you prefer it, is unchanged:
Authentication → Providers → Email → **Confirm email** → OFF.

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

**Confirmed working, branch path:** build `dist/` locally, then push it as
the sole commit of an orphan `gh-pages` branch:
```bash
git worktree add /tmp/gh-pages-deploy --detach
cd /tmp/gh-pages-deploy
git checkout --orphan gh-pages
git rm -rf .
cp -r <repo>/dist/. .
touch .nojekyll   # public/ files starting with "_" would otherwise be swallowed by Jekyll
git add -A && git commit -m "deploy: production build to gh-pages"
git push origin gh-pages --force
```
`dist/` includes everything under `public/` verbatim (Vite copies it
unconditionally). If more than one `public/tiles/*.pmtiles` file exists
locally (e.g. the untracked dev `london.pmtiles` alongside the tracked
production `london-z14.pmtiles` — see the Tiles section below for why
production is same-origin, not third-party-hosted), **strip everything
except the one production actually uses** before committing to `gh-pages`:
```bash
rm -f tiles/london.pmtiles tiles/london-inner.pmtiles   # keep tiles/london-z14.pmtiles
```
Shipping the untracked 131 MB dev archive would fail GitHub's 100 MB
single-file push limit; shipping a stale interim one just wastes branch
space.

Then enable Pages on that branch:
```bash
gh api repos/<owner>/<repo>/pages -X POST -f "source[branch]=gh-pages" -f "source[path]=/"
```
On this repo the branch push alone had already triggered GitHub to
auto-enable Pages on `gh-pages` (the API call above returned 409 "already
enabled" — `gh api repos/<owner>/<repo>/pages` confirmed `"status":"built"`,
`"source":{"branch":"gh-pages"}`) — run the enable call anyway since
auto-enable isn't documented/guaranteed behavior; treat 409 as success.

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
1–8 are complete. **Update:** it has been — see Production below; all four
items pass against the live URL, verified with a scripted Playwright
(WebKit, iPhone 14, 390x844) smoke suite rather than by hand.

## Production

- **Live URL:** https://torenander.github.io/interactive-map/
- **Supabase project ref:** `hqjrrkoaccgbueinuvjv` (org `guhkqtnclgnqnhltndtu`,
  region `eu-west-2`, free tier)
- **Deploy mechanism:** `gh-pages` branch (not a GitHub Actions workflow —
  `.github/**` belongs to a separate CD-workflow effort; see step 8's
  "Confirmed working, branch path").

### Tiles: final architecture — in-repo maxzoom-14, same-origin

Production serves tiles from the **same origin as the app shell**
(`https://torenander.github.io/interactive-map/tiles/london-z14.pmtiles`),
not from a third-party host. There is no cross-origin fetch, no CORS surface,
and nothing for a browser's connection/preflight handling to get wrong for
this request path.

**Why not the full `london.pmtiles` (131 MB, maxzoom 15) or a third-party
host:**
- Free-tier Supabase Storage caps uploads at 50 MiB (step 5's correction,
  confirmed via the Management API returning HTTP 402) — the full archive
  can't be uploaded there at all.
- An interim inner-London-only extract (`london-inner.pmtiles`, 44.6 MB,
  bbox `-0.26,51.435,0.07,51.575`) was deployed briefly on Supabase Storage
  to unblock a first field-test. It worked in scripted verification (curl
  206 + magic bytes, curl CORS headers, one successful real-WebKit
  non-opaque Range fetch) but the **live deployed site then failed
  intermittently in real WebKit** — `fetch()` to that URL threw
  `TypeError: Load failed` on some page loads. CORS preflight was
  independently re-checked and is correct (`OPTIONS` returns
  `access-control-allow-headers: range` etc.), so the underlying cause
  (likely resource contention between the SW's full-file background fetch
  and dozens of concurrent per-tile range fetches, or Cloudflare-edge
  behavior under WebKit specifically) was never fully pinned down — it
  wasn't worth the time once a same-origin option removed the entire
  failure class. **This interim object has been deleted from the bucket**
  (`DELETE /storage/v1/object/tiles/london-inner.pmtiles`); do not expect it
  to still exist if you go looking.
- Cloudflare R2 was considered and **rejected by the user** — R2 (and any
  other usage-billed cloud storage) is off the table; the user does not want
  uncapped-billing exposure. Do not set one up. If this file is ever
  revisited, the free, no-card alternative is **Backblaze B2** (10 GB free
  storage, no payment method required to sign up, S3-compatible API,
  CORS you configure yourself) — undocumented here beyond this pointer since
  it was never built.
- A paid Supabase Pro plan (~$25/mo) would also lift the 50 MiB cap but was
  likewise not chosen, for the same reason.

**What's actually deployed:** a maxzoom-14 (one zoom level below the 131 MB
dev archive's maxzoom-15) extract of the same Greater London bbox
`scripts/fetch-tiles.sh` uses (that script itself is unmodified and still
produces the untracked, maxzoom-15, local-dev `public/tiles/london.pmtiles`):
```bash
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles public/tiles/london-z14.pmtiles \
  --bbox="-0.510375,51.28676,0.334015,51.691874" --maxzoom=14
```
This produced a 55.9 MB archive — under git's 100 MB single-blob hard limit
(GitHub prints a harmless ">50 MB" advisory warning on push suggesting Git
LFS; ignore it, LFS is unnecessary at this size and adds its own quota
concerns). It **is committed to the repo** at
`public/tiles/london-z14.pmtiles` — `.gitignore`'s blanket
`public/tiles/*.pmtiles` rule has a `!public/tiles/london-z14.pmtiles`
negation carved out for exactly this one file; the dev/local
`london.pmtiles` stays untracked as before.

Vite copies everything under `public/` into `dist/` verbatim, so this file
ships to `dist/tiles/london-z14.pmtiles` automatically and is served by
GitHub Pages same-origin — confirmed with a real `GET` + `Range: bytes=0-15`
against the live URL: `HTTP/2 206`, `content-range: bytes 0-15/55891073`,
correct `PMTiles` magic bytes. (A `HEAD`/`curl -I` request against a Range
header does **not** reliably show `206`/`content-range` — GitHub Pages, like
most servers, only slices the body on a real `GET`; don't use `-I` to verify
range support.)

Build sets `VITE_TILES_URL` to a same-origin relative path, not a full URL:
```bash
VITE_TILES_URL=/interactive-map/tiles/london-z14.pmtiles
```
`src/map/style.ts` wraps this as `pmtiles://${VITE_TILES_URL}`, which
resolves relative to the document's own origin — no hardcoded host. `src/sw.ts`'s
`isPmtilesRequest` matches this via its pre-existing same-origin fallback
(any request path ending in `.pmtiles`), unchanged from the local-dev
behavior — no code change was needed for the same-origin case, only the
build-time env var.

**Deploying `dist/` to `gh-pages` needs one manual step beyond step 8's
generic sequence:** `public/` in this repo contains three `*.pmtiles` files
locally (the untracked dev `london.pmtiles`, an untracked leftover
`london-inner.pmtiles` from the interim deploy, and the tracked
`london-z14.pmtiles`) and Vite copies *all three* into `dist/tiles/`
regardless of which one `VITE_TILES_URL` points at. Only the production one
should reach the `gh-pages` branch:
```bash
# after cp -r dist/. into the gh-pages worktree, before git add:
rm -f tiles/london.pmtiles tiles/london-inner.pmtiles
```
Leaving the others in would either fail GitHub's 100 MB push limit
(`london.pmtiles` is 131 MB) or just waste branch space for a file nothing
references.

**Precache check:** `vite.config.ts`'s `VitePWA({ injectManifest: { globPatterns: [...] } })`
does not include `.pmtiles` in its glob, so the service worker's install-time
precache manifest never includes this 56 MB file (confirmed:
`precache 10 entries (2211 KiB)` at build time, and a runtime check of
`caches.keys()`/`cache.keys()` on the live site found it only in the
`pmtiles-v1` runtime range-cache, never in the `workbox-precache-v2-*`
cache). It's fetched on demand via `src/sw.ts`'s range-request route, exactly
as the cross-origin case was designed to work, just same-origin now.

### Auth

"Confirm email" is off via the Management API (`PATCH .../config/auth`,
`{"mailer_autoconfirm": true}`) — see step 6's correction. No dashboard
step was needed for this deploy.

### Smoke test results (final, z14 same-origin deploy)

Scripted (Playwright, WebKit, iPhone 14 device profile, 390×844 viewport)
against the live URL, using a disposable admin-created user (`email_confirm:
true`, deleted afterward along with its rows — verified zero remaining rows
and zero remaining matching users post-cleanup):

| Check | Result |
|---|---|
| HTTPS load, `#root` attached | 200, pass |
| Map canvas renders (non-zero size) | pass |
| Vector tiles decode and paint at Charing Cross (default centre) | pass (1688 rendered features, 0 page errors) |
| Vector tiles decode and paint at Croydon (`jumpTo`, well outside the old interim bbox's southern edge) | pass (25 rendered features) — proves real Greater-London-wide coverage, not just the previously-covered inner zone |
| Sign-in (hosted auth, confirm-email off) | pass |
| Draw + rate + save round trip | pass |
| Reload → area still present | pass (1 row via admin query) |
| Service worker registered and controlling on reload | pass, scope `https://torenander.github.io/interactive-map/` |
| Manifest fetchable, correct `start_url`/`scope` | pass, both `/interactive-map/` |
| pmtiles file absent from the precache manifest (only in the runtime range-cache) | pass |
| Cleanup (area rows + test user deleted) | pass, verified 0 remaining |

Screenshots: `/tmp/deploy-smoke/01-map-loaded-z14.png`,
`02-croydon-outside-inner-bbox.png`, `03-area-saved-z14.png`,
`04-after-reload-z14.png`. (Superseded interim-deploy screenshots from the
Supabase-hosted stage: `01-map-loaded.png`, `02-area-saved.png`,
`03-after-reload.png`.)

One item from the original checklist above (offline reload with the
background full-file cache already warm) was not re-verified independently
in this pass — it's covered by the existing `offline-map.spec.ts` e2e test
against the same `src/sw.ts` code path; not re-run against the live
same-origin file specifically, though same-origin removes the one variable
(cross-origin CORS/opaque-response handling) that `offline-map.spec.ts`'s
same-origin fixture couldn't already exercise.

### Secrets handling

DB password: `~/.areamap-db-password` (chmod 600, not in the repo). No
service-role or personal-access-token values were written to disk, this
document, or any command output during this deploy — retrieved into shell
variables per-command via `security find-generic-password` (CLI's stored
token) or the Management API's `projects api-keys` output redirected
straight to a 600-permission file, and unset immediately after use.
