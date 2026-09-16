# TwinView — Digital Twin QA Lab POC for Fitness Equipment

A proof-of-concept digital twin of a **QA lab floor**: a fleet of treadmills (and later ellipticals,
rowers, bikes) tested simultaneously, each with its own simulated plant and twin engine. Watch the
whole floor at once — status halos, detection badges, a lab-wide detections feed — then drill into a
single unit (full CAD model, gauges, console screen), and further into a single component (x-ray
isolate, per-channel expected-vs-measured, part-scoped detections).

Each twin runs a fault-free reference model of its machine from the commanded setpoints; anything the
sensors measure outside tolerance of that reference flags the part amber/red, logs a QA event, and
rolls up to the unit halo and the lab KPIs. Faults can be injected per unit to demo exactly what a
defective machine looks like.

## Run it

```bash
npm install
npm run dev:server   # Fastify backend on :8720 (fleet of twin engines + mock telemetry + WS)
npm run dev:web      # Vite frontend on :5173 (proxies /api, /ws, /models to :8720)
```

Open http://localhost:5173. The lab floor boots with 12 units — 6 NTL99925 treadmills, 2 FMRW0826
rowers, 2 NTEL71426 ellipticals, and 2 NTPL99926 pilates reformers spread through the bays — on
staggered auto-cycling scenarios and five seeded faults (belt slip, vibration burst, rower
drive-belt slip, elliptical bearing knock, reformer carriage drag) so detections start flowing
within ~25 s. Autorun / fault seeding are configurable via `config.json` →
`"fleet": { "autorun": true, "seedFaults": true }`; the floor itself is edited live (below).

## Lab floor layout (edit at run time)

The floor is **rows of bays**, each bay sized independently and either empty or holding one
machine. It lives in `lab.json` next to `config.json` and is rewritten on every edit, so a
restart comes back to the same floor. The first boot with no `lab.json` seeds the classic grid
from `config.json` → `"fleet": { "size", "rowers", "ellipticals", "pilates", "models" }` (those
keys are only a seed after that).

**Edit floor** (left panel at lab level, or click any dashed empty bay) opens the editor:

- **Rows** — add / remove / reorder; rows can hold different numbers of bays and line up
  centered or left-aligned.
- **Bays** — add to a row, remove, move left/right (wrapping into the neighboring row), rename,
  pick a footprint (Compact / Standard / Wide / XL presets or exact width × depth in metres).
- **Machine** — choose any model from the catalog (grouped by kind) or leave the bay empty.
  Placing a machine spins up its plant + twin engine on the spot; clearing it tears them down.
  Bays wired to real hardware (`network_sensors.json` / serial config, keyed by bay id) are
  marked **HW** and only accept models of the kind their sensor config declares.
- **Save as / Load / Reset** — named snapshots go to `layouts/<name>.json`; Reset returns to the
  `config.json` grid.

A bay's id (`u01`, `u02`, …) doubles as its unit id while occupied, so tablet pins
(`fleet.screens`), channel subsets (`fleet.channels`) and hardware configs keep pointing at the
same slot. API: `GET/PUT /api/lab`, `POST /api/lab/reset`, `GET /api/lab/layouts`,
`PUT /api/lab/layouts/:name`, `POST /api/lab/layouts/:name/load`, `DELETE /api/lab/layouts/:name`;
the WS pushes `{ type: 'lab' }` on every change.

## Drill-down

- **Lab** — every bay shows the real CAD machine, live (belts scroll, platforms tilt, halos pulse
  by status, badges count active deviations, failing parts tint red on the floor). The fleet
  renders a merged LOD built at runtime from the same GLB: bound parts stay separate nodes so they
  animate/tint per unit, the rest merges per platform/towers × material and is meshopt-decimated to
  ~25% — geometry shared across bays (~240 draw calls, ~11M tris for 12 units vs ~17k draw calls
  naively). Left: fleet list. Right: KPI rollup + all-units detections feed (click a detection to
  jump to its unit). Click any machine or fleet row to drill in.
- **Unit** — camera flies into the bay and seamlessly swaps the LOD for the full part-level CAD
  model (same shape, 1,359 selectable parts). Without a converted GLB, procedural proxies are used
  everywhere instead.
  Scenario/setpoint controls (any manual action takes over from autorun; re-enable with the `auto`
  checkbox), fault injection, live console screen, all four channel gauges, per-unit CSV export.
  Neighboring units stay visible and clickable.
- **Component** — click a part (or pick it in the parts panel): camera dives in, the rest of the
  machine goes x-ray (toggleable), and the inspector shows the part's role, sensors, bound-channel
  gauges, and its detection history. `Esc` walks back up: component → unit → lab.

## Demo script

1. Open the lab — watch the floor spin up: staggered scenarios, green halos, blue "commanded"
   ghost decks tilting with each incline sweep.
2. Within ~20 s the seeded **belt slip** (Bay 03) and **vibration burst** (Bay 11) start flagging:
   red/amber halos + ⚠ badges in 3D, KPI tiles count them, detections stream in the feed.
3. Click the Bay 03 detection — the camera flies into the bay and the CAD twin loads. Belt speed
   gauge shows measured diverging ~14% from expected.
4. Click the motor (or `1000889-1` in the parts panel) on Bay 11 — x-ray isolate reveals it through
   the shell; the vibration gauge shows the burst spikes against the flat expected trace, with the
   part's detection history alongside.
5. Export the unit's session CSV from the event log panel.

## Mixed fleet: machine kinds

Every unit has a `kind` (`treadmill` | `rower` | `elliptical` | `pilates`) that drives its whole
stack — plant model, sensor channels, faults, scenarios, 3D rig, dashboards:

- **Plants** (`server/src/plant.ts`): the rower's stroke cadence lags toward the commanded rate,
  its brake servo slews between levels, and its flywheel chases cadence (higher brake = lower mean
  rpm) with cubic-ish drive power; the elliptical's stride cadence settles the same way while the
  power ramp slews like the treadmill's lift motor; the reformer's rep tempo settles against a
  magnetic tension servo, with carriage travel shortening slightly at brisk tempos and work rate =
  spring force × stroke × tempo.
- **Channels**: rower = stroke rate / flywheel speed / drive power / resistance; elliptical =
  stride rate / ramp incline / drive power / vibration; pilates = rep cadence / carriage travel /
  drive power / resistance. Shared channel ids (incline, vibration, drive power, resistance)
  resolve to per-kind expected-value models in the twin engine.
- **Faults**: rower — drive belt slip (flywheel runs ~20% slow), resistance stuck, power sensor
  drift, stroke sensor dropout; elliptical — ramp stuck, bearing knock (periodic vibration thumps),
  generator drag (+22% effort), cadence dropout; pilates — spring fatigue (light load + low
  tension), carriage drag (short stroke, extra effort), tension stuck, rep sensor dropout.
- **Scenarios**: per kind (steady row / stroke intervals / resistance ladder; steady stride / ramp
  sweep / stride intervals; steady flow / tension ladder / tempo intervals). Autorun and the
  scenario picker only offer a unit its own kind's.
- **3D**: every converted model loads side by side — each bay shows *its own* machine's merged CAD
  LOD at lab level and full part-level CAD on focus, with model-scoped rigs
  (`models/rig.<MODEL>.json`). CAD animation rides binding roles: the rower's seat sled and the
  reformer's carriage sled (auto-grouped from the parts clustered around the bound part) slide
  through their stroke/rep cycles at *measured* cadence — the reformer's visible stroke length is
  the *measured* travel, so a dragging carriage literally comes up short; elliptical pedals orbit
  a shared stride ellipse with arm poles swinging opposite; flywheels spin via bbox-centered
  pivots. Status tinting, halos, badges, x-ray isolate, and part detections work identically
  across kinds. The two operator axes stay `speed`/`incline` on the wire; per-kind metadata
  relabels them in the controls and console.

## Live console screen (adb + scrcpy)

Connected tablets are assigned to bays at startup (and on every device rescan): explicit pins via
`"fleet": { "screens": { "u01": "<adb serial>" } }` in `config.json`, then remaining devices fill
unpinned bays in serial order (`"autoScreens": false` disables the fill). Every mapped bay streams
its tablet onto its 3D console **at lab level** using the `lab` encoder profile (480 px, 2 fps,
300 kbps — H.264 deltas make an idle screen nearly free, so ~20 concurrent streams stay cheap).
Console textures re-upload only when a frame actually arrives.

Focusing a unit switches its device to the full-quality `unit` profile (1024 px, 30 fps, sub-second
latency) and defaults the Console Screen card's source picker to the mapped tablet; **Mock (twin)**
renders setpoints client-side instead. Pipeline either way: `scrcpy-server` on the device (pushed
via adb, `raw_stream=true`) → raw H.264 over `/ws/screen/:serial?profile=lab|unit` → WebCodecs
`VideoDecoder` in the browser → the console CanvasTexture. One encoder session per stream per
viewer; dropped lab streams reconnect on their own with jittered backoff.

Requires scrcpy on the host (`winget install Genymobile.scrcpy`) — auto-detected from PATH or the
winget install dir, or set `"scrcpyDir"` in `config.json`. `?screen=<serial>` in the URL preselects
a device (demo links). Chromium-based browser needed for WebCodecs.

## Real hardware later (mocked now)

- **Sensors** (`server/src/sources/serial.ts`): same architecture and config format as
  TabletAutoTest's `config/treadmill_sensors.json` (`{port, baud, pattern, scale, unit}` per channel,
  regex group 1 = value, shared COM ports supported). Set `config.json` → `"source": "serial"`,
  `"serialConfigPath": "..."`, install `serialport`, wire the port I/O in `SerialSource.start()`.
- **Commanded setpoints** can be driven through TabletAutoTest's Device Bridge (`:8096`) tap actions.

## CAD pipeline (SolidWorks → web)

```bash
python tools/extract_cad.py            # unzip pack-and-go into cad/
python tools/sw_export_glb.py          # SolidWorks COM: tries .glb (XR exporter), falls back to .step
node tools/step_to_glb.mjs             # STEP → GLB with part names (occt-import-js), if step fallback used
node tools/optimize_glb.mjs            # simplify + drop fasteners + meshopt → models/current.glb + manifest
```

When `models/current.glb` exists the app loads it instead of the placeholder (restart not required —
reload the page). Rig bindings are per-node-name, so re-bind belt/deck/motor/console once on the real
model.

## Layout

- `shared/` — TS types shared by server and web (fleet + twin state wire contract, rig config)
- `server/` — Fastify + WS backend: `lab.ts` (floor layout: seed from config, validate,
  persist `lab.json` + named `layouts/`), `fleet.ts` (roster reconciled from the layout's
  occupied bays: per-unit plant + engine, autorun, seeded faults), `twin.ts` (reference model +
  deviation engine), `sources/mock.ts` (simulated machine + fault injection), `scenarios.ts`
  (test profiles). WS pushes a 10 Hz batched state for all units plus individual events; REST is
  unit-scoped under `/api/units/:id/…`, floor-scoped under `/api/lab`
- `web/` — Vite + React + three.js frontend: `scene/viewer.ts` (lab floor: layout-driven bay
  slots with per-bay footprints, empty-bay outlines, halos, badges, camera flights, CAD hot-swap,
  level-aware picking via invisible bay hulls), `components/LabEditor.tsx` (floor editor),
  `scene/lod.ts` (fleet LOD: merge + meshopt-simplify the CAD assembly, shared across bays),
  `scene/rig.ts` (per-unit twin behaviors: deck tilt, belt flow, status tint, ghost),
  `components/` (lab dashboard, fleet panel, component inspector, unit dashboard)
- `tools/` — offline CAD conversion (Python drives SolidWorks COM; Node converts/optimizes)
