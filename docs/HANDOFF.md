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
