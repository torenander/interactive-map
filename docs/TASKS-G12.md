# G12 — Same-origin MapLibre worker — task breakdown

**Goal:** MapLibre's worker starts from a real same-origin URL rather than a blob built
from a fetched copy of its source, so the offline gate can assert zero page errors instead
of tolerating two known WebKit messages. Exit criteria: `docs/OBJECTIVES.md` § G12.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G7, G10.

**CLOSED 2026-09-12 — unachievable, stop condition invoked.** The spike measured what the
goal rested on and the answer was no: WebKit's service worker never receives a same-origin
worker script request on a network-blocked reload. The grid, the dated note and the
reasoning are in `docs/OBJECTIVES.md` § G12 and `docs/TESTING.md`. The blob-URL workaround
stays; so does the tolerated allowance in `overlays.spec.ts`.

Boxes below are marked accordingly: the spike tasks are `[~]` on perf-probe's watched runs,
and the implementation tasks are **not run, by design** — they are unticked because the
goal was stopped before them, not because they are outstanding. That is the one place this
repo's "an unticked box means not yet recorded" convention needs saying out loud.

**Original framing, kept because the outcome vindicated it.** It rests
on WebKit now intercepting a same-origin worker *script* request with a service worker —
the limitation G5's blob was working around. The first task measures that and the last one
says to stop and report if the answer is still no; the tolerated allowance in
`overlays.spec.ts` is then the honest state of the world rather than a shortcut.

---

## Tasks

- [~] Read the history first: `src/map/MapShell.tsx`'s worker comment and
      `resolveWorkerUrl`, the `?worker&url` import, `preloadMapLibreWorker` in
      `vite.config.ts`, and why G5 chose a blob — WebKit does not let a service worker
      intercept a dedicated worker's *script* request, the constraint this goal must solve
      differently
- [~] **Measure first:** whether a same-origin worker script request is intercepted by the
      service worker in WebKit today, in a controlled page, offline. The whole goal rests on
      this; if it is still not intercepted, say so and stop rather than shipping a change
      that moves the failure
### Not run, by design — the stop condition fired before these

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
- [~] If the measurement in task 2 says WebKit still will not intercept a worker script
      request, stop and report: the goal is then unachievable as written and the tolerated
      allowance in `overlays.spec.ts` is the honest state of the world, not a shortcut
