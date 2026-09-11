// G6 exit criteria (docs/OBJECTIVES.md § G6): every placed vertex is visible, any vertex
// can be dragged to correct it, the ring closes by an explicit control rather than by
// re-tapping the first vertex, and vertices snap to the borders of existing areas — with
// geometry edits reaching the server through save-area so area_cells is rebuilt.
//
// Runs at 390x844 (playwright.config.ts pins the only project there).
//
// On input: taps use page.touchscreen, as touch-draw.spec.ts does, because that is how
// the app is actually used. Drags use page.mouse — Terra Draw's adapter listens for
// pointerdown/pointermove/pointerup (not touch events), which the engine synthesises from
// mouse input, and Playwright has no multi-step touch-drag primitive.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { polygonToCells } from 'h3-js'

// Must match supabase/functions/save-area/index.ts.
const H3_RESOLUTION = 10
// Must match SNAP_PIXEL_DISTANCE in src/map/MapShell.tsx.
const SNAP_PIXEL_DISTANCE = 20

type Polygon = { type: 'Polygon'; coordinates: number[][][] }

function readLocalSupabaseEnv(): Record<string, string> {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    env[match[1]] = match[2].replace(/^"(.*)"$/, '$1')
  }
  return env
}

// Every test in this file shares one user and clears that user's areas in beforeEach,
// so they must not overlap: run in declaration order, one at a time. (playwright.config.ts
// sets fullyParallel, which otherwise applies within a file too.)
test.describe.configure({ mode: 'serial' })

let admin: SupabaseClient
let apiUrl: string
let serviceKey: string
let userId: string
const email = `draw-precision-${randomUUID()}@example.com`
const password = 'correct-horse-battery-staple'

test.beforeAll(async () => {
  const env = readLocalSupabaseEnv()
  apiUrl = env.API_URL ?? env.SUPABASE_URL
  serviceKey = env.SERVICE_ROLE_KEY
  admin = createClient(apiUrl, serviceKey)
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('test user not created')
  userId = data.user.id
})

test.afterAll(async () => {
  if (userId) {
    await admin.from('areas').delete().eq('user_id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
})

// Areas are per-test, not per-file: each test draws what it needs and must not inherit
// another test's shapes (snapping in particular would see them).
test.beforeEach(async () => {
  await admin.from('areas').delete().eq('user_id', userId)
})

// PostgREST returns `geography` as WKB hex by default; `Accept: application/geo+json`
// makes it do the ST_AsGeoJSON conversion server side, the same trick src/db/client.ts
// uses to read areas back without a WKB parser.
async function fetchGeometries(): Promise<{ id: string; geometry: Polygon }[]> {
  const res = await fetch(`${apiUrl}/rest/v1/areas?select=id,geom&order=created_at.asc`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/geo+json',
    },
  })
  if (!res.ok) throw new Error(`read areas failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {
    features: { properties: { id: string }; geometry: Polygon }[]
  }
  return body.features.map((f) => ({ id: f.properties.id, geometry: f.geometry }))
}

async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })

  await page.getByTestId('open-sign-in').tap()
  const form = page.getByTestId('sign-in-form')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Sign in' }).tap()
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

async function canvasOrigin(page: Page) {
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

// Where a lng/lat currently sits in page coordinates — the only reliable way to aim a
// drag at a vertex handle, since the handle is painted at the projected coordinate.
async function pageXYOf(page: Page, coordinate: number[]) {
  const origin = await canvasOrigin(page)
  const projected = await page.evaluate((coord) => {
    const map = (window as unknown as { __map: { project(c: number[]): { x: number; y: number } } })
      .__map
    const point = map.project(coord)
    return { x: point.x, y: point.y }
  }, coordinate)
  return { x: origin.x + projected.x, y: origin.y + projected.y }
}

async function lngLatOf(page: Page, pageX: number, pageY: number) {
  const origin = await canvasOrigin(page)
  return page.evaluate(
    ({ x, y }) => {
      const map = (
        window as unknown as { __map: { unproject(p: [number, number]): { lng: number; lat: number } } }
      ).__map
      const { lng, lat } = map.unproject([x, y])
      return [lng, lat]
    },
    { x: pageX - origin.x, y: pageY - origin.y },
  )
}

// Terra Draw reads pointerdown/move/up. A single jump from press to release is not a
// drag as far as it is concerned — the intermediate moves are what make it one.
async function dragOnCanvas(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
}

function drawSnapshot(page: Page) {
  return page.evaluate(() => {
    const draw = (
      window as unknown as {
        __draw: {
          getSnapshot(): {
            geometry: { type: string; coordinates: unknown }
            properties: Record<string, unknown>
          }[]
        }
      }
    ).__draw
    return draw.getSnapshot().map((f) => ({
      type: f.geometry.type,
      coordinates: f.geometry.coordinates,
      properties: f.properties,
    }))
  })
}

async function saveWithRating(page: Page, rating: -1 | 0 | 1) {
  await page.getByTestId(`rating-${rating}`).tap()
  await page.getByTestId('save-area').tap()
  await expect(page.getByTestId('rating-modal')).toBeHidden()
}

test('every placed vertex gets a handle, and Finish area closes the ring where the user put it', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('start-drawing').tap()

  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2
  // Four distinct vertices, none of them a return to the first — the ring must close
  // without the closing-point tap that used to be the only touch route.
  const vertices = [
    { x: cx - 70, y: cy - 90 },
    { x: cx + 70, y: cy - 90 },
    { x: cx + 70, y: cy + 10 },
    { x: cx - 70, y: cy + 10 },
  ]
  for (const vertex of vertices) {
    await page.touchscreen.tap(vertex.x, vertex.y)
  }

  // Before G6 only the two closingPoint markers rendered, however many vertices had been
  // placed, so a misplaced one was literally invisible. Now every coordinate in the ring
  // carries its own handle: the placed vertices, plus the provisional coordinate that
  // trails the pointer until the next tap commits it.
  const snapshot = await drawSnapshot(page)
  const coordinatePoints = snapshot.filter(
    (f) => f.type === 'Point' && f.properties.coordinatePoint,
  )
  const inProgress = snapshot.find((f) => f.type === 'Polygon')!
  expect(inProgress.properties.committedCoordinateCount).toBe(vertices.length)

  // Assert on where the handles actually are rather than on how many Terra Draw keeps:
  // the ring in progress also carries a provisional coordinate that trails the pointer,
  // and its bookkeeping is an internal detail. What G6 promises is that a vertex the
  // user placed is visible, so check each placed vertex has a handle sitting on it.
  const handles: { x: number; y: number }[] = []
  for (const point of coordinatePoints) {
    handles.push(await pageXYOf(page, point.coordinates as number[]))
  }
  for (const vertex of vertices) {
    const covered = handles.some(
      (h) => Math.abs(h.x - vertex.x) < 3 && Math.abs(h.y - vertex.y) < 3,
    )
    expect(covered, `no vertex handle rendered at (${vertex.x}, ${vertex.y})`).toBe(true)
  }

  const expected = []
  for (const vertex of vertices) {
    expected.push(await lngLatOf(page, vertex.x, vertex.y))
  }

  await page.getByTestId('finish-area').tap()
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await saveWithRating(page, 1)

  const saved = await fetchGeometries()
  expect(saved).toHaveLength(1)
  const ring = saved[0].geometry.coordinates[0]
  // Four vertices plus the repeated closing coordinate.
  expect(ring).toHaveLength(vertices.length + 1)
  expect(ring[0]).toEqual(ring[ring.length - 1])
  // Compare as a set, not index by index: the ring comes back from PostGIS rotated to
  // its own starting vertex, and which corner it starts at is not something this goal
  // has any opinion about. What matters is that the four corners the finger placed are
  // the four corners that were stored, at the pixels they were tapped at.
  const storedXY = []
  for (const coordinate of ring.slice(0, -1)) {
    storedXY.push(await pageXYOf(page, coordinate))
  }
  for (const vertex of vertices) {
    const matches = storedXY.filter(
      (p) => Math.abs(p.x - vertex.x) < 2 && Math.abs(p.y - vertex.y) < 2,
    )
    expect(matches, `no stored coordinate at tapped vertex (${vertex.x}, ${vertex.y})`).toHaveLength(
      1,
    )
  }
})

test('a vertex of a saved area can be dragged, and the saved outline and its cells follow', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('start-drawing').tap()

  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2
  for (const vertex of [
    { x: cx - 70, y: cy - 90 },
    { x: cx + 70, y: cy - 90 },
    { x: cx + 70, y: cy + 10 },
    { x: cx - 70, y: cy + 10 },
  ]) {
    await page.touchscreen.tap(vertex.x, vertex.y)
  }
  await page.getByTestId('finish-area').tap()
  await saveWithRating(page, 1)

  const [before] = await fetchGeometries()
  const originalRing = before.geometry.coordinates[0]

  // Reopen the saved area. The sheet's backdrop covers the map, so dismissing it is how
  // the vertex handles become reachable at all.
  await page.touchscreen.tap(cx, cy - 40)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  // RatingModal deliberately ignores any click within 50ms of mount — that is the WebKit
  // ghost-click guard (docs/TASKS-FIX-TOUCH.md), and toBeVisible can resolve inside that
  // window. Wait it out so this taps the settled backdrop, as a user would.
  await page.waitForTimeout(200)
  await page.touchscreen.tap(origin.x + origin.width / 2, origin.y + 40) // backdrop
  await expect(page.getByTestId('rating-modal')).toBeHidden()
  await expect(page.getByTestId('reopen-pending')).toBeVisible()

  // Drag the top-left vertex up and to the left by a distance no tap tolerance could
  // account for.
  const handle = await pageXYOf(page, originalRing[0])
  const target = { x: handle.x - 45, y: handle.y - 45 }
  await dragOnCanvas(page, handle, target)
  const movedTo = await lngLatOf(page, target.x, target.y)

  await page.getByTestId('reopen-pending').tap()
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await saveWithRating(page, 1)

  await page.reload()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })

  const [after] = await fetchGeometries()
  expect(after.id).toBe(before.id)
  const movedRing = after.geometry.coordinates[0]
  expect(movedRing).not.toEqual(originalRing)

  // The stored ring comes back rotated to its own starting vertex, so look for the
  // dragged corner by position rather than by index: one coordinate now sits where the
  // vertex was dropped, and none is left behind where it was picked up.
  const movedXY = []
  for (const coordinate of movedRing.slice(0, -1)) {
    movedXY.push(await pageXYOf(page, coordinate))
  }
  const atTarget = movedXY.filter(
    (p) => Math.abs(p.x - target.x) < 3 && Math.abs(p.y - target.y) < 3,
  )
  expect(atTarget, 'no stored coordinate where the vertex was dropped').toHaveLength(1)
  const leftBehind = movedXY.filter(
    (p) => Math.abs(p.x - handle.x) < 3 && Math.abs(p.y - handle.y) < 3,
  )
  expect(leftBehind, 'a coordinate stayed where the vertex was picked up').toHaveLength(0)
  expect(movedTo).toHaveLength(2)

  // areas.geom is the source of truth and area_cells is derived from it (CLAUDE.md).
  // Before G6 a dragged vertex never reached save-area at all, so this is the assertion
  // that proves the edit went through the one write path rather than only into React.
  const { data: cells, error } = await admin
    .from('area_cells')
    .select('h3_index')
    .eq('area_id', after.id)
  if (error) throw error
  const stored = new Set((cells ?? []).map((c) => c.h3_index))
  const derived = new Set(polygonToCells(after.geometry.coordinates, H3_RESOLUTION, true))
  expect(stored.size).toBeGreaterThan(0)
  expect(stored).toEqual(derived)
})

test('a vertex dropped near a saved border snaps onto that exact coordinate', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('start-drawing').tap()

  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2
  for (const vertex of [
    { x: cx - 90, y: cy - 90 },
    { x: cx + 10, y: cy - 90 },
    { x: cx + 10, y: cy - 10 },
    { x: cx - 90, y: cy - 10 },
  ]) {
    await page.touchscreen.tap(vertex.x, vertex.y)
  }
  await page.getByTestId('finish-area').tap()
  await saveWithRating(page, 1)

  const [first] = await fetchGeometries()
  // The south-east corner of the first area: the one the neighbour will reach for.
  const shared = first.geometry.coordinates[0][2]
  const sharedXY = await pageXYOf(page, shared)

  await page.getByTestId('start-drawing').tap()
  // Deliberately off-target by less than the snap radius — the kind of miss a thumb makes.
  const offBy = Math.round(SNAP_PIXEL_DISTANCE / 2)
  await page.touchscreen.tap(sharedXY.x + offBy, sharedXY.y + offBy)
  await page.touchscreen.tap(sharedXY.x + 100, sharedXY.y + 10)
  await page.touchscreen.tap(sharedXY.x + 100, sharedXY.y + 90)
  await page.touchscreen.tap(sharedXY.x + 10, sharedXY.y + 90)
  await page.getByTestId('finish-area').tap()
  await saveWithRating(page, -1)

  const geometries = await fetchGeometries()
  expect(geometries).toHaveLength(2)
  const neighbour = geometries.find((g) => g.id !== first.id)!

  // Exactly equal, not merely close: the point of snapping is a shared border coordinate.
  // Note what this is not — the two polygons still overlap as two independent rings.
  // Nothing unions, clips or repairs them (docs/ARCHITECTURE.md § "No geometry union").
  const snapped = neighbour.geometry.coordinates[0].some(
    (coord) => coord[0] === shared[0] && coord[1] === shared[1],
  )
  expect(snapped).toBe(true)
})
