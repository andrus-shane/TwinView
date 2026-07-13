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
