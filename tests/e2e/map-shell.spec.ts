import { test, expect } from '@playwright/test'

test('app mounts at the mobile target viewport', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#root')).toBeAttached()
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
})

const GREATER_LONDON = { west: -0.510375, south: 51.28676, east: 0.334015, north: 51.691874 }

test('map canvas renders with non-zero size', async ({ page }) => {
  await page.goto('/')
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
})

test('initial viewport is within Greater London', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.location.hash.length > 1)
  const [, lat, lng] = page.url().split('#')[1].split('/').map(Number)
  expect(lat).toBeGreaterThan(GREATER_LONDON.south)
  expect(lat).toBeLessThan(GREATER_LONDON.north)
  expect(lng).toBeGreaterThan(GREATER_LONDON.west)
  expect(lng).toBeLessThan(GREATER_LONDON.east)
})

test('OpenStreetMap attribution is in the DOM', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap')
})

// Regression guard. Every DOM assertion above passed while the map rendered
// nothing: Vite did not emit MapLibre's worker chunk, the request fell through
// to index.html, and the worker died parsing HTML. No worker means no vector
// tile decoding. Assert that tiles actually decoded and painted.
test('vector tiles decode and paint', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto('/')
  await page.waitForFunction(() => window.location.hash.length > 1)

  const featureCount = await page.waitForFunction(
    () => {
      const map = (window as unknown as { __map?: { isStyleLoaded(): boolean; queryRenderedFeatures(): unknown[] } }).__map
      if (!map || !map.isStyleLoaded()) return 0
      const n = map.queryRenderedFeatures().length
      return n > 0 ? n : 0
    },
    undefined,
    { timeout: 20_000 },
  )

  expect(await featureCount.jsonValue()).toBeGreaterThan(0)
  expect(pageErrors).toEqual([])
})

test('geolocate control fires a geolocate event with the mocked position', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.maplibregl-ctrl-geolocate')).toBeVisible()

  const fired = page.evaluate(
    () =>
      new Promise<{ latitude: number; longitude: number }>((resolve) => {
        window.addEventListener(
          'areamap:geolocate',
          (e) => resolve((e as CustomEvent).detail),
          { once: true },
        )
      }),
  )

  await page.locator('.maplibregl-ctrl-geolocate').click()

  const detail = await fired
  expect(detail.latitude).toBeCloseTo(51.5072, 3)
  expect(detail.longitude).toBeCloseTo(-0.1276, 3)
})

test('geolocate control sits in the bottom third of the viewport', async ({ page }) => {
  await page.goto('/')
  const box = await page.locator('.maplibregl-ctrl-geolocate').boundingBox()
  expect(box!.y).toBeGreaterThan(844 * (2 / 3))
})
