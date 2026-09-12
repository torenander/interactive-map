# G12 — Same-origin MapLibre worker — task breakdown

**Goal:** MapLibre's worker starts from a real same-origin URL rather than a blob built
from a fetched copy of its source, so the offline gate can assert zero page errors instead
of tolerating two known WebKit messages. Exit criteria: `docs/OBJECTIVES.md` § G12.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G7, G10.

**This goal may turn out to be unachievable, and that is a legitimate outcome.** It rests
on WebKit now intercepting a same-origin worker *script* request with a service worker —
the limitation G5's blob was working around. The first task measures that and the last one
says to stop and report if the answer is still no; the tolerated allowance in
`overlays.spec.ts` is then the honest state of the world rather than a shortcut.

---

## Tasks

- [ ] Read the history first: `src/map/MapShell.tsx`'s worker comment and
      `resolveWorkerUrl`, the `?worker&url` import, `preloadMapLibreWorker` in
      `vite.config.ts`, and why G5 chose a blob — WebKit does not let a service worker
      intercept a dedicated worker's *script* request, the constraint this goal must solve
      differently
- [ ] **Measure first:** whether a same-origin worker script request is intercepted by the
      service worker in WebKit today, in a controlled page, offline. The whole goal rests on
      this; if it is still not intercepted, say so and stop rather than shipping a change
      that moves the failure
- [ ] Serve the emitted `maplibre-gl-worker` chunk at a stable same-origin URL and hand
      MapLibre that URL via `setWorkerUrl`, dropping `URL.createObjectURL`
- [ ] Keep the guarantee the top-level await currently provides: the map is never created
      against an unresolved worker URL
- [ ] Keep the worker's bytes precached — it is in `self.__WB_MANIFEST` today by virtue of
      being a build asset; confirm that still holds for the new URL rather than assuming it
- [ ] Keep `perf-load.spec.ts` green **unchanged**: document-initiated, fetched once. If
      the head-start fetch in `vite.config.ts` is no longer the mechanism, whatever replaces
      it has to satisfy both assertions — and `modulepreload` is already measured as
      double-downloading in WebKit
- [ ] Strengthen `overlays.spec.ts`'s offline test to `expect(pageErrors).toEqual([])` and
      delete the tolerated-message filter and its comment
- [ ] Run the `done_when` block on both projects; record outputs
- [ ] If the measurement in task 2 says WebKit still will not intercept a worker script
      request, stop and report: the goal is then unachievable as written and the tolerated
      allowance in `overlays.spec.ts` is the honest state of the world, not a shortcut
