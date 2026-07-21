# TwinView — session handoff prompt

Paste everything below into Claude Code on the new machine (working directory = the cloned repo).

---

I'm continuing work on **TwinView**, a digital-twin proof of concept for QA testing of iFit fitness equipment (treadmills first, later ellipticals/rowers). The goal: view the unit's CAD model in 3D, click a component to attach a sensor (mocked now, USB/microcontroller later), and watch **expected vs. actual** behavior live — belt speed, incline, motor current, vibration — plus the tablet console screen (mocked now, ADB/LiveView later).

Repo: https://github.com/andrus-shane/TwinView (private) — this directory is a clone of it. Read README.md and this file, then `npm install` and start `npm run dev:server` (:8720) + `npm run dev:web` (:5173).

## State as of 2026-07-10 (previous machine)

**Fully working with mock data:**
- npm-workspaces monorepo: `shared/` (wire types), `server/` (Fastify + WS twin engine), `web/` (Vite + React + three.js).
- Twin engine (`server/src/twin.ts`): runs a fault-free reference plant (first-order belt lag τ=1.4s, incline slew 0.6%/s, current & vibration load models in `server/src/plant.ts`) from commanded setpoints; compares measured telemetry at 10Hz; debounced ok/warn/fail per channel; QA event log; CSV export at `/api/export.csv`.
- Mock machine (`server/src/sources/mock.ts`): same plant + noise + injectable faults (belt_slip, incline_stuck, current_spike, vibration_burst).
- Scenarios (`server/src/scenarios.ts`): quick_check, speed_ramp, incline_sweep.
- Frontend: procedural placeholder treadmill (`web/src/scene/fallback.ts`) with pre-bound rig; click part → bind channels/roles (persists to `models/rig.json` via PUT /api/rig); deck tilts to measured incline (ghost wireframe = commanded, 2× visual exaggeration); belt texture scrolls at measured speed; parts tint amber/red on deviation; mock console canvas is textured onto the 3D console screen; uPlot cmd-vs-meas sparklines per channel.
- Everything verified end-to-end: scenario run, fault injection → FAIL event → clear → recovery, slider setpoints, bind/save/remove, rig persistence.

## Update 2026-07-13 (old machine, final session) — CAD conversion runbook

Shane installed SolidWorks 2024 on the fast machine, so CAD conversion moves there.
The conversion was stopped on the old machine at ~95% (all structure unsuppressed +
fully resolved, mid-tessellation). Everything learned is baked into
`tools/sw_tessellate_glb.py`, which is now a **one-command, crash-resilient,
resumable pipeline**. Do NOT use the old machine's models/current.glb — it's a
known-bad electronics-only export (the app still runs fine on the placeholder).

**Why previous exports produced a "speck field":** the pack-and-go assembly's only
config has ALL structural parts (deck, 2 m frame rails, covers, motor) **suppressed**,
and ~1,360 more components open **lightweight**. Suppressed parts are invisible to
every exporter; lightweight ones have no bodies for tessellation. Both must be fixed
in-session, and on the old machine SolidWorks crashed every ~2-5 unsuppress rebuilds.

**Runbook on this machine (SW 2024 required):**
1. `python tools/extract_cad.py` if `cad/NTL99925-1M00/` isn't extracted yet.
2. `python tools/sw_tessellate_glb.py` — fully autonomous: opens the assembly
   (silent), unsuppresses structural components biggest-first (skips <0.25 m
   hardware; Save3 checkpoints every 3 flips so crashes can't undo progress;
   auto-kills zombie SW and reconnects; poison parts get 2 strikes then a
   permanent blacklist in `models/_unsuppress_state.json` — committed, already
   lists `013576-2` and `1001257-1/1001256-1`), then resolves ALL lightweight
   components silently (`ResolveAllLightWeightComponents(False)` — the `True`
   variant pops a dialog that aborts under automation), verifies the census
   is 0, tessellates every resolved part (`body.GetFaces()` +
   `GetTessTriangles`), and writes `models/NTL99925-raw.glb`.
   Expect: "Pulled ~1,200+ parts", bbox extent ≈ 0.97 × 1.46 × 2.04 m.
   (On the old machine: 275 parts = failure mode; 12 min assembly open, ~7 min
   tessellation. This box should be much faster and may not crash at all.)
3. `node tools/optimize_glb.mjs` → `models/current.glb` + `models/parts-manifest.json`.
   Sanity-check before committing: parts manifest should list structural names
   (1001404, 1001350, 1006376…), not just PCB/STEP electronics; check per-NODE
   extents, not just scene bbox (a 2 m bbox can come from scattered screws).
4. Restart the dev server, open :5173 — the app auto-loads current.glb. Bind
   belt/deck/motor/console_screen roles by clicking parts (see README).
5. Commit `models/current.glb` + `models/parts-manifest.json` + rig.json and push.
6. Optional, for a prettier model: after step 2's unsuppress+resolve has run once,
   `python tools/sw_xr_addin_export.py` uses the XR add-in (GLTF_FileSave_Assembly)
   which exports WITH materials/colors — the tessellation GLB is uniform gray.
   The add-in only exports what's displayed, which is why it needed the
   unsuppress pass first. Watch out: it can take 30+ min and gives no progress.

**Gotchas encoded in the script (don't re-learn):** never hold component/doc COM
refs across `SetSuppression2` (rebuilds disconnect every dispatch — collect Name2
strings, refetch via `GetComponentByName`); `IsSuppressed` is True for lightweight
too (gate on `GetSuppression2 == 0`); the dialog watchdog auto-IDOKs every SW modal
(needed for Toolbox/What's-Wrong/Open prompts) at 0.4 s poll; Save3 checkpoint makes
the assembly file grow ~8x (276 MB — too big for GitHub, that's why the resolved
assembly itself isn't committed).

## Update 2026-07-15 — multi-unit CAD conversion (rower, elliptical, pilates)

Three more units converted with the same pipeline, one SolidWorks session at a time
(SW COM automation is single-instance; never run two conversions concurrently):
- `models/FMRW0826-1D30.glb` (rower, 8 MB, 298-part manifest, bbox 0.56×1.36×2.42 m)
- `models/NTEL71426.glb` (elliptical, 9.3 MB, 470 parts, 0.63×1.80×2.55 m)
- `models/NTPL99926-6FW0.glb` (pilates, 40 MB, 618 parts, 0.93×0.86×3.04 m)
Each has a `models/<MODEL>.manifest.json`; `*-raw.glb` intermediates are gitignored
but left in `models/`. Source pack-and-gos live in `C:\Users\shane.andrus\Documents\CAD Units\`.

Pipeline changes: `sw_tessellate_glb.py` derives the model name from the input stem
(strips a leading `~`) and keeps a per-assembly sidecar `models/_unsuppress_state_<MODEL>.json`
(poison-part blacklists must not leak between models — part numbers repeat across product
lines). `optimize_glb.mjs` derives the manifest path + `model` field from the output
filename (`current.glb` keeps legacy `parts-manifest.json`/NTL99925 behavior).

Server/web are multi-model: `GET /api/models` discovers `models/*.glb` (excluding `-raw`)
∪ `*.manifest.json`; `/api/model-info` and `/api/rig` take `?model=`; per-model rigs in
`models/rig.<MODEL>.json`; header model picker persists to localStorage `twinview.model`.

New gotchas for the pile:
- Pack-and-go re-stamps every `.SLDASM`/`.SLDDRW` on export (parts copy verbatim) — two
  exports of the same unit minutes apart differ at the byte level for assemblies, so
  hash-dedupe across exports only works for parts.
- The elliptical and pilates roots are literally named `~NTEL71426.SLDASM` /
  `~NTPL99926-6FW0.SLDASM` — the tilde is part of the filename, not a temp-file marker
  (SW 2021+ files are not OLE compound docs; don't infer format from headers).
- Tessellation quiet stretches of 15-25 min with near-idle CPU on BOTH python and SW are
  normal on single heavy parts. The only real failure signal is the python process exiting.
  One transient pythoncom hard crash (access violation, no traceback) hit the pilates
  mid-walk and did not reproduce on retry; after such a crash the script re-attaches to
  the still-open assembly by title match, skipping the reopen.
- The 40 MB pilates GLB takes ~30 s through the Vite dev proxy on first load — GLTFLoader
  has no timeout, but reloading the page mid-fetch logs "CAD load failed … Failed to fetch".

## Update 2026-07-16 — explicit motion groups (rower/elliptical/pilates animations)

The CAD animations no longer rely only on geometric capture heuristics. `RigBinding`
grew an `attach: string[]` field (shared/src/index.ts): the exact scene-node names that
ride a bound part's animation as one rigid group. `RigAnimator` uses authored lists for
seat sleds, handles, pedals, arms, and carriages (capture-box heuristics remain the
fallback for un-annotated rigs). Two new roles: `crank` (spins about the bound part's
thinnest axis, absolute angle phase-locked to the pedal stride) and `spring` (reformer
coils scale along z from a pivot at their housing-anchored end, tracking the carriage).
The lists were derived from per-part world AABBs dumped out of the GLBs (accessor
min/max — positions are world-space in these exports) and are checked into the three
`models/rig.<MODEL>.json` files (~430 grouped parts total).

Findings encoded there (don't re-derive):
- The rower rig used to bind the WRONG seat pad: `434166-1` is the handle-rest cradle —
  a full second carriage assembly parked mid-rail at z≈-0.85. The sliding seat is
  `434166-1_1` (wheels/bearings cluster at z≈-1.34). Rebound.
- The elliptical's big visible discs (`393296-*` stack, weight plates, rivets) are
  bolted to the crank (pin grommets at the crank-pin radius), so they're role `crank`
  now — at the geared `flywheel` rate they'd shear against the crank arms. The true
  inertia flywheel is an internal cluster around `364315-1`, left static (invisible).
- Elliptical arms are bell-cranks: the physical hinge is at the pole BOTTOM (shaft
  `391145-1`, y≈1.0), not the pole top. `RigAnimator.armHinge` finds it from the
  attach-list clamshells/bearings that wrap the pole's bottom end.
- Pedal ellipse phases are solved from each pedal's CAD rest offset (the snapshot
  freezes the mechanism mid-stride) — kills the snap-to-ellipse jump at focus and
  keeps the crank pins on the pedals' clock.
- BindDialog preserves `attach` through UI edits (it used to rebuild bindings from
  scratch, which would have silently dropped the lists).

Known-static approximations (visible if you look for them): the rower pull strap
`434212-1` (modeled fully extended along the rail) and upper spool-pulley cluster; the
reformer ropes `RX1574-*` (full-rail meshes; the hand-loops ride the carriage as an
approximation); elliptical left ramp rail `1002284-1` isn't in the incline binding.
All would need path/stretch animations, not rigid groups.

## Update 2026-07-21 — diagnosis fixes applied (see 2026-07-17 below for evidence)

All three machines fixed and visually verified mid-scenario:
- Rower: seat rebound to the front carriage (`434166-1` + cushion `361660-1` + 55-part
  attach); the mis-bound "handle" binding (it was the cushion) removed; the rear
  duplicate carriage hidden via a `hidden` display group ("Duplicate seat carriage
  (CAD artifact)"). `setupCadStroke` now derives the stroke anchor from the CAD pose
  (front half of the machine = catch), so rest = exact CAD pose.
- Elliptical: CAD pedal groups are now PIN-DRIVEN two-body movers (rig.ts): the pin
  joint is the group cluster nearest the crank axle; each frame the group translates by
  the pin's exact orbit (R_x(−θ)·v0 − v0, matching the crank quaternion) and pitches
  about the pin (rotation.x = dy/lever) so the roller end stays on the ramp. Arm swing
  is solved from the same-side pin's fore-aft travel through the lower-link lever
  (rotation.x = −dz/lever) instead of a fixed ±0.22 arc. The stride-ellipse path
  remains as the proxy fallback. Crank junctions can no longer shear by construction.
- Pilates: rope end stops (RX1566/RX1567 + RX990033 screws, 12 nodes) now ride the
  carriage so the hooks stay with the hand-loop grips; the parked full-length rope
  meshes (RX1574-*) are hidden via a "Ropes (parked, unanimated)" group.

Same-day follow-ups (user-reported):
- Lab floor went wild for ellipticals: the LOD keeps only BOUND nodes (viewer.ts
  builds keepNames from bindings), so on lab-floor instances the pin path saw the
  pedal platform as its own "pin" a meter off the axle and orbited it hugely.
  setupPedals now sanity-checks every pin radius (≤0.45 m) and falls back to the
  stride ellipse when the pin clusters aren't present.
- The connecting bar (1002348-*, swing arm ↔ pedal arm) read as static: welded into
  the arm group its foot swept an arc while the pedal arm heaved beneath it. The bar
  (+ its foot-wheel cluster, split from the arm group at hinge.y − 0.15) is now its
  own body pivoting at the arm hinge, angled per frame so the foot points at the
  pedal-arm knuckle (y+iz phasor: rotation.x = arg(u0 + Δknuckle) − arg(u0)).

## Update 2026-07-17 — animation defect diagnosis (recorded evidence)

Recorded each machine mid-scenario (16 timestamped frames + webm each, Playwright) and
ran a frame-analysis + adversarial-verify pass, then live scene-graph introspection via
`window.__viewer`. Verified facts, in fix priority order:

**Rower — the rig binds the wrong parts (inherited from the original hand-authored rig):**
- `361660-1` ("handle", note "handle load cell") is actually the SEAT CUSHION — a
  0.30×0.06×0.25 molded pad, confirmed visually via X-ray isolate. It rides the 0.8 m
  handle slide, so the cushion detaches from its own carriage every stroke.
- The rail carries TWO seat carriages ~0.5 m apart (CAD duplicate; the rear one is a
  "New_*"-prefixed design revision with no cushion). The seat binding (`434166-1_1`,
  rebound 2026-07-16) drives the REAR headless carriage; the FRONT carriage under the
  cushion stays parked. Three clusters move/don't-move independently — kinematic nonsense
  that happens to read as "a seat sliding" from afar.
- Fix: one seat group = cushion `361660-1` + trim `363661-1` + plate `434166-1` + the
  front-carriage rollers/hardware, anchor 0 (CAD pose = catch); hide the rear duplicate
  carriage via a hidden display group; identify the real handlebar node (unknown — maybe
  not a distinct part) before re-adding a handle binding.
- NOT defects: flywheel `448374-1` does spin (verified via pivot rotation + isolate) but
  is a featureless disc behind the shrouds — invisible; the shroud's vaned face is
  correctly static. Seat "salmon tint" during runs = drive_power warn tint on the
  cushion (works as designed, reads oddly because the cushion is mis-bound).

**Elliptical — rigid-translation approximation visibly breaks at three joints (all real):**
- Crank pin / crank arm / pedal-arm rear never touch; the gap rotates with the crank
  (pedal ellipse y-amplitude 0.07 vs crank-pin circle r≈0.19).
- Pole-bottom clamshells + lower-link clevis float free through most of the swing,
  reseating at the low phase (link-bottom sweep 0.16 m vs arm-point sweep 0.24 m).
- Ramp rollers lift ~a pedal-height off the incline rail each cycle.
- Fix direction: two-body pedal-arm model — translate the arm group by the crank-pin
  offset (full r=0.19 circle), pitch about the pin so the roller end stays on the ramp;
  solve arm-swing amplitude/phase from hinge→link-bottom distance instead of fixed 0.22.
- NOT a defect: "doesn't return to rest" — stride decays <2 spm in ~8 s and the glide
  settles to the CAD pose (±2 mm) by ~10-15 s; the recording's rest frame was just early.

**Pilates — two rope artifacts (real, cosmetic-to-wrong):**
- Rope-end stops (RX1566/RX1567, static tray hardware) visually coincide with the
  carriage grips at rest, then hang mid-air/clip into the pad as the carriage leaves.
  Fix option: move the 4 end-stop nodes (+ their RX990033 screws) into the carriage
  attach so hooks travel with the loops (leaves a subtle static-rope-to-hook gap).
- Static rope mesh RX1574 cantilevers ~0.4 m past the head end with a floating T fitting
  (rope modeled straight/parked). Option: hide ropes + fittings via a hidden group.
- Everything else verified correct: carriage sled rigid, springs stretch/relax tracking
  the carriage with no detachment, cosine profile at telemetry rate, rest recovery exact.

**Capture lessons (bake into future recordings):** Playwright screenshot overhead adds
~150 ms/frame — timestamp every frame and compute rates from timestamps or the webm,
never from nominal step; machines stopping from high rates need 20+ s before the "rest"
frame; agents analyzing stills WILL misattribute occluded/overlapping movers — verify
against the live scene graph (`window.__viewer` hook) before trusting frame findings.

## Update 2026-07-10 (second machine, later the same day)

- Dev environment stood up and verified end-to-end with mock data on this machine: Node 24 LTS installed per-user (`%LOCALAPPDATA%\Programs\nodejs`, on user PATH — the MSI needs admin, the zip distribution doesn't), pywin32 installed, `npm install` clean. Verified via API: health, live 10Hz state, quick_check scenario, belt_slip inject → warn → FAIL → clear → recovery events, CSV export (1900+ rows), rig persistence, Vite page serving. Note: both servers bind IPv4/localhost quirks — use `http://localhost:5173` for Vite (it binds ::1) and `http://127.0.0.1:8720` for the API (it binds IPv4 only).
- The 1GB zip was copied to this machine and extracted (`cad/NTL99925-1M00/`, 528 files, root assembly normalized).
- **CAD conversion is HARD-BLOCKED here: this machine has SolidWorks 2022 SP5, and the pack-and-go is SolidWorks 2024 format.** `OpenDoc6` fails with `swFileLoadError_e = 8192` (`swFutureVersion`). SolidWorks cannot open files from a newer major version (only prior-year SP5 installs can open next-year files, so 2022 SP5 tops out at 2023), and there is no "save as older version" on the source side. Every local path (XR add-in export, STEP export, tessellation plan-C) needs the assembly open, so all are dead on this machine.
- The pack-and-go contains only two `.step` files (a PCB and one purchased part) — no neutral-format escape hatch for the full assembly.
- `tools/sw_xr_addin_export.py` now opens via `OpenDoc6` and decodes `swFileLoadError_e`, and logs the SolidWorks revision on connect — it fails loudly with the real reason instead of a bare "assembly failed to open".

**Unblock options (pick one):** (a) finish the export on the old machine with SW 2024 — the pipeline scripts there are validated; (b) upgrade/install SolidWorks 2024+ on this machine (IT/licensing), then `python tools/sw_xr_addin_export.py` + `node tools/optimize_glb.mjs` — the CAD is already extracted; (c) ask the CAD owners (engineering/PLM) for a STEP AP214 or GLB export of NTL99925-1M00 directly — `tools/step_to_glb.mjs` is validated for STEP input.

**In flight on the OLD computer (may or may not have finished):**
- Converting the real CAD (NTL99925 treadmill, 526-file SolidWorks pack-and-go) to `models/current.glb`. `git pull` first — if `models/current.glb` + `models/parts-manifest.json` exist, the conversion landed and the app auto-loads the real model (check `/api/model-info`). Then the demo task is: bind belt/deck/motor/console_screen roles on real parts via the UI.
- If current.glb is NOT in the repo: conversion is still running (or failed) on the old machine. The 1GB `_NTL99925-1M00.zip` is NOT in git. Only pursue local conversion if this machine has SolidWorks AND the zip has been copied over: `python tools/extract_cad.py`, then `python tools/sw_xr_addin_export.py`, then `node tools/optimize_glb.mjs` (needs `pip install pywin32` and the repo's npm dev deps).

## Hard-won CAD pipeline knowledge (don't rediscover this)

- SolidWorks 2024's `.glb` export is **not reachable via the SaveAs COM API** (`SaveAs3` → error 256 invalid extension, both on IModelDoc2 and Extension with proper VARIANT marshaling). The working path is the XR exporter **add-in object**: `sw.GetAddInObject("{0D27D5D6-EB7F-4C0D-82EA-51017C236BDB}")` → `GLTF_FileSave_Assembly(path)` — implemented in `tools/sw_xr_addin_export.py`.
- STEP export of this assembly via COM ran 65+ min with zero output twice (surfaced consumer plastics, 526 components) — treat as a dead end.
- `tools/step_to_glb.mjs` (occt-import-js → gltf-transform) and `tools/optimize_glb.mjs` (drop tiny fasteners, meshopt simplify+compress, emits parts manifest) are both validated. `tools/sw_tessellate_glb.py` is an untested plan-C that pulls `IFace2::GetTessTriangles` straight from an open assembly.
- Assembly open time in SolidWorks: ~12 min. Late-bound COM quirk: `doc.GetTitle` is a property, not a method.
- The pack-and-go is **SolidWorks 2024 format** — any machine doing the conversion needs SW 2024 or newer (2022 fails instantly with `swFutureVersion`, error bitmask 8192). Check the install first: `sw.RevisionNumber` major = model year − 1992 (30 = 2022, 32 = 2024).

## Next steps (in order)

1. `git pull`; if current.glb exists → load it, bind roles on the real model, screenshot the demo, tune `TINY_PART_RATIO`/simplify ratio in `tools/optimize_glb.mjs` if the model is too heavy or missing parts.
2. If conversion didn't land, coordinate getting the GLB (or zip + SolidWorks) onto one machine and finish it.
3. Real hardware wiring (all interfaces stubbed and ready):
   - Sensors: `config.json` → `{"source":"serial","serialConfigPath":"..."}`; config format matches TabletAutoTest's `config/treadmill_sensors.json` (per channel `{port, baud, pattern, scale, unit}`, regex group 1 = value, channels can share a COM port). Install `serialport` in the server workspace and wire port I/O in `server/src/sources/serial.ts` (`SerialSource.start()` TODO; `ingestLine()` parsing is done).
   - Console screen: proxy TabletAutoTest LiveView MJPEG (`GET :8093/v1/devices/{id}/stream?fps=5`) in `server/src/main.ts` (stub: `server/src/screen/`), swap the mock canvas for the stream in `web/src/App.tsx`. TabletAutoTest facts: console exposes NO machine telemetry over ADB (external sensors are the only ground truth); setpoints are commanded via calibrated UI taps; its services start with `python run_services.py` on the rig machine.
4. Later: multi-model support (the fallback/rig architecture is already model-agnostic), QA pass/fail report export, tolerance config per model.

## Watch out for

- zustand v5 selectors must return stable refs (`s.twin?.events ?? []` in a selector = infinite loop crash).
- GaugeCard renders its chart div unconditionally — don't reintroduce an early `return null` before the ref exists.
- The three.js scene modules are imperative (no react-three-fiber); scene changes usually need a full page reload, not HMR.
- `.gitignore` excludes `cad/`, `*.zip`, `*.SLDASM/SLDPRT`, `models/*-raw.glb` — keep the raw CAD out of git; the optimized `models/current.glb` SHOULD be committed.
