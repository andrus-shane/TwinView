# TwinView — Digital Twin POC for Fitness Equipment QA

A proof-of-concept digital twin for QA testing of treadmills (and later ellipticals, rowers, bikes).
View the unit's CAD model in 3D, click a component to attach a sensor, and watch **expected vs. actual**
behavior live — belt speed, incline, motor current, vibration — plus the console screen.

The twin runs a fault-free reference model of the machine from the commanded setpoints; anything the
sensors measure outside tolerance of that reference flags the part amber/red, logs a QA event, and shows
up in the charts. Faults can be injected into the mock machine to demo exactly what a defective unit
looks like.

## Run it

```bash
npm install
npm run dev:server   # Fastify backend on :8720 (twin engine + mock telemetry + WS)
npm run dev:web      # Vite frontend on :5173 (proxies /api, /ws, /models to :8720)
```

Open http://localhost:5173. Until a converted CAD model exists, a procedural placeholder treadmill
loads with sensors pre-bound. Click any part (or pick it in the left panel) to bind sensor channels
and a twin role. Bindings persist to `models/rig.json`.

## Demo script

1. Run the **Quick check** scenario — belt spins up, deck tilts, console mock shows setpoints.
2. Watch gauges: blue = expected (reference model, includes natural lag), green = measured.
3. Inject **Belt slip** — belt speed diverges ~14%, the belt part flags red, QA event logged.
4. Inject **Incline stuck** mid-ramp — deck freezes at measured angle while the blue ghost frame
   keeps moving to the commanded angle.
5. Export the session CSV from the event log panel.

## Live console screen (adb + scrcpy)

The Console Screen card has a source picker: **Mock (twin)** renders setpoints client-side; picking a
connected adb device streams its real screen onto the 3D console and the sidebar card. Pipeline:
`scrcpy-server` on the device (pushed via adb, `raw_stream=true`) → raw H.264 over
`/ws/screen/:serial` → WebCodecs `VideoDecoder` in the browser → the same console CanvasTexture.
~30 fps, sub-second latency, one encoder session per viewer.

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

- `shared/` — TS types shared by server and web (twin state wire contract, rig config)
- `server/` — Fastify + WS backend: `twin.ts` (reference model + deviation engine),
  `sources/mock.ts` (simulated machine + fault injection), `scenarios.ts` (test profiles)
- `web/` — Vite + React + three.js frontend: `scene/viewer.ts` (3D + picking),
  `scene/rig.ts` (twin behaviors: deck tilt, belt flow, status tint, ghost), `components/` (dashboard)
- `tools/` — offline CAD conversion (Python drives SolidWorks COM; Node converts/optimizes)
