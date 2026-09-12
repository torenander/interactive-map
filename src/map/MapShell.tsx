import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
// Source and layer ids, and the rule that overlays sit below every annotation layer,
// live in ./layers so this file and ./overlays cannot drift apart on them.
import {
  BRUSH_FILL_LAYER,
  BRUSH_LINE_LAYER,
  BRUSH_SOURCE,
  SAVED_AREAS_FILL_LAYER,
  SAVED_AREAS_LINE_LAYER,
  SAVED_AREAS_SOURCE,
  SAVED_FEATURES_CIRCLE_LAYER,
  SAVED_FEATURES_LINE_LAYER,
  SAVED_FEATURES_SOURCE,
} from './layers'
import {
  OVERLAYS,
  loadEnabledOverlays,
  overlayAddPlan,
  overlayLayerIds,
  overlaySourceId,
  saveEnabledOverlays,
  type OverlayId,
} from './overlays'
import { nearestVertexWithin } from './snapping'
// G7 budget: the brush core pulls in h3-js (63,121 B gzip) and nothing about it is
// needed to paint a map — the same case as Terra Draw. Only its types are imported
// statically (erased at build time); the module itself is fetched when brush mode is
// entered. See loadBrush below.
import type { BrushMode, BrushSelection, BrushSize } from './brush'
import { fillColorExpression } from '../areas/color'
import RatingModal from '../areas/RatingModal'
import { deleteArea, fetchAreas, OfflineWriteError, saveArea, type AreaFeature } from '../db/client'
import { useSession } from '../auth/useSession'
import { flushQueuedWrites } from '../offline/flush'
import { enqueueWrite, listQueuedWrites, type QueuedWrite } from '../offline/queue'
import {
  deleteFeature,
  fetchFeatures,
  kindForGeometry,
  saveFeature,
  type FeatureGeometry,
  type FeatureKind,
  type MapFeature,
} from '../db/features'
import {
  enqueueFeatureWrite,
  flushQueuedFeatureWrites,
  listQueuedFeatureWrites,
  type QueuedFeatureWrite,
} from '../offline/featureQueue'

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
//
// G7: that await used to be the first moment the worker was asked for, which
// put its ~500KB strictly after the entry chunk had downloaded and evaluated —
// measured on the deployed build, the entry finished at 963ms, the worker ran
// 1082-1329ms, and the first tile range request only went out at 1820ms. The
// build now starts that fetch from an inline script in the document head (see
// vite.config.ts) and parks the promise here, so the bytes are already on
// their way by the time this module runs. The guarantee is unchanged: this
// still awaits the source before `setWorkerUrl`, it just no longer waits to
// begin. `vite dev` injects no such script, and the fallback below covers it.
declare global {
  interface Window {
    __mapWorkerSource?: Promise<string | null>
  }
}

async function resolveWorkerUrl(originalUrl: string): Promise<string> {
  try {
    const source = await (window.__mapWorkerSource ??
      fetch(originalUrl).then((response) => (response.ok ? response.text() : null)))
    if (source === null) return originalUrl
    return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
  } catch {
    return originalUrl
  }
}
setWorkerUrl(await resolveWorkerUrl(workerUrl))


// Terra Draw's own name for the select mode, and the mode name carried in the
// `properties.mode` of every feature we hand it.
const SELECT_MODE = 'select'
const POLYGON_MODE = 'polygon'
const POINT_MODE = 'point'
const LINESTRING_MODE = 'linestring'
const STATIC_MODE = 'static'

// Circle radius for a saved point. 7px at the default pixel ratio is a ~14px target
// before the 44px tap tolerance queryRenderedFeatures is given below — big enough to see
// against a rated area's fill, small enough not to hide the street it marks.
const FEATURE_CIRCLE_RADIUS = 7
// How far from a point or line a tap still counts as hitting it. Field-UX tap targets are
// 44px (docs/TASKS-FIX-TOUCH.md); a 14px circle needs the slack to be thumb-reachable.
const FEATURE_TAP_SLOP = 22

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

// A polygon waiting for its rating. `drawId` is the feature's id in Terra Draw's store
// for a drawn polygon, and `null` for a brushed one — the brush never puts anything in
// that store, it synthesises the polygon from painted cells instead. Everything
// downstream (the rating sheet, saveArea, the offline queue) treats the two identically.
type PendingFeature = {
  drawId: string | null
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

// A point or line drawn but not yet rated. Deliberately parallel to PendingFeature
// rather than merged with it: the two go to different tables through different write
// paths, and keeping them apart means none of the area code above had to change.
type PendingMapFeature = {
  drawId: string
  kind: FeatureKind
  geometry: FeatureGeometry
}

// An open edit session on a saved point or line. `drawId` is null for a plain
// rating/comment edit and set once a MOVE is opened (G13) — at which point the feature is
// loaded into Terra Draw's store under that id and withheld from the saved-features
// source, exactly as EditingArea does for polygons. Cancelling needs no saved copy of the
// original: `mapFeatures` is never mutated during a session, so dropping the session
// brings the untouched geometry straight back on the next render.
type EditingMapFeature = {
  id: string
  drawId: string | null
  kind: FeatureKind
  rating: number
  comment: string
  geometry: FeatureGeometry
}

type RenderMapFeature = {
  type: 'Feature'
  geometry: FeatureGeometry
  properties: {
    id: string
    kind: FeatureKind
    rating: number
    comment: string | null
    created_at: string
    queued?: boolean
  }
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? 's' : ''}`
}

function queuedToRenderMapFeature(entry: QueuedFeatureWrite): RenderMapFeature {
  return {
    type: 'Feature',
    geometry: entry.geom,
    properties: {
      id: entry.id,
      kind: entry.kind,
      rating: entry.rating,
      comment: entry.comment,
      created_at: new Date(entry.queuedAt).toISOString(),
      queued: true,
    },
  }
}

// Same precedence rule combineFeatures applies to areas: a queued entry wins over a
// synced row with the same id, because it is the more recent, not-yet-confirmed edit.
function combineMapFeatures(
  synced: MapFeature[],
  queued: QueuedFeatureWrite[],
): RenderMapFeature[] {
  const queuedIds = new Set(queued.map((q) => q.id))
  return [
    ...synced.filter((f) => !queuedIds.has(f.properties.id)),
    ...queued.map(queuedToRenderMapFeature),
  ]
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

  // Brush mode. `brushSelectionRef` is the working copy the pointer handlers read and
  // write: pointermove fires far faster than React re-renders, and a handler reading
  // state would keep stamping onto a selection one or more events stale. State exists to
  // drive rendering, and every change goes through `applySelection` so the two agree.
  const [brushing, setBrushing] = useState(false)
  // `null` until the brush module has been fetched and a session opened: there is no
  // selection to speak of before either.
  const [brushSelection, setBrushSelection] = useState<BrushSelection | null>(null)
  const brushSelectionRef = useRef<BrushSelection | null>(null)
  // The fetched module, and the in-flight fetch. Everything that touches the brush runs
  // after brush mode is entered, so `brushModule.current` is set by the time any of it
  // is reachable; the promise is what the entry point waits on.
  const brushModule = useRef<typeof import('./brush') | null>(null)
  const brushLoad = useRef<Promise<typeof import('./brush') | null> | null>(null)
  const [brushLoading, setBrushLoading] = useState(false)
  const [brushSize, setBrushSize] = useState<BrushSize>(2)
  const brushSizeRef = useRef<BrushSize>(brushSize)
  brushSizeRef.current = brushSize
  const [brushMode, setBrushMode] = useState<BrushMode>('paint')
  const brushModeRef = useRef<BrushMode>(brushMode)
  brushModeRef.current = brushMode
  const [brushNotice, setBrushNotice] = useState<string | null>(null)

  // Overlays. Read from localStorage during the first render rather than in an effect:
  // the choice is two or three ids, and loading it late would paint the map once without
  // the layers the user left on and then again with them.
  const [enabledOverlays, setEnabledOverlays] = useState<OverlayId[]>(() =>
    loadEnabledOverlays(typeof window === 'undefined' ? undefined : window.localStorage),
  )
  const [overlaySheetOpen, setOverlaySheetOpen] = useState(false)
  // Read by the saved-area click handler, which is registered once on load.
  const brushingRef = useRef(false)
  brushingRef.current = brushing

  const [areas, setAreas] = useState<AreaFeature[]>([])
  const areasRef = useRef<AreaFeature[]>([])
  areasRef.current = areas

  const [queuedAreas, setQueuedAreas] = useState<QueuedWrite[]>([])
  const [flushing, setFlushing] = useState(false)

  const [pendingFeature, setPendingFeature] = useState<PendingFeature | null>(null)
  const [editingArea, setEditingArea] = useState<EditingArea | null>(null)

  const [mapFeatures, setMapFeatures] = useState<MapFeature[]>([])
  const mapFeaturesRef = useRef<MapFeature[]>([])
  mapFeaturesRef.current = mapFeatures
  const [queuedMapFeatures, setQueuedMapFeatures] = useState<QueuedFeatureWrite[]>([])
  const [pendingMapFeature, setPendingMapFeature] = useState<PendingMapFeature | null>(null)
  const [editingMapFeature, setEditingMapFeature] = useState<EditingMapFeature | null>(null)
  // Which point/line mode the user is in the middle of, or null. Only 'linestring' needs
  // a finish control; a point is complete the moment it is placed.
  const [featureMode, setFeatureMode] = useState<FeatureKind | null>(null)
  // The map's `click` handler and Terra Draw's snap callback are both registered once,
  // on load, so they close over the first render's state. These refs are what they read
  // instead. `editingIdRef` also keeps an area from snapping to its own vertices.
  const pendingRef = useRef<PendingFeature | null>(null)
  pendingRef.current = pendingFeature
  const editingIdRef = useRef<string | null>(null)
  editingIdRef.current = editingArea?.id ?? null
  const pendingMapFeatureRef = useRef<PendingMapFeature | null>(null)
  pendingMapFeatureRef.current = pendingMapFeature
  const editingMapFeatureIdRef = useRef<string | null>(null)
  editingMapFeatureIdRef.current = editingMapFeature?.id ?? null
  const movingFeatureIdRef = useRef<string | null>(null)
  movingFeatureIdRef.current = editingMapFeature?.drawId ?? null
  // The hover affordance is only correct when nothing else owns the pointer: Terra Draw
  // and the brush set their own cursors, and overriding one mid-gesture would flicker.
  const hoverIdleRef = useRef(true)
  hoverIdleRef.current =
    !brushing &&
    !isDrawing &&
    featureMode === null &&
    pendingFeature === null &&
    editingArea === null &&
    pendingMapFeature === null &&
    editingMapFeature === null
  const [modalVisible, setModalVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSavedId, setLastSavedId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refreshSource = useCallback((next: RenderFeature[]) => {
    const source = map.current?.getSource(SAVED_AREAS_SOURCE) as GeoJSONSource | undefined
    source?.setData(toFeatureCollection(next))
  }, [])

  // The one way the brush selection changes: ref first (so the next pointer event builds
  // on it), then state for the render.
  const applySelection = useCallback((next: BrushSelection | null) => {
    brushSelectionRef.current = next
    setBrushSelection(next)
    // Exposed for end-to-end tests, for the same reason `__map` and `__draw` are: the
    // rendered fill proves *something* is painted, but only the cell ids show that a
    // stroke covered what it was meant to, or that an erase took exactly those cells.
    ;(window as unknown as { __brushCells?: string[] }).__brushCells = next ? [...next.cells] : []
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

    // Desktop: a right-drag rotates and pitches a MapLibre map by default. Measured on a
    // 1440x900 desktop context, one stray right-drag took bearing 0 -> -146.7 and pitch
    // 0 -> 60, and nothing in this app can undo that — only GeolocateControl is
    // registered below, so there is no compass and no reset-north. Removing the gesture
    // beats adding a control to recover from it: nothing here benefits from a rotated or
    // tilted map (north-up is what a neighbourhood rating is read against), and on touch
    // it was only ever reachable by a deliberate two-finger gesture, so nobody loses a
    // capability they were using.
    instance.dragRotate.disable()
    instance.touchPitch.disable()

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

      // In-progress paint: one MultiPolygon of the painted cells' outlines, in blue with
      // a dashed edge. Nothing here is rating-coloured and nothing here is in the
      // saved-areas source, so a selection cannot be mistaken for a saved area by eye or
      // by queryRenderedFeatures.
      instance.addSource(BRUSH_SOURCE, {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [] }, properties: {} },
      })
      instance.addLayer({
        id: BRUSH_FILL_LAYER,
        type: 'fill',
        source: BRUSH_SOURCE,
        paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.4 },
      })
      instance.addLayer({
        id: BRUSH_LINE_LAYER,
        type: 'line',
        source: BRUSH_SOURCE,
        paint: { 'line-color': '#1d4ed8', 'line-width': 2, 'line-dasharray': [2, 1] },
      })

      // Points and lines last, so they paint above the area fills and the brush. G9
      // requires a point inside a rated area to stay tappable, and draw order is half of
      // that — the other half is the precedence rule in handleAreaClick below.
      instance.addSource(SAVED_FEATURES_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        // Same reason the areas source sets it: dedupe queryRenderedFeatures by our own
        // uuid rather than a tile-local id.
        promoteId: 'id',
      })
      instance.addLayer({
        id: SAVED_FEATURES_LINE_LAYER,
        type: 'line',
        source: SAVED_FEATURES_SOURCE,
        filter: ['==', ['get', 'kind'], 'line'],
        paint: {
          'line-color': fillColorExpression(),
          'line-width': 4,
        },
      })
      instance.addLayer({
        id: SAVED_FEATURES_CIRCLE_LAYER,
        type: 'circle',
        source: SAVED_FEATURES_SOURCE,
        filter: ['==', ['get', 'kind'], 'point'],
        paint: {
          'circle-color': fillColorExpression(),
          'circle-radius': FEATURE_CIRCLE_RADIUS,
          // A white collar keeps a point legible on top of a same-coloured area fill —
          // a green point on a green area is otherwise invisible.
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
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
        {
          TerraDraw,
          TerraDrawLineStringMode,
          TerraDrawModeUndoRedo,
          TerraDrawPointMode,
          TerraDrawPolygonMode,
          TerraDrawSelectMode,
        },
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
              // G13. A point has one coordinate, so moving it is moving the feature;
              // a line is reshaped by its coordinates and must not slide as a whole,
              // which is the same reasoning that makes an area undraggable above.
              [POINT_MODE]: {
                feature: { draggable: true },
              },
              [LINESTRING_MODE]: {
                feature: {
                  draggable: false,
                  coordinates: {
                    draggable: true,
                    // Adding or deleting vertices is out of scope for G13 — this moves
                    // the vertices a line already has.
                    midpoints: false,
                  },
                },
              },
            },
          }),
          // One tap places a point and finishes it — there is no second vertex to wait
          // for, so no finish control applies to this mode.
          new TerraDrawPointMode(),
          // Lines get the same precision treatment polygons got in G6: every placed
          // vertex visible, snapping to saved area borders, and a closing radius small
          // enough not to swallow a deliberate last vertex — "Finish line" ends it.
          new TerraDrawLineStringMode({
            showCoordinatePoints: true,
            editable: true,
            snapping: { toCustom: snapToSavedAreas },
            pointerDistance: POINTER_DISTANCE,
            keyEvents: { finish: FINISH_KEY, cancel: CANCEL_KEY },
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
        if (!feature) return
        const drawId = String(id)

        // Split on the ACTION first, then the geometry. Before G13 the point/line branch
        // ran unconditionally, because a finish on a feature could only ever mean a fresh
        // placement. Once a saved feature can be dragged that stopped being true: the
        // drag's finish was read as a new placement, which reopened the sheet and queued a
        // second feature instead of moving the one in hand.
        if (context.action === 'draw') {
          // A point finishes on its single tap; a line finishes on the "Finish line"
          // control, which dispatches the same key polygons use. Both go straight to the
          // rating sheet — no select-mode hold, because placement is finished and any
          // later adjustment is a move session (G13).
          if (feature.geometry.type === 'Point' || feature.geometry.type === 'LineString') {
            const geometry = feature.geometry as FeatureGeometry
            setPendingMapFeature({ drawId, kind: kindForGeometry(geometry), geometry })
            setModalVisible(true)
            setFeatureMode(null)
            terraDraw.setMode(STATIC_MODE)
            return
          }
          // A fresh ring closing. Hand it to the sheet, then hold it in select mode rather
          // than static so its vertices stay draggable while the sheet is up — G6 wants a
          // vertex correctable before the first save, not only after.
          if (feature.geometry.type === 'Polygon') {
            setPendingFeature({ drawId, geometry: closeRing(feature.geometry as Polygon) })
            setModalVisible(true)
            setIsDrawing(false)
            terraDraw.setMode(SELECT_MODE)
            terraDraw.selectFeature(id)
          }
          return
        }

        // Every other action is a coordinate-level edit of something already in the store:
        // a dragged vertex, an inserted midpoint, a deleted coordinate, a dragged point.
        // These used to hit an `action !== 'draw'` early return and be dropped, so an
        // edit never reached the server. Whichever session owns this id takes the geometry.
        if (feature.geometry.type === 'Polygon') {
          const geometry = closeRing(feature.geometry as Polygon)
          setPendingFeature((prev) =>
            prev && prev.drawId === drawId ? { ...prev, geometry } : prev,
          )
          setEditingArea((prev) => (prev && prev.drawId === drawId ? { ...prev, geometry } : prev))
          return
        }
        // A move session on a saved point or line (G13). Terra Draw hands back the
        // geometry it now holds; the saved row is untouched until the sheet is saved.
        const moved = feature.geometry as FeatureGeometry
        setEditingMapFeature((prev) =>
          prev && prev.drawId === drawId ? { ...prev, geometry: moved } : prev,
        )
      })

      // Is there a saved point or line under this tap? Asked with a slop box rather than
      // the exact pixel, because a 14px circle is not a 44px tap target on its own.
      const featuresUnder = (e: MapLayerMouseEvent) =>
        instance.queryRenderedFeatures(
          [
            [e.point.x - FEATURE_TAP_SLOP, e.point.y - FEATURE_TAP_SLOP],
            [e.point.x + FEATURE_TAP_SLOP, e.point.y + FEATURE_TAP_SLOP],
          ],
          { layers: [SAVED_FEATURES_CIRCLE_LAYER, SAVED_FEATURES_LINE_LAYER] },
        )

      // Opening a saved point or line for rating. Registered on the map rather than on
      // the feature layers so the slop box above decides the hit, not MapLibre's exact
      // per-layer hit test — otherwise the tap target is the drawn circle and nothing more.
      const handleFeatureClick = (e: MapLayerMouseEvent) => {
        if (brushingRef.current) return
        if (pendingRef.current || editingIdRef.current) return
        if (pendingMapFeatureRef.current || editingMapFeatureIdRef.current) return
        const hit = featuresUnder(e)[0]
        if (!hit) return
        const id = hit.properties?.id as string | undefined
        if (!id || hit.properties?.queued) return // not-yet-synced features aren't editable
        const saved = mapFeaturesRef.current.find((f) => f.properties.id === id)
        if (!saved) return

        setEditingMapFeature({
          id: saved.properties.id,
          drawId: null,
          kind: saved.properties.kind,
          rating: saved.properties.rating,
          comment: saved.properties.comment ?? '',
          geometry: saved.geometry,
        })
        setModalVisible(true)
      }
      instance.on('click', handleFeatureClick)

      const handleAreaClick = (e: MapLayerMouseEvent) => {
        // Precedence, decided once and recorded in docs/TASKS-G8.md: while brush mode is
        // active the pointer belongs to the brush, and nothing else. A stroke that
        // crosses a saved area paints over it; it does not also open an edit session on
        // it, which is what this early return prevents (the click MapLibre fires after
        // pointerup would otherwise arrive here). The converse is enforced at the
        // entry points: brush mode cannot be started while a draw or edit session is
        // open, and exiting brush mode hands taps back to this handler.
        if (brushingRef.current) return
        // Second rule, added in G9 and recorded in docs/TASKS-G9.md: a point or line
        // under the tap beats the area beneath it. Features are small marks drawn on top
        // of large translucent fills, so without this an area would swallow every tap on
        // a point inside it — which G9's done_when explicitly forbids. The reverse is
        // never a problem: an area is still tappable everywhere a feature is not.
        if (featuresUnder(e).length > 0) return
        if (pendingMapFeatureRef.current || editingMapFeatureIdRef.current) return
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

      // Desktop discoverability: with a mouse, the cursor is the only thing that says a
      // shape is interactive, and it read `grab` over saved areas, lines and points —
      // identical to empty map. Terra Draw already manages the cursor while one of its
      // modes is placing geometry; nothing did so for geometry already saved, which is
      // what this wires. Touch has no hover, so nothing about the mobile target changes.
      for (const layer of [
        SAVED_AREAS_FILL_LAYER,
        SAVED_FEATURES_CIRCLE_LAYER,
        SAVED_FEATURES_LINE_LAYER,
      ]) {
        instance.on('mouseenter', layer, () => {
          if (hoverIdleRef.current) instance.getCanvas().style.cursor = 'pointer'
        })
        instance.on('mouseleave', layer, () => {
          // Empty string hands the cursor back to MapLibre's own class-based default
          // rather than pinning it to whatever it happened to be.
          if (hoverIdleRef.current) instance.getCanvas().style.cursor = ''
        })
      }

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

  // Saved point/line features follow exactly the same rules as areas: loaded once the
  // map exists, reloaded on sign-in, cleared on sign-out.
  useEffect(() => {
    if (!mapReady) return
    if (!session) {
      setMapFeatures([])
      return
    }
    let cancelled = false
    fetchFeatures()
      .then((fetched) => {
        if (cancelled) return
        setMapFeatures(fetched)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Could not load saved features')
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
    listQueuedFeatureWrites()
      .then(setQueuedMapFeatures)
      .catch(() => {
        // Same reasoning as above.
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

  // Same for points and lines. Nothing is withheld here the way an area under edit is:
  // a feature edit session never loads anything into Terra Draw, so the saved geometry
  // stays the only copy on screen.
  useEffect(() => {
    if (!mapReady) return
    const source = map.current?.getSource(SAVED_FEATURES_SOURCE) as GeoJSONSource | undefined
    const movingId = editingMapFeature?.drawId
    const combined = combineMapFeatures(mapFeatures, queuedMapFeatures)
    source?.setData({
      type: 'FeatureCollection',
      // The feature under an open move is withheld for the same reason the area under an
      // open edit is: Terra Draw is drawing it, with its handles, and painting it from
      // here too would stack a stale copy under the live one.
      features: movingId ? combined.filter((f) => f.properties.id !== movingId) : combined,
    })
  }, [mapReady, mapFeatures, queuedMapFeatures, editingMapFeature])

  // Paint the current selection. Driven by state rather than written from the pointer
  // handlers so what is on screen is always what React last rendered from.
  useEffect(() => {
    if (!mapReady) return
    const source = map.current?.getSource(BRUSH_SOURCE) as GeoJSONSource | undefined
    const brush = brushModule.current
    source?.setData({
      type: 'Feature',
      geometry:
        brush && brushSelection
          ? brush.selectionToRenderGeometry(brushSelection)
          : { type: 'MultiPolygon', coordinates: [] },
      properties: {},
    })
  }, [mapReady, brushSelection])

  // Add and remove overlay sources and layers to match the toggles, and remember the
  // choice. MapLibre is told each source's attribution, so its own attribution control
  // renders it beside the OpenStreetMap line for exactly as long as the overlay is on —
  // one mechanism for both, rather than a second attribution widget that could disagree
  // with what is actually drawn.
  useEffect(() => {
    if (!mapReady) return
    const instance = map.current
    if (!instance) return

    const on = new Set(enabledOverlays)

    for (const overlay of OVERLAYS) {
      const sourceId = overlaySourceId(overlay)
      const present = !!instance.getSource(sourceId)

      if (on.has(overlay.id) && !present) {
        instance.addSource(sourceId, {
          type: 'geojson',
          data: overlay.source,
          attribution: overlay.attribution,
        })
        for (const plan of overlayAddPlan(overlay)) {
          // beforeId is the first annotation layer, so the overlay lands above the
          // basemap and below every rated area, painted selection, point and line.
          instance.addLayer(
            { ...plan.spec, id: plan.layerId, source: plan.sourceId } as never,
            instance.getLayer(plan.beforeId) ? plan.beforeId : undefined,
          )
        }
      }

      if (!on.has(overlay.id) && present) {
        for (const layerId of overlayLayerIds(overlay)) {
          if (instance.getLayer(layerId)) instance.removeLayer(layerId)
        }
        instance.removeSource(sourceId)
      }
    }

    saveEnabledOverlays(typeof window === 'undefined' ? undefined : window.localStorage, enabledOverlays)
  }, [mapReady, enabledOverlays])

  // Pointer handling for the brush. Registered only while brush mode is active, so
  // nothing here can interfere with Terra Draw's own pointer handling the rest of the
  // time — the two never listen at once.
  useEffect(() => {
    if (!mapReady || !brushing) return
    const instance = map.current
    const brush = brushModule.current
    // Brush mode is only entered after the module resolves, so this is set; the guard is
    // for the teardown case, not a state a user can reach.
    if (!instance || !brush) return
    const canvas = instance.getCanvas()

    // One-finger drag has to paint rather than pan. `dragPan.disable()` alone is not
    // enough: Terra Draw's MapLibre adapter restores map draggability behind our back
    // (measured — dragPan was back to enabled a few taps after entering brush mode, and
    // the map then panned with the finger, so a stroke painted a third of the ground it
    // should have). So the gesture is also stopped at the source: MapLibre binds its
    // drag listeners to the canvas *container*, one level up from the canvas these
    // handlers sit on, and stopping propagation there means the map never sees a brush
    // stroke at all. Pinch zoom still works — it is a two-finger gesture on the
    // container, untouched by this.
    instance.dragPan.disable()

    let painting = false
    let last: { x: number; y: number } | null = null

    const positionIn = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const stampAt = (point: { x: number; y: number }) => {
      const { lat, lng } = instance.unproject([point.x, point.y])
      if (!brushSelectionRef.current) return
      applySelection(
        brush.extendStroke(brushSelectionRef.current, lat, lng, brushSizeRef.current),
      )
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return // right/middle click is not a brush stroke
      event.stopPropagation()
      event.preventDefault()
      painting = true
      setBrushNotice(null)
      canvas.setPointerCapture?.(event.pointerId)
      applySelection(
        brush.beginStroke(brushSelectionRef.current ?? brush.emptySelection(), brushModeRef.current),
      )
      last = positionIn(event)
      stampAt(last)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!painting) return
      event.stopPropagation()
      const point = positionIn(event)
      // Every move event is sampled — no rAF throttling, which would drop cells the
      // finger genuinely crossed — and the gap since the previous one is filled in at a
      // step sized for the current zoom. The step has to come from the zoom: at z11,
      // where the app opens, a cell is about five pixels across, and a fixed 20px step
      // left a continuous drag in disconnected pieces (reproduced in brush.spec.ts
      // before this was zoom-aware).
      const step = brush.pixelStepFor(instance.getZoom(), instance.getCenter().lat)
      for (const at of brush.pixelPath(last ?? point, point, step)) stampAt(at)
      last = point
    }

    const onPointerUp = (event: PointerEvent) => {
      if (!painting) return
      event.stopPropagation()
      painting = false

      // Paint through to where the pointer actually lifted. The browser coalesces
      // pointermove events, and the last one it delivers can be well short of the
      // release point — measured mid-drag in brush.spec.ts, a 180px stroke painted only
      // its first ~130px, so a stroke that visibly joined two blobs came out
      // disconnected. Filling the tail here makes the stroke end where the finger did.
      const releasedAt = positionIn(event)
      const step = brush.pixelStepFor(instance.getZoom(), instance.getCenter().lat)
      for (const at of brush.pixelPath(last ?? releasedAt, releasedAt, step)) stampAt(at)
      last = null

      if (!brushSelectionRef.current) return
      const closed = brush.endStroke(brushSelectionRef.current)
      applySelection(closed)

      // Release is where the selection becomes a polygon and the rating sheet opens, the
      // same sheet a drawn polygon gets. A selection that cannot be one polygon does not
      // open it: the paint stays on screen with a message saying what to fix, so nothing
      // the user painted is thrown away.
      const result = brush.selectionToPolygon(closed)
      if (!result.ok) {
        setPendingFeature(null)
        setModalVisible(false)
        setBrushNotice(
          result.reason === 'disconnected'
            ? 'This paint is in separate pieces — join them up, or undo the stroke that jumped'
            : null,
        )
        return
      }
      setPendingFeature({ drawId: null, geometry: result.polygon })
      setModalVisible(true)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    // A cancelled pointer (system gesture, finger off the edge) closes the stroke
    // exactly as a release does; the cells already painted are kept either way.
    canvas.addEventListener('pointercancel', onPointerUp)

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      instance.dragPan.enable()
    }
  }, [mapReady, brushing, applySelection])

  const runFlush = useCallback(async () => {
    if (!session || flushingRef.current) return
    flushingRef.current = true
    setFlushing(true)
    try {
      await flushQueuedWrites((entry) =>
        saveArea({ id: entry.id, geom: entry.geom, rating: entry.rating, comment: entry.comment }),
      )
      // Features flush in the same cycle, through their own write path. Not interleaved
      // with the areas above: a feature that fails to flush must not leave an area
      // queued behind it, and vice versa — each queue drains independently and whatever
      // fails stays put (docs/OBJECTIVES.md § G4).
      await flushQueuedFeatureWrites((entry) =>
        saveFeature({
          id: entry.id,
          geom: entry.geom,
          kind: entry.kind,
          rating: entry.rating,
          comment: entry.comment,
        }),
      )
    } finally {
      const remaining = await listQueuedWrites()
      setQueuedAreas(remaining)
      setQueuedMapFeatures(await listQueuedFeatureWrites())
      try {
        const fresh = await fetchAreas()
        setAreas(fresh)
      } catch {
        // Stay with what we had; the next successful load reconciles.
      }
      try {
        setMapFeatures(await fetchFeatures())
      } catch {
        // Same.
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

  // Entering point or line mode. Same guard handleStartBrush uses: one session owns the
  // pointer, so an open draw, edit or brush session blocks this rather than silently
  // taking the pointer from it.
  async function handleStartFeature(kind: FeatureKind) {
    if (pendingFeature || editingArea || pendingMapFeature || editingMapFeature) return
    if (brushing) return
    const terraDraw = await drawReady.current
    if (!terraDraw) return
    terraDraw.setMode(kind === 'point' ? POINT_MODE : LINESTRING_MODE)
    setIsDrawing(false)
    setFeatureMode(kind)
  }

  // Abandon an in-progress point or line before it is finished. A point never reaches
  // this state (one tap completes it), so in practice this backs out of a part-drawn line.
  function handleCancelFeatureMode() {
    draw.current?.setMode(STATIC_MODE)
    setFeatureMode(null)
  }

  // Abandon an in-progress polygon. Terra Draw's own cancel key already empties its
  // store, but it emits no event, so without this MapShell never learns and the controls
  // keep offering to finish a ring that no longer exists.
  function handleCancelDrawing() {
    draw.current?.setMode(STATIC_MODE)
    setIsDrawing(false)
  }

  // Mouse-clicking a button leaves it focused, and Enter then re-fires it. Measured: with
  // "Undo point" focused, Enter deleted a second vertex instead of finishing the ring
  // (ring length 5 -> 4), silently destroying work. Dropping focus after a MOUSE click
  // sends the next Enter to the document handler below, which finishes as expected.
  // `detail > 0` distinguishes a real click from a keyboard-activated one, so a keyboard
  // user keeps focus where they put it.
  function blurAfterMouseClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (event.detail > 0) event.currentTarget.blur()
  }

  // Same key the polygon finish control dispatches, for the same reason — Terra Draw has
  // no public finish() and the adapter listens on the canvas.
  function handleFinishLine() {
    const canvas = map.current?.getCanvas()
    canvas?.dispatchEvent(new KeyboardEvent('keyup', { key: FINISH_KEY, bubbles: true }))
  }

  // Drop an unsaved point/line session, taking its geometry out of Terra Draw's store.
  function clearMapFeatureSession() {
    // Either a placement awaiting its rating, or a move session holding a saved feature.
    const drawId = pendingMapFeatureRef.current?.drawId ?? movingFeatureIdRef.current
    if (drawId) draw.current?.removeFeatures([drawId])
    draw.current?.setMode(STATIC_MODE)
  }

  // Open a move on the saved feature currently in the sheet. Mirrors the area-edit
  // session G6 built for polygons: load the geometry into Terra Draw so its handles are
  // draggable, stand the map into select mode, and dismiss the sheet — whose backdrop
  // covers the whole map, so it is what stands between the user and the handles.
  async function handleStartMoveFeature() {
    if (!editingMapFeature || editingMapFeature.drawId !== null) return
    const terraDraw = await drawReady.current
    if (!terraDraw) return
    const { id, kind, geometry } = editingMapFeature
    terraDraw.addFeatures([
      {
        id,
        type: 'Feature',
        geometry,
        properties: { mode: kind === 'point' ? POINT_MODE : LINESTRING_MODE },
      },
    ])
    terraDraw.setMode(SELECT_MODE)
    terraDraw.selectFeature(id)
    setEditingMapFeature((prev) => (prev ? { ...prev, drawId: id } : prev))
    setModalVisible(false)
    setSaveError(null)
  }

  // The brush core and h3-js are fetched here, not at module load: 63,121 B gzip that the
  // map does not need to paint and that nobody can use until they have chosen to paint.
  // Memoised, so a second tap reuses the first fetch rather than starting another.
  function loadBrush() {
    brushLoad.current ??= import('./brush')
      .then((module) => {
        brushModule.current = module
        return module
      })
      .catch(() => {
        // Let the next tap try again rather than wedging brush mode for the session.
        brushLoad.current = null
        return null
      })
    return brushLoad.current
  }

  // Brush mode needs no Terra Draw — it never puts a feature in that store — but it does
  // need its own module, so like handleStartDrawing it waits rather than flipping a mode
  // with nothing behind it. It also stands Terra Draw down, so a half-finished polygon
  // cannot keep taking taps underneath the brush.
  async function handleStartBrush() {
    if (pendingFeature || editingArea || pendingMapFeature || editingMapFeature) return
    if (featureMode !== null) return

    setBrushLoading(true)
    const brush = await loadBrush()
    setBrushLoading(false)
    if (!brush) {
      setLoadError('Could not load the brush tools')
      return
    }

    draw.current?.setMode(STATIC_MODE)
    setIsDrawing(false)
    setBrushNotice(null)
    applySelection(brush.emptySelection())
    setBrushing(true)
  }

  function toggleOverlay(id: OverlayId) {
    setEnabledOverlays((prev) =>
      prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id],
    )
  }

  function resetBrush() {
    // No module means nothing was ever painted — a drawn polygon's save path reaches here
    // too, and must not pull in the brush chunk just to clear nothing.
    applySelection(brushModule.current?.emptySelection() ?? null)
    setBrushNotice(null)
  }

  // Leaving brush mode throws the unsaved selection away, which is why the button says
  // so. Anything worth keeping has already been through the rating sheet.
  function handleExitBrush() {
    setBrushing(false)
    resetBrush()
    if (!editingArea) {
      setPendingFeature(null)
      setModalVisible(false)
    }
  }

  // Undo one stroke, not the session (G8). The polygon and the sheet follow the
  // selection: undoing back to nothing closes the sheet rather than leaving it offering
  // to save a shape that is no longer painted.
  function handleUndoStroke() {
    const brush = brushModule.current
    if (!brush || !brushSelectionRef.current) return
    const next = brush.undoStroke(brushSelectionRef.current)
    applySelection(next)
    setBrushNotice(null)

    const result = brush.selectionToPolygon(next)
    if (result.ok) {
      setPendingFeature({ drawId: null, geometry: result.polygon })
      return
    }
    setPendingFeature(null)
    setModalVisible(false)
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
  // `drawId` is null for a brushed polygon: there is nothing in Terra Draw's store to
  // take out, but the mode still stands down.
  function clearDrawSession(drawId: string | null | undefined) {
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
    if (editingMapFeature) {
      // A rating-only session loaded nothing into Terra Draw; a move session (G13) did,
      // and its copy has to come back out. Either way `mapFeatures` was never mutated, so
      // dropping the session re-renders the feature at its saved position.
      if (editingMapFeature.drawId) clearMapFeatureSession()
      setEditingMapFeature(null)
      setModalVisible(false)
      setSaveError(null)
      return
    }
    if (!editingArea) return
    clearDrawSession(editingArea.drawId)
    setEditingArea(null)
    setModalVisible(false)
    setSaveError(null)
  }

  function handleReopenPending() {
    setModalVisible(true)
  }

  // Points and lines save through save-feature, not save-area. Kept as its own function
  // rather than more branches inside handleSave: the two write paths share only the
  // rating sheet, and interleaving them would put four session types through one set of
  // nested ternaries.
  async function handleSaveMapFeature(rating: number, comment: string) {
    if (!session) {
      setSaveError('Sign in (top right) to save this feature')
      return
    }
    const target = pendingMapFeature
      ? {
          isNew: true,
          id: crypto.randomUUID(),
          kind: pendingMapFeature.kind,
          geometry: pendingMapFeature.geometry,
        }
      : editingMapFeature
        ? {
            isNew: false,
            id: editingMapFeature.id,
            kind: editingMapFeature.kind,
            geometry: editingMapFeature.geometry,
          }
        : null
    if (!target) return

    setSaving(true)
    setSaveError(null)
    const input = {
      id: target.id,
      geom: target.geometry,
      kind: target.kind,
      rating,
      comment: comment || null,
    }

    const settle = () => {
      clearMapFeatureSession()
      setPendingMapFeature(null)
      setEditingMapFeature(null)
      setModalVisible(false)
    }

    try {
      const { feature } = await saveFeature(input)
      setMapFeatures((prev) => {
        const next: MapFeature = {
          type: 'Feature',
          geometry: target.geometry,
          properties: {
            id: feature.id,
            kind: target.kind,
            rating: feature.rating,
            comment: feature.comment,
            created_at: feature.created_at,
          },
        }
        return target.isNew
          ? [...prev, next]
          : prev.map((f) => (f.properties.id === target.id ? next : f))
      })
      settle()
    } catch (err) {
      // Same rule areas follow: only a genuine "could not reach the server" is queueable.
      // Anything else would fail identically on flush, so it has to surface now.
      if (err instanceof OfflineWriteError) {
        const entry: QueuedFeatureWrite = { ...input, queuedAt: Date.now() }
        await enqueueFeatureWrite(entry)
        setQueuedMapFeatures((prev) => [...prev.filter((q) => q.id !== entry.id), entry])
        settle()
      } else {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteMapFeature() {
    if (!editingMapFeature) return
    setSaving(true)
    setSaveError(null)
    try {
      await deleteFeature(editingMapFeature.id)
      // Reachable with a move open — the sheet can be reopened from the pill mid-move —
      // so the draw store's copy has to go as well, or it outlives the row.
      if (editingMapFeature.drawId) clearMapFeatureSession()
      setMapFeatures((prev) => prev.filter((f) => f.properties.id !== editingMapFeature.id))
      setEditingMapFeature(null)
      setModalVisible(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave(rating: number, comment: string) {
    if (pendingMapFeature || editingMapFeature) {
      await handleSaveMapFeature(rating, comment)
      return
    }
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
        // The saved area now renders from `areas`; the selection it came from has served
        // its purpose. Brush mode stays on with an empty selection, ready for the next
        // area — one area per painting session (G8), not one area per visit to the mode.
        resetBrush()
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
          resetBrush()
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

  // The banner covers both queues. Every entry in either is a write the server has not
  // confirmed — entries are removed only after a successful flush — so this count can
  // never overstate what is saved (CLAUDE.md: never render a save as complete before the
  // server has it). Naming the kinds separately rather than totalling them keeps
  // "1 area queued" reading exactly as it did when areas were the only thing queueable.
  const queuedTotal = queuedAreas.length + queuedMapFeatures.length
  const queuedLabel = [
    queuedAreas.length > 0 ? plural(queuedAreas.length, 'area') : null,
    queuedMapFeatures.length > 0 ? plural(queuedMapFeatures.length, 'feature') : null,
  ]
    .filter(Boolean)
    .join(' and ')

  // Desktop keyboard. Terra Draw's adapter listens for keyup on the map canvas, so its
  // finish/cancel keys only work while the canvas holds focus — which it does after a map
  // click and does not after a toolbar click. Both keys are handled here at the document
  // level instead, so they behave the same wherever focus happens to be.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never steal a key from a field: Enter in the comment box is a newline, and the
      // rating sheet handles its own Escape.
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (modalVisible) return

      if (event.key === CANCEL_KEY) {
        // Terra Draw clears its own store on this key; what it cannot do is tell us, so
        // the session state is reset here. Without it the draw controls stay on screen
        // offering to finish a ring that no longer exists.
        if (isDrawing) handleCancelDrawing()
        else if (featureMode !== null) handleCancelFeatureMode()
        return
      }

      if (event.key === FINISH_KEY) {
        // If the canvas has focus the adapter will handle this itself; doing it here too
        // would finish twice.
        if (target === map.current?.getCanvas()) return
        if (isDrawing) handleFinishArea()
        else if (featureMode === 'line') handleFinishLine()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const hasSession =
    pendingFeature !== null ||
    editingArea !== null ||
    pendingMapFeature !== null ||
    editingMapFeature !== null
  const isCreating = pendingFeature !== null || pendingMapFeature !== null
  const showRatingModal = modalVisible && hasSession
  // A dismissed sheet is how the user reaches the vertex handles, so the pill stands in
  // for it during an edit session too, not just for a pending draw.
  const showReopenPill = hasSession && !modalVisible

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      <div className="absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
        {loadError && (
          <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700 shadow">{loadError}</div>
        )}

        {queuedTotal > 0 && (
          <div
            data-testid="queued-banner"
            // Capped and centred like the overlay sheet. Unconstrained it spanned the
            // full window on desktop, putting the "Sync now" button a screen's width away
            // from the text explaining it.
            className="mx-auto flex w-full max-w-sm items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow"
          >
            <span>{queuedLabel} queued — offline, will sync</span>
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

        {(editingArea || editingMapFeature) && !modalVisible && (
          <button
            type="button"
            data-testid="cancel-edit"
            onClick={handleCancelEdit}
            className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-700 shadow"
          >
            Cancel edit
          </button>
        )}

        {overlaySheetOpen && (
          <div
            data-testid="overlay-sheet"
            className="w-full max-w-sm rounded-2xl bg-white p-3 shadow-lg"
          >
            <p className="mb-2 text-xs font-medium text-gray-500">Reference layers</p>
            <div className="flex flex-col gap-1">
              {OVERLAYS.map((overlay) => {
                const on = enabledOverlays.includes(overlay.id)
                return (
                  <button
                    key={overlay.id}
                    type="button"
                    data-testid={`overlay-toggle-${overlay.id}`}
                    aria-pressed={on}
                    onClick={() => toggleOverlay(overlay.id)}
                    className={`flex min-h-11 items-center justify-between gap-3 rounded-xl px-3 text-sm font-medium ${
                      on ? 'bg-blue-50 text-blue-800' : 'text-gray-900'
                    }`}
                  >
                    <span>{overlay.label}</span>
                    <span className="text-xs text-gray-500">{on ? 'On' : 'Off'}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Sits with the brush controls rather than in the top band: it is about the
            stroke that just happened, and the rating sheet covers the top of the screen.
            The cap message wins over the disconnected one — at the cap, painting the gap
            closed is not available, so that is the more useful thing to say. */}
        {brushing && (brushSelection?.refusedAtCap || brushNotice) && (
          <div
            data-testid="brush-message"
            className="rounded-lg bg-amber-50 px-3 py-2 text-center text-xs text-amber-800 shadow"
          >
            {brushSelection?.refusedAtCap
              ? `That is ${(
                  brushModule.current?.MAX_SELECTION_CELLS ?? 0
                ).toLocaleString()} cells — the most one area can hold. Erase some, or save this and start another.`
              : brushNotice}
          </div>
        )}

        {brushing && (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              {([1, 2, 3] as BrushSize[]).map((size) => (
                <button
                  key={size}
                  type="button"
                  data-testid={`brush-size-${size}`}
                  aria-pressed={brushSize === size}
                  onClick={() => setBrushSize(size)}
                  className={`flex min-h-11 min-w-11 items-center justify-center rounded-full px-4 text-sm font-medium shadow ${
                    brushSize === size ? 'bg-blue-600 text-white' : 'bg-white text-gray-900'
                  }`}
                >
                  {size}
                </button>
              ))}
              <button
                type="button"
                data-testid="brush-erase-toggle"
                aria-pressed={brushMode === 'erase'}
                onClick={() => setBrushMode((prev) => (prev === 'erase' ? 'paint' : 'erase'))}
                className={`flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-medium shadow ${
                  brushMode === 'erase' ? 'bg-blue-600 text-white' : 'bg-white text-gray-900'
                }`}
              >
                Erase
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="undo-stroke"
                onClick={handleUndoStroke}
                className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-900 shadow"
              >
                Undo stroke
              </button>
              <button
                type="button"
                data-testid="exit-brush"
                onClick={handleExitBrush}
                className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-700 shadow"
              >
                Discard paint
              </button>
            </div>
          </div>
        )}

        {/* Placing a point: one tap finishes it, so there is nothing to undo or close —
            only a way back out. */}
        {featureMode === 'point' && (
          <div className="flex items-center gap-2">
            <span
              data-testid="point-hint"
              className="rounded-full bg-white/90 px-3 py-2 text-sm text-gray-700 shadow"
            >
              Tap the map to place a point
            </span>
            <button
              type="button"
              data-testid="cancel-feature"
              onClick={handleCancelFeatureMode}
              className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-700 shadow"
            >
              Cancel
            </button>
          </div>
        )}

        {featureMode === 'line' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="undo-vertex"
              onClick={(e) => {
                blurAfterMouseClick(e)
                handleUndoVertex()
              }}
              className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-900 shadow"
            >
              Undo point
            </button>
            <button
              type="button"
              data-testid="finish-line"
              onClick={(e) => {
                blurAfterMouseClick(e)
                handleFinishLine()
              }}
              className="flex min-h-11 items-center justify-center rounded-full bg-gray-900 px-4 text-sm font-medium text-white shadow"
            >
              Finish line
            </button>
            <button
              type="button"
              data-testid="cancel-feature"
              onClick={handleCancelFeatureMode}
              className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-700 shadow"
            >
              Cancel
            </button>
          </div>
        )}

        {isDrawing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="undo-vertex"
              onClick={(e) => {
                blurAfterMouseClick(e)
                handleUndoVertex()
              }}
              className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-900 shadow"
            >
              Undo point
            </button>
            <button
              type="button"
              data-testid="finish-area"
              onClick={(e) => {
                blurAfterMouseClick(e)
                handleFinishArea()
              }}
              className="flex min-h-11 items-center justify-center rounded-full bg-gray-900 px-4 text-sm font-medium text-white shadow"
            >
              Finish area
            </button>
            {/* Lines already had a way out; polygons had none, so Escape (which empties
                Terra Draw's store) left the only exits as drawing a fresh ring or
                reloading. */}
            <button
              type="button"
              data-testid="cancel-drawing"
              onClick={(e) => {
                blurAfterMouseClick(e)
                handleCancelDrawing()
              }}
              className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-700 shadow"
            >
              Cancel
            </button>
          </div>
        ) : (
          !hasSession &&
          !brushing &&
          featureMode === null && (
            // Four entry points at 390px: two rows rather than one scrolling line.
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                data-testid="start-drawing"
                onClick={() => void handleStartDrawing()}
                className="rounded-full bg-gray-900 px-5 py-3 text-base font-medium text-white shadow"
              >
                Draw area
              </button>
              <button
                type="button"
                data-testid="start-brush"
                disabled={brushLoading}
                onClick={() => void handleStartBrush()}
                className="rounded-full bg-blue-600 px-5 py-3 text-base font-medium text-white shadow disabled:opacity-60"
              >
                {brushLoading ? 'Loading…' : 'Paint area'}
              </button>
              <button
                type="button"
                data-testid="overlay-sheet-toggle"
                aria-pressed={overlaySheetOpen}
                onClick={() => setOverlaySheetOpen((open) => !open)}
                className="flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-gray-900 shadow"
              >
                Layers
                {enabledOverlays.length > 0 && (
                  <span className="ml-1 text-xs text-blue-700">{enabledOverlays.length}</span>
                )}
              </button>
              <button
                type="button"
                data-testid="start-point"
                onClick={() => void handleStartFeature('point')}
                className="flex min-h-11 items-center justify-center rounded-full bg-white px-5 text-base font-medium text-gray-900 shadow"
              >
                Add point
              </button>
              <button
                type="button"
                data-testid="start-line"
                onClick={() => void handleStartFeature('line')}
                className="flex min-h-11 items-center justify-center rounded-full bg-white px-5 text-base font-medium text-gray-900 shadow"
              >
                Draw line
              </button>
            </div>
          )
        )}
      </div>

      {showRatingModal && (
        // Reused unchanged across all four session types (G9 task 2): an area, a brushed
        // area, a point and a line are all rated with the same three buttons and the same
        // comment box.
        <RatingModal
          mode={isCreating ? 'create' : 'edit'}
          initialRating={editingArea?.rating ?? editingMapFeature?.rating ?? 0}
          initialComment={editingArea?.comment ?? editingMapFeature?.comment ?? ''}
          saving={saving}
          error={saveError}
          onDismiss={handleDismissModal}
          onSave={(rating, comment) => void handleSave(rating, comment)}
          onDelete={
            editingArea
              ? () => void handleDelete()
              : editingMapFeature
                ? () => void handleDeleteMapFeature()
                : undefined
          }
          // Only for a saved feature, and only when a move is not already open: reopening
          // the sheet mid-move must not offer to start a second one. Areas reach their
          // handles by tapping the shape itself (G6), so nothing here applies to them.
          extraAction={
            editingMapFeature && editingMapFeature.drawId === null ? (
              <button
                type="button"
                data-testid="move-feature"
                onClick={() => void handleStartMoveFeature()}
                className="mb-2 flex min-h-11 w-full items-center justify-center rounded-lg border border-gray-300 text-sm font-medium text-gray-700"
              >
                {editingMapFeature.kind === 'point' ? 'Move point' : 'Reshape line'}
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  )
}
