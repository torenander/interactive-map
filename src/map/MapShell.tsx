import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GeolocateControl,
  MapLibreMap,
  addProtocol,
  removeProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Protocol } from 'pmtiles'
import { FunctionsFetchError } from '@supabase/supabase-js'
import { TerraDraw, TerraDrawModeUndoRedo, TerraDrawPolygonMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { buildStyle, LONDON_CENTER, LONDON_ZOOM } from './style'
import { fillColorExpression } from '../areas/color'
import RatingModal from '../areas/RatingModal'
import { deleteArea, fetchAreas, saveArea, type AreaFeature } from '../db/client'
import { useSession } from '../auth/useSession'
import { flushQueuedWrites } from '../offline/flush'
import { enqueueWrite, listQueuedWrites, type QueuedWrite } from '../offline/queue'

// Vite 8 / rolldown does not emit MapLibre's worker chunk from its internal
// `new Worker(new URL(...))`, so the runtime request for the worker falls
// through to index.html and the worker dies parsing HTML. Without a worker
// nothing decodes vector tiles and the map renders background only. Point
// MapLibre at the worker bundle we resolve ourselves.
//
// G5 addendum: WebKit's service worker does not intercept requests for a
// dedicated Worker's script (interception there only covers document/
// main-thread fetches, not worker script loading) — a network-blocked
// reload would fail to spawn the worker at all even though the file is
// precached. Fetch the worker script through a plain `fetch` first (which
// the service worker *does* intercept and can serve from its precache) and
// hand MapLibre a blob URL built from that response, so the browser never
// issues a separate, uninterceptable network request for the worker file.
// The top-level await blocks this module — and therefore the whole app,
// since main.tsx imports it — until the worker source is in hand, so the
// map is never created racing against an unresolved worker URL.
async function resolveWorkerUrl(originalUrl: string): Promise<string> {
  try {
    const response = await fetch(originalUrl)
    if (!response.ok) return originalUrl
    const source = await response.text()
    return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
  } catch {
    return originalUrl
  }
}
setWorkerUrl(await resolveWorkerUrl(workerUrl))

const SAVED_AREAS_SOURCE = 'saved-areas'
const SAVED_AREAS_FILL_LAYER = 'saved-areas-fill'
const SAVED_AREAS_LINE_LAYER = 'saved-areas-line'

type Polygon = { type: 'Polygon'; coordinates: number[][][] }

type PendingFeature = {
  drawId: string
  geometry: Polygon
}

type EditingArea = {
  id: string
  rating: number
  comment: string
  geometry: Polygon
}

// What actually gets rendered: synced areas (from fetchAreas) plus anything still sitting
// in the offline queue, tagged `queued` so the fill/line layers can paint it distinctly.
// docs/DATA-MODEL.md: never render a save as complete before the server has it.
type RenderFeature = {
  type: 'Feature'
  geometry: Polygon
  properties: {
    id: string
    rating: number
    comment: string | null
    created_at: string
    queued?: boolean
  }
}

function toFeatureCollection(features: RenderFeature[]) {
  return {
    type: 'FeatureCollection' as const,
    features,
  }
}

function queuedToRenderFeature(entry: QueuedWrite): RenderFeature {
  return {
    type: 'Feature',
    geometry: entry.geom,
    properties: {
      id: entry.id,
      rating: entry.rating,
      comment: entry.comment,
      created_at: new Date(entry.queuedAt).toISOString(),
      queued: true,
    },
  }
}

// A queued entry always wins over a synced one with the same id — it is the more
// recent, not-yet-confirmed edit (offline edit of an already-saved area, or a still
// in-flight create). Once the flush succeeds the queue entry is gone and the refreshed
// synced list takes over again.
function combineFeatures(synced: AreaFeature[], queued: QueuedWrite[]): RenderFeature[] {
  const queuedIds = new Set(queued.map((q) => q.id))
  const syncedVisible = synced.filter((a) => !queuedIds.has(a.properties.id))
  return [...syncedVisible, ...queued.map(queuedToRenderFeature)]
}

// Terra Draw's polygon geometry may not close its ring (first coordinate repeated as
// last); Postgres/h3-js both expect a closed ring.
function closeRing(polygon: Polygon): Polygon {
  return {
    type: 'Polygon',
    coordinates: polygon.coordinates.map((ring) => {
      if (ring.length === 0) return ring
      const [first] = ring
      const last = ring[ring.length - 1]
      if (first[0] === last[0] && first[1] === last[1]) return ring
      return [...ring, first]
    }),
  }
}

export default function MapShell() {
  const { session } = useSession()
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const draw = useRef<TerraDraw | null>(null)
  const flushingRef = useRef(false)

  const [mapReady, setMapReady] = useState(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const [areas, setAreas] = useState<AreaFeature[]>([])
  const areasRef = useRef<AreaFeature[]>([])
  areasRef.current = areas

  const [queuedAreas, setQueuedAreas] = useState<QueuedWrite[]>([])
  const [flushing, setFlushing] = useState(false)

  const [pendingFeature, setPendingFeature] = useState<PendingFeature | null>(null)
  const [editingArea, setEditingArea] = useState<EditingArea | null>(null)
  const [modalVisible, setModalVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSavedId, setLastSavedId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refreshSource = useCallback((next: RenderFeature[]) => {
    const source = map.current?.getSource(SAVED_AREAS_SOURCE) as GeoJSONSource | undefined
    source?.setData(toFeatureCollection(next))
  }, [])

  // Create map + terra draw once.
  useEffect(() => {
    if (!container.current || map.current) return

    const protocol = new Protocol()
    addProtocol('pmtiles', protocol.tile)

    const instance = new MapLibreMap({
      container: container.current,
      style: buildStyle(),
      center: LONDON_CENTER,
      zoom: LONDON_ZOOM,
      hash: true,
      attributionControl: { compact: false },
    })
    map.current = instance

    // Exposed for end-to-end tests. The DOM alone cannot distinguish a working
    // map from a blank canvas, and that gap already shipped one silent failure.
    ;(window as unknown as { __map?: MapLibreMap }).__map = instance

    const geolocate = new GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserLocation: true,
    })
    geolocate.on('geolocate', (e) => {
      const { latitude, longitude } = e.coords
      window.dispatchEvent(
        new CustomEvent('areamap:geolocate', { detail: { latitude, longitude } }),
      )
    })
    // bottom-right keeps "centre on me" in thumb reach; SPEC.md § Field UX
    // requires controls in the bottom third of the screen.
    instance.addControl(geolocate, 'bottom-right')

    instance.on('load', () => {
      instance.addSource(SAVED_AREAS_SOURCE, {
        type: 'geojson',
        data: toFeatureCollection([]),
        // Without this, queryRenderedFeatures can report the same polygon more than
        // once when it straddles an internal tile boundary (geojson-vt tiles the
        // source even though it's untiled data) — flaky-looking duplicate counts in
        // tests/e2e/offline.spec.ts traced back to exactly this. promoteId tells
        // MapLibre to dedupe using our own uuid instead of a tile-local feature id.
        promoteId: 'id',
      })
      instance.addLayer({
        id: SAVED_AREAS_FILL_LAYER,
        type: 'fill',
        source: SAVED_AREAS_SOURCE,
        paint: {
          'fill-color': fillColorExpression(),
          'fill-opacity': 0.35,
        },
      })
      instance.addLayer({
        id: SAVED_AREAS_LINE_LAYER,
        type: 'line',
        source: SAVED_AREAS_SOURCE,
        paint: {
          'line-color': fillColorExpression(),
          'line-width': 2,
        },
      })

      const terraDraw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: instance }),
        modes: [new TerraDrawPolygonMode()],
        undoRedo: { modeLevel: new TerraDrawModeUndoRedo() },
      })
      terraDraw.start()
      terraDraw.setMode('static')
      draw.current = terraDraw
      ;(window as unknown as { __draw?: TerraDraw }).__draw = terraDraw

      terraDraw.on('finish', (id, context) => {
        if (context.action !== 'draw') return
        const feature = terraDraw.getSnapshotFeature(id)
        if (!feature || feature.geometry.type !== 'Polygon') return
        setPendingFeature({
          drawId: String(id),
          geometry: closeRing(feature.geometry as Polygon),
        })
        setModalVisible(true)
        setIsDrawing(false)
        terraDraw.setMode('static')
      })

      const handleAreaClick = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0]
        if (!feature) return
        const id = feature.properties?.id as string | undefined
        if (!id || feature.properties?.queued) return // not-yet-synced areas aren't editable
        const area = areasRef.current.find((a) => a.properties.id === id)
        if (!area) return
        setEditingArea({
          id: area.properties.id,
          rating: area.properties.rating,
          comment: area.properties.comment ?? '',
          geometry: area.geometry,
        })
        setModalVisible(true)
      }
      instance.on('click', SAVED_AREAS_FILL_LAYER, handleAreaClick)

      setMapReady(true)
    })

    return () => {
      draw.current?.stop()
      draw.current = null
      delete (window as unknown as { __draw?: TerraDraw }).__draw
      instance.remove()
      map.current = null
      delete (window as unknown as { __map?: MapLibreMap }).__map
      removeProtocol('pmtiles')
    }
  }, [])

  // Load saved areas once the map (and its source) exist, and whenever sign-in state
  // changes — a fresh sign-in should pull in that user's areas without a page reload,
  // and signing out clears them from view (RLS would anyway, but don't wait for a
  // failed request to find that out).
  useEffect(() => {
    if (!mapReady) return
    if (!session) {
      setAreas([])
      return
    }
    let cancelled = false
    fetchAreas()
      .then((fetched) => {
        if (cancelled) return
        setAreas(fetched)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Could not load saved areas')
      })
    return () => {
      cancelled = true
    }
  }, [mapReady, session])

  // The offline queue is loaded independently of sign-in state: it can hold entries from
  // a previous session that never got a chance to flush.
  useEffect(() => {
    if (!mapReady) return
    listQueuedWrites()
      .then(setQueuedAreas)
      .catch(() => {
        // Nothing queued is indistinguishable from "couldn't read the queue" here; the
        // next successful queue read (e.g. after the next save attempt) reconciles it.
      })
  }, [mapReady])

  // Keep the rendered source in sync with whichever of synced/queued areas changed.
  useEffect(() => {
    if (!mapReady) return
    refreshSource(combineFeatures(areas, queuedAreas))
  }, [mapReady, areas, queuedAreas, refreshSource])

  const runFlush = useCallback(async () => {
    if (!session || flushingRef.current) return
    flushingRef.current = true
    setFlushing(true)
    try {
      await flushQueuedWrites((entry) =>
        saveArea({ id: entry.id, geom: entry.geom, rating: entry.rating, comment: entry.comment }),
      )
    } finally {
      const remaining = await listQueuedWrites()
      setQueuedAreas(remaining)
      try {
        const fresh = await fetchAreas()
        setAreas(fresh)
      } catch {
        // Stay with what we had; the next successful load reconciles.
      }
      flushingRef.current = false
      setFlushing(false)
    }
  }, [session])

  // Auto-flush when the browser regains connectivity. The manual "Sync now" button
  // (rendered below) exists because this event's timing/reliability under test
  // automation shouldn't be the only way to prove the flush works.
  useEffect(() => {
    function handleOnline() {
      void runFlush()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [runFlush])

  function handleStartDrawing() {
    draw.current?.setMode('polygon')
    setIsDrawing(true)
  }

  function handleUndoVertex() {
    draw.current?.undo()
  }

  function handleDismissModal() {
    // Dismissing must not lose the drawn geometry (SPEC.md § Field UX): for a pending
    // (unsaved) draw we only hide the modal, the feature stays in Terra Draw's store and
    // the "Rate & save" pill reappears. Edits of an already-saved area have nothing to
    // lose, so just clear them.
    setModalVisible(false)
    setSaveError(null)
    if (editingArea) setEditingArea(null)
  }

  function handleReopenPending() {
    setModalVisible(true)
  }

  async function handleSave(rating: number, comment: string) {
    if (!session) {
      setSaveError('Sign in (top right) to save this area')
      return
    }
    const target = pendingFeature
      ? { kind: 'create' as const, id: crypto.randomUUID(), geometry: pendingFeature.geometry }
      : editingArea
        ? { kind: 'edit' as const, id: editingArea.id, geometry: editingArea.geometry }
        : null
    if (!target) return

    setSaving(true)
    setSaveError(null)
    const input = { id: target.id, geom: target.geometry, rating, comment: comment || null }

    try {
      const result = await saveArea(input)
      if (target.kind === 'create') {
        draw.current?.removeFeatures([pendingFeature!.drawId])
        setAreas((prev) => [
          ...prev,
          {
            type: 'Feature' as const,
            geometry: target.geometry,
            properties: {
              id: result.area.id,
              rating: result.area.rating,
              comment: result.area.comment,
              created_at: result.area.created_at,
            },
          },
        ])
        setLastSavedId(result.area.id)
        setPendingFeature(null)
      } else {
        setAreas((prev) =>
          prev.map((a) =>
            a.properties.id === target.id
              ? {
                  ...a,
                  properties: {
                    ...a.properties,
                    rating: result.area.rating,
                    comment: result.area.comment,
                  },
                }
              : a,
          ),
        )
        setEditingArea(null)
      }
      setModalVisible(false)
    } catch (err) {
      // A genuine network failure (server unreachable) queues the write instead of
      // losing it. Any other error (validation, auth) is a real failure and must
      // surface as one — it would fail again identically on flush.
      if (err instanceof FunctionsFetchError) {
        const entry: QueuedWrite = { ...input, queuedAt: Date.now() }
        await enqueueWrite(entry)
        setQueuedAreas((prev) => [...prev.filter((q) => q.id !== entry.id), entry])
        if (target.kind === 'create') {
          draw.current?.removeFeatures([pendingFeature!.drawId])
          setPendingFeature(null)
        } else {
          setEditingArea(null)
        }
        setModalVisible(false)
      } else {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!editingArea) return
    setSaving(true)
    setSaveError(null)
    try {
      await deleteArea(editingArea.id)
      setAreas((prev) => prev.filter((a) => a.properties.id !== editingArea.id))
      if (lastSavedId === editingArea.id) setLastSavedId(null)
      setEditingArea(null)
      setModalVisible(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleUndoLastSave() {
    if (!lastSavedId) return
    await deleteArea(lastSavedId)
    setAreas((prev) => prev.filter((a) => a.properties.id !== lastSavedId))
    setLastSavedId(null)
  }

  const showRatingModal = modalVisible && (pendingFeature !== null || editingArea !== null)
  const showReopenPill = pendingFeature !== null && !modalVisible

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      <div className="absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
        {loadError && (
          <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700 shadow">{loadError}</div>
        )}

        {queuedAreas.length > 0 && (
          <div
            data-testid="queued-banner"
            className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow"
          >
            <span>
              {queuedAreas.length} area{queuedAreas.length > 1 ? 's' : ''} queued — offline, will
              sync
            </span>
            <button
              type="button"
              data-testid="flush-queue"
              disabled={flushing}
              onClick={() => void runFlush()}
              className="whitespace-nowrap rounded-full bg-amber-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {flushing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        )}
      </div>

      {/* Thumb-reachable controls, bottom third of the screen (SPEC.md § Field UX). */}
      <div className="absolute inset-x-0 bottom-24 flex flex-col items-center gap-2 px-4">
        {showReopenPill && (
          <button
            type="button"
            data-testid="reopen-pending"
            onClick={handleReopenPending}
            className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow"
          >
            Rate &amp; save
          </button>
        )}

        {lastSavedId && !isDrawing && (
          <button
            type="button"
            data-testid="undo-last-save"
            onClick={() => void handleUndoLastSave()}
            className="rounded-full bg-white px-4 py-2 text-xs font-medium text-gray-700 shadow"
          >
            Undo last save
          </button>
        )}

        {isDrawing ? (
          <button
            type="button"
            data-testid="undo-vertex"
            onClick={handleUndoVertex}
            className="rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow"
          >
            Undo point
          </button>
        ) : (
          !pendingFeature && (
            <button
              type="button"
              data-testid="start-drawing"
              onClick={handleStartDrawing}
              className="rounded-full bg-gray-900 px-5 py-3 text-base font-medium text-white shadow"
            >
              Draw area
            </button>
          )
        )}
      </div>

      {showRatingModal && (
        <RatingModal
          mode={pendingFeature ? 'create' : 'edit'}
          initialRating={editingArea?.rating ?? 0}
          initialComment={editingArea?.comment ?? ''}
          saving={saving}
          error={saveError}
          onDismiss={handleDismissModal}
          onSave={(rating, comment) => void handleSave(rating, comment)}
          onDelete={editingArea ? () => void handleDelete() : undefined}
        />
      )}
    </div>
  )
}
