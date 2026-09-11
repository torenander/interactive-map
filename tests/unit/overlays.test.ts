// Overlay registry, persistence and layer ordering — docs/OBJECTIVES.md § G10. The four
// assertions the goal's `overlays.test.ts` contract names are here (default off, toggle
// state survives a reload, every entry has an attribution, overlays order below the
// annotation layers), plus the registry invariants the assert-overlays script and the
// service worker both depend on. Rendering and attribution-in-the-DOM are
// tests/e2e/overlays.spec.ts.
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_LAYER_IDS,
  OVERLAY_INSERT_BEFORE,
  SAVED_AREAS_FILL_LAYER,
  SAVED_AREAS_LINE_LAYER,
  SAVED_FEATURES_CIRCLE_LAYER,
  SAVED_FEATURES_LINE_LAYER,
} from "../../src/map/layers";
import {
  OVERLAYS,
  loadEnabledOverlays,
  overlayAddPlan,
  overlayById,
  overlayLayerIds,
  overlaySourceId,
  saveEnabledOverlays,
  type OverlayId,
} from "../../src/map/overlays";

/** A localStorage stand-in: the module only ever needs getItem/setItem. */
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    get size() {
      return store.size;
    },
  };
}

describe("registry", () => {
  it("has the three overlays the goal names", () => {
    expect(OVERLAYS.map((o) => o.id)).toEqual(["tfl-stops", "greenspace", "road-noise"]);
  });

  it("gives every entry a non-empty attribution", () => {
    for (const overlay of OVERLAYS) {
      expect(overlay.attribution.trim().length).toBeGreaterThan(0);
    }
  });

  it("names every source as a path on this origin, never a third-party URL", () => {
    // The same rule scripts/assert-overlays.mjs enforces and the done_when's grep probe
    // backs up: no request for overlay data may leave this app's origin.
    for (const overlay of OVERLAYS) {
      expect(overlay.source.startsWith("/overlays/")).toBe(true);
      expect(overlay.source).not.toMatch(/^https?:/);
    }
  });

  it("keeps ids, source ids and layer ids unique", () => {
    const ids = OVERLAYS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sourceIds = OVERLAYS.map(overlaySourceId);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);

    const layerIds = OVERLAYS.flatMap(overlayLayerIds);
    expect(new Set(layerIds).size).toBe(layerIds.length);
    // A layer id colliding with an annotation layer would have MapShell remove the
    // user's own layer when an overlay is switched off.
    for (const layerId of layerIds) {
      expect(ANNOTATION_LAYER_IDS).not.toContain(layerId);
    }
  });

  it("labels the filtered overlay with its threshold", () => {
    // Only the two loudest Lden bands are extracted, so a bare "Road noise" label would
    // imply an unshaded street had been measured as quiet.
    expect(overlayById("road-noise")?.label).toMatch(/70 dB/);
  });

  it("looks entries up by id and reports nothing for an unknown one", () => {
    expect(overlayById("greenspace")?.source).toBe("/overlays/greenspace.geojson");
    expect(overlayById("nope" as OverlayId)).toBeUndefined();
  });
});

describe("layer ordering", () => {
  it("inserts every overlay layer before the first annotation layer", () => {
    for (const overlay of OVERLAYS) {
      const plan = overlayAddPlan(overlay);
      expect(plan.length).toBeGreaterThan(0);
      for (const entry of plan) {
        expect(entry.beforeId).toBe(OVERLAY_INSERT_BEFORE);
      }
    }
  });

  it("puts that anchor ahead of the area, point and line layers", () => {
    // MapLibre draws in list order, so inserting before the first annotation layer is
    // what keeps reference data under every annotation at once.
    expect(ANNOTATION_LAYER_IDS[0]).toBe(OVERLAY_INSERT_BEFORE);
    for (const layer of [
      SAVED_AREAS_FILL_LAYER,
      SAVED_AREAS_LINE_LAYER,
      SAVED_FEATURES_LINE_LAYER,
      SAVED_FEATURES_CIRCLE_LAYER,
    ]) {
      expect(ANNOTATION_LAYER_IDS).toContain(layer);
      expect(ANNOTATION_LAYER_IDS.indexOf(OVERLAY_INSERT_BEFORE)).toBeLessThanOrEqual(
        ANNOTATION_LAYER_IDS.indexOf(layer),
      );
    }
  });

  it("plans each overlay's layers against its own source", () => {
    for (const overlay of OVERLAYS) {
      for (const entry of overlayAddPlan(overlay)) {
        expect(entry.sourceId).toBe(overlaySourceId(overlay));
        expect(entry.layerId.startsWith(overlay.id)).toBe(true);
      }
    }
  });
});

describe("persistence", () => {
  it("starts with every overlay off", () => {
    expect(loadEnabledOverlays(fakeStorage())).toEqual([]);
  });

  it("survives a reload", () => {
    const storage = fakeStorage();
    saveEnabledOverlays(storage, ["greenspace", "tfl-stops"]);
    // A fresh read of the same storage is what a reload does.
    expect(loadEnabledOverlays(storage).sort()).toEqual(["greenspace", "tfl-stops"]);
  });

  it("round-trips an empty selection, so switching everything off sticks", () => {
    const storage = fakeStorage();
    saveEnabledOverlays(storage, ["road-noise"]);
    saveEnabledOverlays(storage, []);
    expect(loadEnabledOverlays(storage)).toEqual([]);
  });

  it("drops ids that are no longer in the registry", () => {
    const storage = fakeStorage({
      "areamap:overlays": JSON.stringify(["greenspace", "flood-risk"]),
    });
    expect(loadEnabledOverlays(storage)).toEqual(["greenspace"]);
  });

  it("treats unusable storage as nothing enabled rather than failing first paint", () => {
    expect(loadEnabledOverlays(fakeStorage({ "areamap:overlays": "{not json" }))).toEqual([]);
    expect(loadEnabledOverlays(fakeStorage({ "areamap:overlays": '"greenspace"' }))).toEqual([]);
    expect(loadEnabledOverlays(undefined)).toEqual([]);
    expect(() => saveEnabledOverlays(undefined, ["greenspace"])).not.toThrow();
  });
});
