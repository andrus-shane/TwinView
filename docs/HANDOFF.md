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

## Update 2026-08-18 — unattended-motion safety watchdog (real bays)

Incident same day: a TabletAutoTest matrix run lost its adb transport mid-run; the
workflow's wrap-up never reached the console and the belt kept running at ~13 mph.
The twin's tolerance logic can't catch this — the run had mirrored its setpoints into
the twin, so expected ≈ measured and every channel read `ok`.

New watchdog (`TwinEngine.watchdogTick`, server/src/twin.ts): on real-source bays
only, if the kind's motion channel (treadmill → `belt_speed`, floor 0.5 mph) reads
above the floor for 5 s while (a) no automation run is `running` for that unit
(bridge status threaded through `FleetOptions.automationRunning`) and (b) no scenario
is active, it raises a `severity: 'alarm'` event (new severity, above `fail`) and
sets `TwinState.unattended`. The web shows a pulsing red banner over the viewport
(`SafetyBanner.tsx`, driven by the level-triggered state flag, so it also appears for
clients that connect mid-incident); alarms also hit the Lab Detections feeds and the
server log (`[SAFETY] …` via console.error in main.ts). Deliberate choices:
- 10 s coast-down grace after a run/scenario ends, so teardown never false-fires.
- Setpoints are IGNORED as an "in charge" signal — stale mirrored setpoints over a
  dead run are exactly the incident.
- A stale telemetry link does NOT clear an active alarm (dead transport over a moving
  belt was the incident); it clears only on a fresh reading < 0.3 mph or a controller
  taking over. Staleness alone never RAISES the alarm either.
- Known blind spot: the automation bridge forgets detached runs across a TwinView
  restart, so a restart under a healthy in-flight run alarms once the grace lapses —
  false positive preferred over missing a genuinely orphaned belt.
- The warn/fail tolerance logic is untouched; mock bays are exempt.

## Update 2026-08-20 — Pi 5 test-harness expansion (planning docs)

The bench rig is being expanded from the Zero 2 W (tach + incline only) into a Pi 5
system-test harness: 8× thermocouples, DC V/A on three rails, AC mains metering,
CAN FD + RS485 bus taps, and relay actuation of the safety key. Three docs:

- `docs/test-harness-parts.md` — research-verified parts list with prices/links
  (silicon ≈$650 + bench essentials ≈$650), revised per the design review.
- `docs/test-harness-parts.html` — the same list as a self-contained website
  (product photos, interactive build total). Serve `docs/` statically to view.
- `docs/test-harness-review.md` — the design review (council of 4 + synthesis).
  Read before wiring anything: it has the bring-up order, the grounding rules
  (one bond point at console ground), and the hard errors it caught (the CAN FD
  HAT's `spi1-3cs` overlay steals the encoder's GPIO17 — use `spi1-1cs`; the
  3-HAT stack is not viable — Sequent DAQ goes off-board on an I2C pigtail;
  M.2 HAT+ dropped in favor of a USB 3 SSD).

Known software migration work when the Pi 5 lands: `setup_adb_bridge.sh` is a
Zero 2 W dwc2 idiom (fails on Pi 5), `rig_monitor.py`'s single 10 Hz loop needs
per-sensor threads before ~25 channels, udev rules by USB serial number before
3+ ttyUSB devices, `tach_quad.c` should resolve the gpiochip by label instead of
hardcoding `/dev/gpiochip0`. Open hardware unknowns: actual rail currents (>30A
has no verified sensor), motor-armature voltage channel unspecced, relay-board
ground topology needs a bench continuity check.

## Update 2026-09-16 (later) — editable lab floor (rows of bays, empty bays, runtime placement)

The fixed `fleet.size` grid is gone. The floor is a **layout** — `LabLayout { align, rows[] }`,
each row `bays[]`, each bay `{ id, label, width, depth, machine: { kind, model } | null }` — in
`shared/src/index.ts`, persisted to `lab.json` (repo root, rewritten on every edit) and edited
live from the web. Named snapshots: `layouts/<name>.json`.

- `server/src/lab.ts`: `seedLayout()` reproduces the OLD floor exactly (ceil(sqrt(n)) columns,
  same kind-spread algorithm the Fleet constructor used, `fleet.models` overrides honored) the
  first time the server runs without `lab.json`; `normalizeLayout()` validates/clamps a client
  layout (ids `^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`, sizes 1.2–6 × 2.2–8 m, ≤200 bays) and coerces
  real-hardware bays to the kind their sensor config declares; `LabStore` = live file + named saves.
- `server/src/fleet.ts`: `Fleet` no longer takes size/mix. `applyLayout(layout)` reconciles the
  roster: new occupied bay → build unit (mock plant, or the real bay's `makeSource()` — sources
  can't restart after `stop()`, so real bays carry a factory now, `RealBaySpec`), emptied/removed
  bay or kind change → stop engine + source and drop it, model/label/order change → update
  `UnitInfo` in place. `UnitInfo.bay` is now the row-major ordinal; the label comes from the bay.
  Seed-fault timers capture unit ids, not indices.
- `server/src/main.ts`: `GET/PUT /api/lab`, `POST /api/lab/reset`, `GET /api/lab/layouts`,
  `PUT /api/lab/layouts/:name`, `POST /api/lab/layouts/:name/load`, `DELETE /api/lab/layouts/:name`.
  WS sends `{ type: 'lab', layout, real }` on connect and on every change (before the `fleet`
  refresh). `assignScreens` reruns after each layout commit (cached device list) so new bays
  pick up spare tablets. `/api/models` entries now carry `kind` (manifest `kind` field, else
  `kindForModel()` SKU-prefix heuristic in shared).
- `web/src/scene/viewer.ts`: `setLab(layout)` + `setFleet(units)` both feed `rebuildFloor()`,
  which rebuilds only when a structural fingerprint (ids, sizes, labels, unit kind/model/serial,
  align) changes. Every bay is a `Slot` root (`userData.bayId`) holding floor marks (outline —
  dashed for empty bays, solid for occupied ones shown only in edit mode — and a selection tint)
  plus, when the unit exists, the machine `Bay` root as a child (`userData.unitId`; `bayFor()`
  now walks ancestors instead of requiring a direct child of `modelRoot`). Rows stack along z at
  the depth of their deepest bay; bays sit along x at their own widths; rows center or left-align.
  Empty slots have a flat invisible hull for picking → `onSelectBay`; in edit mode occupied bays
  also route clicks to `onSelectBay`. `setEditMode(on, selectedBayId)` drives the marks.
- `web/src/components/LabEditor.tsx` (left panel when `labEditing`): rows as cards with bay
  chips, a detail card for the selected bay (label, machine `<select>` grouped by kind — real
  bays filtered to their kind, footprint presets + exact inputs committing on blur/Enter,
  move ◀ ▶ wrapping across rows, clear machine, remove bay), toolbar (+ Row, align, Reset,
  saved-floor Load/✕, Save as). Every edit is optimistic then `PUT /api/lab`; the server's
  normalized copy replaces it (and a 400 rolls back via `GET /api/lab`).
- Store (`web/src/state/store.ts`): `lab`, `labReal`, `labEditing`, `editBayId`, `savedLayouts`,
  `labError` + actions. Focusing a unit closes the editor; Esc closes it at lab level.

Verified in the Browser pane against Shane's already-running dev servers: seed matched the old
roster exactly (`u01` net treadmill, u02/u04 rowers, u06/u07 ellipticals, u09/u11 pilates, u03
NTL17915, u05 NTL17624); added a 5th bay to row 1, placed an NTL17624 in it at XL, added a 4th
row with an empty bay, clicked the empty bay on the floor (both in and out of edit mode), focused
the new u13 (CAD hot-swap fine), saved/loaded/deleted a named floor, PUT a duplicate id (400),
PUT `u01` as a rower (coerced back to treadmill), Reset → original 12-bay floor. No console errors.

Gotchas:
- `lab.json` and `layouts/` are NOT gitignored — the floor is meant to be saveable; commit them
  if the layout should travel with the repo, or ignore them if it should stay local.
- `config.json` → `fleet.size/rowers/ellipticals/pilates/models` only matter when `lab.json`
  is missing (or rejected). Delete `lab.json` (or press Reset) to reseed from config.
- `UnitInfo.bay` no longer equals the number in the id once bays are reordered — use `id`.
- The Browser pane's `find` didn't match the "✎ Edit floor" button by text; `read_page` with
  `filter: interactive` lists it by its `title` attribute.

## Update 2026-09-16 — NTL17624 treadmill conversion (third treadmill model)

`models/NTL17624.glb` (14.0 MB, 136-name manifest, 152 parts, 1.04M tris, creased normals,
bbox 0.79×1.22×2.06 m — a compact folding treadmill, console top at y≈1.07 m) +
`models/NTL17624.manifest.json` + `models/rig.NTL17624.json` (belt, deck, both rollers and
motor bound; `console_screen` left for the UI). Raw GLB 49.8 MB gitignored. Same pipeline and
the same knobs as NTL17915: `SIMPLIFY_RATIO=0.75 CREASE_DEG=40`. Bay override
`config.json` → `fleet.models.u05 = "NTL17624"`.

Source: `Downloads\17624\` — 148 loose files (no zip), root literally `~NTL17624.SLDASM`
(31.8 MB). Copied to `cad/NTL17624/` with the root renamed `NTL17624.SLDASM`; the Downloads
originals were left in place and never written (no unsuppress → no `Save3`).

Run log (no crashes, 17 min wall): pre-launched `SLDWORKS.exe`, RSS settled at ~790 MB in
~20 s; `python tools/sw_tessellate_glb.py <abs cad path> <abs models/NTL17624-raw.glb>`
attached, assembly open 24 s, unsuppress round 1 found NO structural components suppressed
(19 small parts stay suppressed, 0 lightweight, 0 blacklisted — this export is fully resolved,
unlike the NTL99925 pack-and-go), tessellation 814 s for 152 parts / 1.38M tris. Expect an
8-minute quiet stretch after "50 comps" — that's the nine 13–28 MB parts (449675/449704/449706,
449758/449759, 453553/453556/453558/453559), not a hang. `optimize_glb.mjs` took 2 s.

Rig candidates from `_analyze_glb.mjs` (world AABBs, machine front = −Z like the others):
- belt `Walking Belt 24887-2` (0.46×0.05×1.40 m) → rig nodeName `Walking_Belt_24887-2`.
- deck `449766-1` (0.67×0.02×1.29 m, inside the belt loop; wider than the belt).
- rollers = two `279139-1` instances, 41 mm dia. GLB node order puts the REAR one
  (z=+0.985, 0.52 m long) first → `279139-1`, and the FRONT drive roller (z=−0.373, 0.54 m,
  motor end) second → `279139-1_1` (carries the belt_speed tach binding). The suffix is
  deterministic: `GLTFLoader._loadNodeShallow` calls `createUniqueName` synchronously in
  child order, so it follows GLB node order. Both show under Instrumented with no
  "not in model" flag.
- motor `431727-1` (84 mm × 0.30 m, front-left at z=−0.55) with flywheel `204844-1` and
  pulley `N03207-1` — the same part numbers as NTL17915's motor candidates.
- console: top/bottom shells `453557-1`/`453558-1` (0.78 wide, y≈1.07), display pod
  `453554-1`/`453555-1`/`453640-1` (0.30×0.11×0.11) and `453639-1`. None is a flat panel that
  `fitPanel` would pose a screen on, so bind `console_screen` by eye in the UI if wanted.
- uprights `454363-2` ×2 (0.98 m tall), side rails `453597-5`/`453598-4` (1.64 m), foot rails
  `449758-1`/`449759-1` (1.28 m), motor pan/hood `449675-3`/`449704-1` (0.69×0.46 m).
- 17 duplicate names in this GLB (`454363-2`, `453612-1`, `150965-1`, …) — the second
  instance is `<name>_1` in the viewer, so pick the right one when binding.

New gotchas:
- Bay math for the override: with `size 12 / rowers 2 / ellipticals 2 / pilates 2` the specials
  land on u02, u04, u06, u07, u09, u11, so the mock treadmill bays are u01 (real when net/serial
  is up), u03 (NTL17915), u05 (NTL17624), u08, u10, u12. `/api/units` confirms kind + model.
- The dev server was Shane's own `tsx watch src/main.ts` from a terminal. Rather than starting a
  second copy on 8720, touching `server/src/main.ts` (mtime only, no content change) makes tsx
  restart it and re-read `config.json` — no need to kill the terminal process.
- First visit to the bay seeded the rig's `groups` (the app PUTs them back through `/api/rig`),
  which is why `rig.NTL17624.json` grew groups it was not written with. Expected; NTL17915's
  rig got its groups the same way.
- Scratch gltf-transform scripts outside the repo can't resolve `@gltf-transform/core`;
  `node --input-type=module - <args> < script.mjs` from the repo root works because bare
  specifiers resolve against the cwd for stdin modules.

## Update 2026-09-14 — NTL17915 treadmill conversion (second treadmill model)

`models/NTL17915.glb` (21.7 MB, 172-name manifest, 210 parts, 1.68M tris, WITH creased normals,
bbox 0.90×1.44×1.86 m) + `models/NTL17915.manifest.json` + starter `models/rig.NTL17915.json`
(belt + deck only; bind rollers / motor / console_screen in the UI). Raw GLB 80.8 MB gitignored.
Same `sw_tessellate_glb.py` → `optimize_glb.mjs` pipeline, ~23 min tessellation, no crashes.

**"Looks like playdough" (first cut, 4.6 MB / 763k tris) and the fix.** Two causes, measured
with per-part edge-length stats: (1) this assembly's SolidWorks DISPLAY tessellation is ~3×
coarser than the earlier units on big curved shells (console shell `301169-1` p90 edge
15.7 mm vs 4.6 mm on the NTL99925 display `456481-3`; `GetTessTriangles` just returns whatever
image quality the docs were saved with), and (2) the default 35 % simplify stretched those to
~3 cm (21 % of the shell's triangles had an edge > 2 cm), then the viewer's
`computeVertexNormals()` on welded geometry smoothed across every hard edge → melted
plastic. `optimize_glb.mjs` grew env knobs, defaults unchanged so the four older models
reproduce byte-for-byte: `SIMPLIFY_RATIO` (0.35), `SIMPLIFY_ERROR` (0.002), `CREASE_DEG`
(off) which writes a NORMAL attribute with creased smoothing (shared vertices under the angle,
split above it; only 278k of 1.1M vertices split, so the index stays welded for meshopt and
the lab LOD). NTL17915 was rebuilt with `SIMPLIFY_RATIO=0.75 CREASE_DEG=40`. Flat per-face
normals were tried first and are a trap: on curved shells no two faces share a normal, weld
merges nothing (6.6M verts), and the simplifier cannot collapse a triangle soup. For a truly
crisp NTL17915 the remaining lever is SolidWorks-side: raise image quality (or use
`IBody2::GetTessellation` with tight tolerances + `NeedVertexNormal`) and re-tessellate.

Source: `~NTL17915_CROSSBAR_MOD_V2.SLDASM` was NOT a pack-and-go zip. The root + 60 files sat
in `Downloads\NTL17915\` and its other 129 parts were saved loose in `Downloads\` (SolidWorks
had all 175 open when we started). Consolidated into `cad/NTL17915/` (190 files, lock files
`~$*` excluded, root renamed `NTL17915.SLDASM` so the model id is clean). Three references
unresolved and harmless: `119425.SLDPRT`, a Hopi console part in the PDM vault, a PCB
display-board assembly on `R:`.

Rig candidates from `_analyze_glb.mjs` (world AABBs): belt = `Walking Belt 24887-1`; deck =
`349822-2` (0.71×0.03×1.26 m under the belt); rollers = the two `279140-1` instances (48 mm
dia, z=0.21 front / z=1.56 rear; GLTFLoader renames the second `279140-1_1`); motor
candidates `431727-1` / `204844-1` (front-left under the hood `347853-2`); console shell
`301169-1/-2`, display housing `349423-1` (also duplicated). 34 small parts stay suppressed.

New gotchas:
- `OpenDoc6` needs an ABSOLUTE path. Launched via `Start-Process -WorkingDirectory`, a
  relative `cad\...\X.SLDASM` fails with error 2 (file not found): SolidWorks resolves it
  against its own cwd, not python's.
- A fresh SolidWorks launched by `Dispatch` races the dialog watchdog: it closed a blank
  startup dialog and SW died (`RPC failed`) during the first `OpenDoc6`. Pre-launch
  `SLDWORKS.exe`, wait for RSS > 500 MB to settle (~30 s), then run the script so it attaches.
- SolidWorks resolved the copied root's component references to the ORIGINAL absolute paths
  in `Downloads\`, not the siblings in `cad/NTL17915/`. Harmless here (identical bytes, and
  no unsuppress so no `Save3`), but the `cad/` copy is only self-contained once the Downloads
  originals are gone or the references are re-pointed (open in SW, Save As with references).
  A conversion that does checkpoint-save would have written into the Downloads files.
- `optimize_glb.mjs` prints "Triangles before simplify: 0k" for these raw GLBs (non-indexed
  primitives; the count only sees indices). Cosmetic.
- Bays take their CAD model from the machine kind (`NTL99925` for every treadmill), so the
  header picker alone never shows a second treadmill in a unit view. Added a per-bay
  override: `config.json` -> `fleet.models: { "u03": "NTL17915" }` (unit id -> model id,
  `FleetOptions.models`, wins over the kind default). Pick a bay of the matching KIND: the
  override does not change the kind, so putting a treadmill GLB on the rower bay `u02` gives
  rower channels on treadmill geometry. `tsx watch` does not watch `config.json`; restart
  the server after editing it. The bind dialog writes to the PICKER's rig, so keep the header
  set to the same model as the focused bay while binding.
- Same shape for channels: `fleet.channels: { "u03": ["belt_speed", "incline"] }` restricts a
  mock bay's twin to a channel subset (reuses the real-hardware `instrumentedChannels` path
  in `TwinEngine`; gauges and detections for the other channels disappear; the mock fault buttons stay but faults on untracked channels never surface).
- three.js `GLTFLoader` sanitizes node names (`PropertyBinding.sanitizeNodeName`: spaces ->
  `_`), so rig `nodeName`s must use the sanitized form: `Walking_Belt_24887-1`, not the
  manifest's `Walking Belt 24887-1` (the parts panel flags the mismatch as "not in model").

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
