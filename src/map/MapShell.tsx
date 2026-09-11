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
import type { SnapToCustom, TerraDraw } from 'terra-draw'
import { buildStyle, LONDON_CENTER, LONDON_ZOOM } from './style'
import { nearestVertexWithin } from './snapping'
import { fillColorExpression } from '../areas/color'
import RatingModal from '../areas/RatingModal'
import { deleteArea, fetchAreas, OfflineWriteError, saveArea, type AreaFeature } from '../db/client'
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

// Terra Draw's own name for the select mode, and the mode name carried in the
// `properties.mode` of every feature we hand it.
const SELECT_MODE = 'select'
const POLYGON_MODE = 'polygon'
const STATIC_MODE = 'static'

// How close (container pixels) a vertex has to land before it snaps to a saved area's
// vertex. Deliberately smaller than the 40px Terra Draw defaults to for its own pointer
// hit-testing: snapping that reaches too far silently moves a vertex the user placed
// carefully, which is the opposite of what G6 is for.
const SNAP_PIXEL_DISTANCE = 20

// The radius within which a tap counts as hitting the polygon's closing point. Terra
// Draw defaults to 40px; at z14 that is well over 100 m of premature-close radius on a
// 390px-wide screen. Halving it is only safe because closing no longer depends on
// hitting that target at all — the "Finish area" button below closes the ring outright.
const POINTER_DISTANCE = 20

// Terra Draw has no public `finish()`; the documented way to close a ring without
// clicking the closing point is the mode's configured finish key. The adapter registers
// its keyup listener on the map canvas (TerraDrawMapLibreGLAdapter#getMapEventElement),
// so the button dispatches the key there rather than relying on canvas focus.
const FINISH_KEY = 'Enter'
const CANCEL_KEY = 'Escape'

type Polygon = { type: 'Polygon'; coordinates: number[][][] }

type PendingFeature = {
  drawId: string
  geometry: Polygon
}

// An open edit session on an already-saved area. While one is open the area is loaded
// into Terra Draw's store under `drawId` so its vertices can be dragged, and is hidden
// from the `saved-areas` source so it is not drawn twice. Cancelling needs no saved
// copy of the original: `areas` is never mutated during a session, so dropping the
// session alone brings the untouched geometry straight back on the next render.
type EditingArea = {
  id: string
  drawId: string
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
  // Resolves once Terra Draw has been fetched and started, or with null if the
  // map was torn down or the import failed. Anything a user can trigger before
  // then waits on this instead of reading `draw.current` and silently doing
  // nothing — see handleStartDrawing.
  const drawReady = useRef<Promise<TerraDraw | null>>(Promise.resolve(null))
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
  // The map's `click` handler and Terra Draw's snap callback are both registered once,
  // on load, so they close over the first render's state. These refs are what they read
  // instead. `editingIdRef` also keeps an area from snapping to its own vertices.
  const pendingRef = useRef<PendingFeature | null>(null)
  pendingRef.current = pendingFeature
  const editingIdRef = useRef<string | null>(null)
  editingIdRef.current = editingArea?.id ?? null
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

    let announceDraw: (ready: TerraDraw | null) => void = () => {}
    drawReady.current = new Promise<TerraDraw | null>((resolve) => {
      announceDraw = resolve
    })

    // G7: Terra Draw and its MapLibre adapter are fetched here rather than
    // imported at the top of the module — 23,946 B gzip that the map does not
    // need to paint, and that nobody can use until there is a map to draw on.
    // The whole handler is async as a result, so everything downstream of it,
    // `setMapReady` included, happens after the modules land. That ordering is
    // deliberate: it keeps a single point at which the drawing surface becomes
    // real, rather than a window where the map looks ready but taps do nothing.
    async function setUpOnLoad() {
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

      // Snap a vertex being placed or dragged onto the nearest vertex of an already-saved
      // area, so neighbouring areas share an exact border coordinate instead of leaving a
      // sliver. Terra Draw's own toCoordinate/toLine snapping cannot do this: saved areas
      // are not in its store. See src/map/snapping.ts.
      const snapToSavedAreas: SnapToCustom = (event, context) =>
        nearestVertexWithin(
          { x: event.containerX, y: event.containerY },
          areasRef.current
            .filter((area) => area.properties.id !== editingIdRef.current)
            .map((area) => area.geometry),
          context.project,
          SNAP_PIXEL_DISTANCE,
        )

      const [
        { TerraDraw, TerraDrawModeUndoRedo, TerraDrawPolygonMode, TerraDrawSelectMode },
        { TerraDrawMapLibreGLAdapter },
      ] = await Promise.all([import('terra-draw'), import('terra-draw-maplibre-gl-adapter')])

      const terraDraw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: instance }),
        modes: [
          new TerraDrawPolygonMode({
            // Without this only the two closing points render; every other vertex the
            // user placed was invisible, so a misplaced one could not even be seen.
            showCoordinatePoints: true,
            editable: true,
            snapping: { toCustom: snapToSavedAreas },
            pointerDistance: POINTER_DISTANCE,
            keyEvents: { finish: FINISH_KEY, cancel: CANCEL_KEY },
          }),
          // Holds a finished polygon — a fresh draw awaiting its rating, or a saved area
          // reopened — with its vertices as drag handles. Polygon mode cannot do this job
          // once drawing is over: a tap on empty map would start a second polygon.
          new TerraDrawSelectMode({
            pointerDistance: POINTER_DISTANCE,
            flags: {
              [POLYGON_MODE]: {
                feature: {
                  // Dragging a whole area is an easy accident and never the intent here;
                  // only its individual vertices and midpoints move.
                  draggable: false,
                  coordinates: {
                    draggable: true,
                    midpoints: true,
                    snappable: { toCustom: snapToSavedAreas },
                  },
                },
              },
            },
          }),
        ],
        undoRedo: { modeLevel: new TerraDrawModeUndoRedo() },
      })
      terraDraw.start()
      terraDraw.setMode(STATIC_MODE)
      draw.current = terraDraw
      announceDraw(terraDraw)
      ;(window as unknown as { __draw?: TerraDraw }).__draw = terraDraw

      terraDraw.on('finish', (id, context) => {
        const feature = terraDraw.getSnapshotFeature(id)
        if (!feature || feature.geometry.type !== 'Polygon') return
        const geometry = closeRing(feature.geometry as Polygon)
        const drawId = String(id)

        // A fresh draw closing its ring. Hand it to the rating sheet, then hold it in
        // select mode rather than static so its vertices stay draggable while the sheet
        // is up — G6 wants a vertex correctable before the first save, not only after.
        if (context.action === 'draw') {
          setPendingFeature({ drawId, geometry })
          setModalVisible(true)
          setIsDrawing(false)
          terraDraw.setMode(SELECT_MODE)
          terraDraw.selectFeature(id)
          return
        }

        // Every other finish action is a coordinate-level edit of a feature already in
        // the store: a dragged vertex, an inserted midpoint, a deleted coordinate. These
        // used to hit an `action !== 'draw'` early return and be dropped, so a dragged
        // vertex never reached save-area and area_cells was never rebuilt from it.
        // Whichever session owns this id takes the new geometry.
        setPendingFeature((prev) => (prev && prev.drawId === drawId ? { ...prev, geometry } : prev))
        setEditingArea((prev) => (prev && prev.drawId === drawId ? { ...prev, geometry } : prev))
      })

      const handleAreaClick = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0]
        if (!feature) return
        const id = feature.properties?.id as string | undefined
        if (!id || feature.properties?.queued) return // not-yet-synced areas aren't editable
        // One session owns the draw store at a time. A tap that lands on another area
        // mid-session would otherwise silently abandon the geometry already being edited.
        if (pendingRef.current || editingIdRef.current) return
        const area = areasRef.current.find((a) => a.properties.id === id)
        if (!area) return

        // Load the saved polygon into Terra Draw so its vertices become drag handles.
        // Reusing the area's own uuid as the feature id keeps the two trivially
        // correlated — Terra Draw's default id strategy is uuid v4, which is exactly
        // what `areas.id` already holds.
        terraDraw.addFeatures([
          {
            id,
            type: 'Feature',
            geometry: area.geometry,
            properties: { mode: POLYGON_MODE },
          },
        ])
        terraDraw.setMode(SELECT_MODE)
        terraDraw.selectFeature(id)

        setEditingArea({
          id: area.properties.id,
          drawId: id,
          rating: area.properties.rating,
          comment: area.properties.comment ?? '',
          geometry: area.geometry,
        })
        setModalVisible(true)
      }
      instance.on('click', SAVED_AREAS_FILL_LAYER, handleAreaClick)

      setMapReady(true)
    }

    instance.on('load', () => {
      void setUpOnLoad().catch((err) => {
        // Without a drawing surface the map is still worth showing — saved
        // areas render from the source added above — so surface the failure
        // rather than leaving the "Draw area" button waiting on a promise that
        // will never settle.
        announceDraw(null)
        setLoadError(err instanceof Error ? err.message : 'Could not load the drawing tools')
      })
    })

    return () => {
      announceDraw(null)
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

  // Keep the rendered source in sync with whichever of synced/queued areas changed. The
  // area under an open edit session is withheld: Terra Draw is drawing it (with its
  // vertex handles) for as long as the session lasts, and painting it from here too
  // would stack a stale copy under the live one.
  useEffect(() => {
    if (!mapReady) return
    const editingId = editingArea?.id
    const combined = combineFeatures(areas, queuedAreas)
    refreshSource(editingId ? combined.filter((f) => f.properties.id !== editingId) : combined)
  }, [mapReady, areas, queuedAreas, editingArea, refreshSource])

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

  // Awaits the Terra Draw import rather than reading `draw.current`: the button
  // is on screen from first paint, and a tap in the window before the modules
  // land would otherwise set `isDrawing` with nothing behind it.
  async function handleStartDrawing() {
    const terraDraw = await drawReady.current
    if (!terraDraw) return
    terraDraw.setMode(POLYGON_MODE)
    setIsDrawing(true)
  }

  function handleUndoVertex() {
    draw.current?.undo()
  }

  // Terra Draw exposes no public finish(); the mode's configured finish key is the
  // supported way in. The adapter listens for keyup on the map canvas, so dispatch it
  // there — this works regardless of what currently holds focus, which a real key press
  // would not. Closing the ring this way means the last vertex can be placed exactly
  // where the user wants it, instead of doubling as a tap on the closing point.
  function handleFinishArea() {
    const canvas = map.current?.getCanvas()
    canvas?.dispatchEvent(new KeyboardEvent('keyup', { key: FINISH_KEY, bubbles: true }))
  }

  // Take the feature out of Terra Draw's store and stand the map down to static.
  function clearDrawSession(drawId: string | undefined) {
    if (drawId) draw.current?.removeFeatures([drawId])
    draw.current?.setMode(STATIC_MODE)
  }

  function handleDismissModal() {
    // Dismissing must not lose geometry (SPEC.md § Field UX). The sheet's backdrop
    // covers the whole map, so dismissing is also the only way to reach the vertex
    // handles: both a pending draw and an open edit session stay alive in Terra Draw,
    // and the "Rate & save" pill brings the sheet back.
    setModalVisible(false)
    setSaveError(null)
  }

  // Abandon an edit session. `areas` was never mutated while it was open, so simply
  // dropping the session re-renders the area with its original, untouched geometry.
  function handleCancelEdit() {
    if (!editingArea) return
    clearDrawSession(editingArea.drawId)
    setEditingArea(null)
    setModalVisible(false)
    setSaveError(null)
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
        clearDrawSession(pendingFeature!.drawId)
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
        clearDrawSession(editingArea!.drawId)
        setAreas((prev) =>
          prev.map((a) =>
            a.properties.id === target.id
              ? {
                  // The geometry goes in alongside the rating: a vertex dragged during
                  // this session is part of what was just saved, and the server has
                  // rebuilt area_cells from it.
                  ...a,
                  geometry: target.geometry,
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
      if (err instanceof OfflineWriteError) {
        const entry: QueuedWrite = { ...input, queuedAt: Date.now() }
        await enqueueWrite(entry)
        setQueuedAreas((prev) => [...prev.filter((q) => q.id !== entry.id), entry])
        if (target.kind === 'create') {
          clearDrawSession(pendingFeature!.drawId)
          setPendingFeature(null)
        } else {
          clearDrawSession(editingArea!.drawId)
          // The queued entry carries `geom`, so an edited outline survives the flush
          // exactly as a fresh draw does. Show it at its edited shape meanwhile.
          setAreas((prev) =>
            prev.map((a) =>
              a.properties.id === target.id ? { ...a, geometry: target.geometry } : a,
            ),
          )
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
      clearDrawSession(editingArea.drawId)
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
  // A dismissed sheet is how the user reaches the vertex handles, so the pill stands in
  // for it during an edit session too, not just for a pending draw.
  const showReopenPill = (pendingFeature !== null || editingArea !== null) && !modalVisible

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

      {/* Thumb-reachable controls, bottom third of the screen (SPEC.md § Field UX).
          bottom-24 (6rem) is the non-notched position; on notched devices the
          rating modal already adds env(safe-area-inset-bottom) the same way
          (see RatingModal's bottom-sheet padding) — do the same here via inline
          style so this wrapper doesn't sit under the home-indicator area, while
          staying at exactly 6rem (bottom-24's value) when the inset is 0. */}
      <div
        className="absolute inset-x-0 flex flex-col items-center gap-2 px-4"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 6rem)" }}
      >
        {showReopenPill && (
          <button
            type="button"
            data-testid="reopen-pending"
            onClick={handleReopenPending}
            // min-h-11 (44px): field-UX tap-target minimum (verified touch bug) —
            // was 36px tall. flex/items-center keeps the label centred at the new height.
            className="flex min-h-11 items-center justify-center rounded-full bg-gray-900 px-4 text-sm font-medium text-white shadow"
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

        {editingArea && !modalVisible && (
          <button
            type="button"
            data-testid="cancel-edit"
            onClick={handleCancelEdit}
            className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-700 shadow"
          >
            Cancel edit
          </button>
        )}

        {isDrawing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="undo-vertex"
              onClick={handleUndoVertex}
              className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-900 shadow"
            >
              Undo point
            </button>
            <button
              type="button"
              data-testid="finish-area"
              onClick={handleFinishArea}
              className="flex min-h-11 items-center justify-center rounded-full bg-gray-900 px-4 text-sm font-medium text-white shadow"
            >
              Finish area
            </button>
          </div>
        ) : (
          !pendingFeature &&
          !editingArea && (
            <button
              type="button"
              data-testid="start-drawing"
              onClick={() => void handleStartDrawing()}
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
