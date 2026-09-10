import { useEffect, useRef } from 'react'
import { MapLibreMap, addProtocol, removeProtocol, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Protocol } from 'pmtiles'
import { buildStyle, LONDON_CENTER, LONDON_ZOOM } from './style'

// Vite 8 / rolldown does not emit MapLibre's worker chunk from its internal
// `new Worker(new URL(...))`, so the runtime request for the worker falls
// through to index.html and the worker dies parsing HTML. Without a worker
// nothing decodes vector tiles and the map renders background only. Point
// MapLibre at the worker bundle we resolve ourselves.
setWorkerUrl(workerUrl)

export default function MapShell() {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)

  useEffect(() => {
    if (!container.current || map.current) return

    const protocol = new Protocol()
    addProtocol('pmtiles', protocol.tile)

    map.current = new MapLibreMap({
      container: container.current,
      style: buildStyle(),
      center: LONDON_CENTER,
      zoom: LONDON_ZOOM,
      hash: true,
      attributionControl: { compact: false },
    })

    // Exposed for end-to-end tests. The DOM alone cannot distinguish a working
    // map from a blank canvas, and that gap already shipped one silent failure.
    ;(window as unknown as { __map?: MapLibreMap }).__map = map.current

    return () => {
      map.current?.remove()
      map.current = null
      delete (window as unknown as { __map?: MapLibreMap }).__map
      removeProtocol('pmtiles')
    }
  }, [])

  return <div ref={container} className="h-full w-full" />
}
