import { layers, namedFlavor } from '@protomaps/basemaps'
import type { StyleSpecification } from 'maplibre-gl'

export const LONDON_CENTER: [number, number] = [-0.1276, 51.5072] // Charing Cross
export const LONDON_ZOOM = 11

// Local dev / existing tests: same-origin file under public/tiles, unchanged.
// Production: VITE_TILES_URL points at the Supabase Storage public bucket
// object (a different origin) — set at build time, see .env.example and
// docs/DEPLOY.md. src/sw.ts's pmtiles route must recognize this same URL.
const configuredTilesUrl = (import.meta.env.VITE_TILES_URL as string | undefined)?.trim()
const TILES_URL = configuredTilesUrl
  ? `pmtiles://${configuredTilesUrl}`
  : 'pmtiles:///tiles/london.pmtiles'
const ATTRIBUTION =
  '<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
    sources: {
      protomaps: {
        type: 'vector',
        url: TILES_URL,
        attribution: ATTRIBUTION,
      },
    },
    layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
  }
}
