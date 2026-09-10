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
import { TerraDraw, TerraDrawModeUndoRedo, TerraDrawPolygonMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { buildStyle, LONDON_CENTER, LONDON_ZOOM } from './style'
import { ratingFillColorExpression } from '../areas/color'
import RatingModal from '../areas/RatingModal'
import { deleteArea, fetchAreas, saveArea, type AreaFeature } from '../db/client'
import { useSession } from '../auth/useSession'

// Vite 8 / rolldown does not emit MapLibre's worker chunk from its internal
// `new Worker(new URL(...))`, so the runtime request for the worker falls
// through to index.html and the worker dies parsing HTML. Without a worker
// nothing decodes vector tiles and the map renders background only. Point
// MapLibre at the worker bundle we resolve ourselves.
setWorkerUrl(workerUrl)

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

function toFeatureCollection(areas: AreaFeature[]) {
  return {
    type: 'FeatureCollection' as const,
    features: areas,
  }
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

  const [mapReady, setMapReady] = useState(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const [areas, setAreas] = useState<AreaFeature[]>([])
  const areasRef = useRef<AreaFeature[]>([])
  areasRef.current = areas

  const [pendingFeature, setPendingFeature] = useState<PendingFeature | null>(null)
  const [editingArea, setEditingArea] = useState<EditingArea | null>(null)
  const [modalVisible, setModalVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSavedId, setLastSavedId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refreshSource = useCallback((next: AreaFeature[]) => {
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
      })
      instance.addLayer({
        id: SAVED_AREAS_FILL_LAYER,
        type: 'fill',
        source: SAVED_AREAS_SOURCE,
        paint: {
          'fill-color': ratingFillColorExpression(),
          'fill-opacity': 0.35,
        },
      })
      instance.addLayer({
        id: SAVED_AREAS_LINE_LAYER,
        type: 'line',
        source: SAVED_AREAS_SOURCE,
        paint: {
          'line-color': ratingFillColorExpression(),
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
        if (!id) return
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
      refreshSource([])
      return
    }
    let cancelled = false
    fetchAreas()
      .then((fetched) => {
        if (cancelled) return
        setAreas(fetched)
        refreshSource(fetched)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Could not load saved areas')
      })
    return () => {
      cancelled = true
    }
  }, [mapReady, session, refreshSource])

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
    setSaving(true)
    setSaveError(null)
    try {
      if (pendingFeature) {
        const id = crypto.randomUUID()
        const result = await saveArea({
          id,
          geom: pendingFeature.geometry,
          rating,
          comment: comment || null,
        })
        draw.current?.removeFeatures([pendingFeature.drawId])
        const next = [
          ...areasRef.current,
          {
            type: 'Feature' as const,
            geometry: pendingFeature.geometry,
            properties: {
              id: result.area.id,
              rating: result.area.rating,
              comment: result.area.comment,
              created_at: result.area.created_at,
            },
          },
        ]
        setAreas(next)
        refreshSource(next)
        setLastSavedId(result.area.id)
        setPendingFeature(null)
        setModalVisible(false)
      } else if (editingArea) {
        const result = await saveArea({
          id: editingArea.id,
          geom: editingArea.geometry,
          rating,
          comment: comment || null,
        })
        const next = areasRef.current.map((a) =>
          a.properties.id === editingArea.id
            ? {
                ...a,
                properties: {
                  ...a.properties,
                  rating: result.area.rating,
                  comment: result.area.comment,
                },
              }
            : a,
        )
        setAreas(next)
        refreshSource(next)
        setEditingArea(null)
        setModalVisible(false)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
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
      const next = areasRef.current.filter((a) => a.properties.id !== editingArea.id)
      setAreas(next)
      refreshSource(next)
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
    const next = areasRef.current.filter((a) => a.properties.id !== lastSavedId)
    setAreas(next)
    refreshSource(next)
    setLastSavedId(null)
  }

  const showRatingModal = modalVisible && (pendingFeature !== null || editingArea !== null)
  const showReopenPill = pendingFeature !== null && !modalVisible

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      {loadError && (
        <div className="absolute left-3 right-3 top-3 rounded-lg bg-red-50 p-2 text-xs text-red-700 shadow">
          {loadError}
        </div>
      )}

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
