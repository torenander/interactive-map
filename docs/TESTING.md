# Testing conventions

## What gets tested

**Unit (vitest)** — the parts where a bug corrupts data silently:
- H3 derivation from a polygon
- Offline write queue: persistence across reload, idempotent retry, failed flush behaviour
- Rating validation
- Schema constraints against a local Supabase instance (checks, cascades, RLS isolation)

**E2E (Playwright, iPhone 14 viewport, 390x844)** — one flow per goal, not exhaustive coverage:
- `map-shell.spec.ts` — map renders, viewport, attribution, geolocate
- `mvp-loop.spec.ts` — draw, rate, save, reload, edit, delete
- `offline.spec.ts` — save with network blocked, flush on reconnect
- `offline-map.spec.ts` — tiles from cache with network blocked

**Not tested** — third-party surface, low value:
- MapLibre rendering internals
- Tile loading and pmtiles range requests
- Terra Draw internals

## Rules

- Every PR that touches `src/areas` or a migration needs a test.
- Every PR that touches `src/ui` needs a mobile-viewport screenshot in the description.
- A test that asserts nothing about behaviour is not a test. `expect(true).toBe(true)`, a test with no assertion, or a test that only checks a function did not throw does not count towards a goal's exit criteria.
- Do not change an existing assertion to make a new implementation pass. If the assertion is wrong, say so and stop.
- Mobile viewport first. Desktop is verified after, never instead.

## Commands

```bash
npm run test              # vitest, all unit
npm run test -- tests/unit/queue.test.ts
npm run test:e2e          # playwright, mobile viewport
npm run test:e2e -- tests/e2e/mvp-loop.spec.ts
npx supabase db reset     # rebuild local DB from migrations before schema tests
```
