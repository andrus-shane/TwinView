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

## Update 2026-09-16 (latest) — consoles bound per bay in the floor editor (device codes)

FP2 console bindings moved out of `config.json` into the lab layout: `bay.console` in
`lab.json` is `{ "kind": "emulator" }` (Renode PM210) or `{ "kind": "ble", "code": "1CSF" }`
(a real console, found by the device code printed on it — it advertises as
`iFIT_Tread_<CODE>`). Edited from the floor editor's bay card (**Console** select + device
code field), applied live: `syncConsoles()` in main.ts rebuilds `realBays` from the layout on
every commit and `Fleet.applyLayout` now also rebuilds a unit whose source kind or console
link changed (`specChanged`). `config.fleet.consoles` only seeds the default grid
(`'emulator'` or a device code) on a fresh install / Reset.

Gateway side: a BLE console outside the static catalog is registered by TwinView at connect
time with the new `PUT /v1/links/<name>` (TabletAutoTest `services/fp2_gateway/app.py`,
in-memory catalog entry `{transport:'ble', device_name:'iFIT_Tread_1CSF', ...}`; link name
`ble-1csf`). Idempotent, so a gateway restart relearns it on TwinView's next 3 s retry. A
gateway that predates the endpoint answers 405 — the twin logs one warn event saying so.
Rules enforced by `normalizeLayout`: a console bay is a treadmill; one console per bay and one
bay per console (the emulator, or a given code). Config knobs: `fp2EmulatorLcd`
(default `http://127.0.0.1:8889`) and `fp2BleNamePrefix` (default `iFIT_Tread_`).

Pairing (found on the NTL17624, code **1C5F** — digit five; the console is `iFIT_Tread_1C5F`):
an unbonded Windows host gets a GATT connection but the FP2 characteristics never answer
(gateway: "pre-warm 3 attempt(s)" then "FP2 setup over ble failed: failed to fetch supported
features"). The hosts that work (`iFIT_Tread_DFAB`, `_B39F`) are in Windows' paired-device
list; 1C5F was not. So: the unit view's Console card shows **Pair** for a BLE console while
its link is down → `POST /api/units/:id/console/pair` → gateway `POST /v1/ble/pair
{device_name, link}` (bleak `pair()`, Just Works, closes + locks the link meanwhile). Once
per PC; the link then opens on TwinView's next 3 s retry. Also fixed: `Fp2Console` now logs
the gateway's WS close reason (4404/4503) as a warn event, once per distinct reason. Gotcha
hit today: start the gateway with the repo venv (`.venv\Scripts\python.exe -m uvicorn …`),
the system `python` has no `fp2_utils` and every open fails with that message.

Sensors: the Pi rig-monitor (grade board + tach) moved to the Bay 01 NTL17624 — `network_sensors.json`
keys it to `u01`, so the bay is `source: net` and the BLE console attaches commander-only (watchdog
armed by the tach). `NetChannelSpec` gained `offset` (added after `scale`): the WT901 board reads
+2.64 % on a flat deck, so incline carries `"offset": -2.64` (re-tare procedure in the file's note).
TabletAutoTest `config/treadmill_sensors.json` now points straight at `tcp://testingraspberryzero2.local:5000`
(the adb relay is gone); the rig serves several clients, so TwinView and a workflow read it together.

**FP2-commanded speed/incline matrix** (TabletAutoTest): `treadmill.fp2_speed_incline_matrix` +
`fp2_console_check` + `fp2_stop_belt` in `steps/builtin/fp2_matrix.py` command the console board
over FitPro2 THROUGH the FP2 gateway (`POST /v1/links/<link>/write`, 5 Hz `GET` poll) — the same
link TwinView holds, never a second BLE central. Workflows `test.ble_console_speed_incline_matrix`
(auto cross-product from the console's MAX_KPH_LIMIT / MAX_GRADE, 1 mph × 3 % steps) and
`test.ble_console_speed_incline_quick` (5 gentle cells, ~4 min — run it first). Device-less
(serial `host`); expected = the console's accepted TARGET_* (basis `console`), measured = host
sensors when they open else the console's CURRENT_* (per-cell `*_measured_basis`); same judging,
artifact schema and `report.treadmill_tracking_pdf` as the rail-tap matrix; the belt is stopped over
FP2 in the step's `finally` AND by the wrap-up/failure `fp2_stop_belt` node. TwinView launches it
from the unit's Automation card on a console-bound bay: `/api/units/:id/automation/run` passes
`FP2_GATEWAY_URL` / `FP2_GATEWAY_LINK` and serial `host` when the bay has no tablet.

**Desk console** (a BLE-bound bay borrows the model's emulator): a real panel cannot be rendered,
so `syncConsoles` pairs the bay's machine console (`ble-1c5f`) with `DEFAULT_CONSOLE_BY_MODEL[model]`
(NTL17624 → `if20`) as a second `Fp2Console` in role `'desk'`: its Renode LCD is what the unit shows
(`entry.lcd` → the LCD proxy, `UnitInfo.console.desk`, `ConsoleStatus.deskLink`), its membrane keys
(`ConsoleKeys` → `/lcd/press` → emulator) become console-origin TARGET_*/WORKOUT_STATE changes that
fold into the twin and go out to the machine through the machine console's push. The other way the
desk follows the machine: targets via the twin (only while its own workout is active — the board
rejects targets when idle), START/STOP mirrored directly (`peer.requestWorkoutState`, written first in
`push`). Desk role: never adopts the emulator's boot-time {0,0} at hello (forces a mirror write with
`-Infinity` lastSent instead), feeds no telemetry, keeps mirroring during automation runs. Explicit
layout bindings claim links before model defaults, so Bay 01's desk wins `if20` over the mock
NTL17624 bays. Blocker seen 2026-09-16: the IF20 Renode instance (TCP 3460 / panel 8892) was frozen
(`/frame` counter static at 1056) → `fp2 open if20 failed: failed to fetch supported features`; the
PM210/IF17 instances were fine. Restart that Renode instance; the gateway reconnects on its own.
(It came back later the same afternoon; desk link `up`.)

Echo handling (fp2.ts): the gateway tags EVERY relayed write as `origin: 'echo'`, ours or another
client's (the FP2 matrix run). `Fp2Console` now remembers its own in-flight writes (`ownWrites`,
6 s) and folds any other echo in like a console-origin change — so during an automation run the
twin's targets follow what the console accepted and the desk console mirrors the run live
(machine console still never writes while a run is active). Before this the desk sat dark
during runs.

First live results (Bay 01 NTL17624, 2026-09-16): quick matrix — speed within tolerance but
+0.15..0.24 mph high at every cell; incline console 3 % → deck 4.4 %, 6 % → 8.4 %, and the
console snapped a TARGET_GRADE 9 to 10 (IF20 quantizes). Full matrix (45 cells, 25 min) — speed
+0.13..0.41 mph high 1–9 mph; incline data INVALID: the WT901 grade stream froze for whole 20 s
windows (203 identical samples) and jumped by many percent between blocks, at-rest reading
wandered 2.3 → 6.0 %. Sensor/mount/wiring fault on the rig, not the machine (Shane: the board fell
off and was remounted backwards). The FP2 matrix step now drops bit-identical windows
(`frozen_sensor_cells`) instead of judging them.

Rerun with the board remounted (17:18, 45 cells): rock-steady and repeatable to ±0.02 % across all
speeds — console 3 % → 4.40 % grade, 6 % → 8.40 %, 9 (snapped to 10 by the IF20) → 9.26 %,
10 % → 9.26 % (physical top). That is the NTL17624's incline calibration, not the rig. Speed error
grows with speed: +0.18 mph at 1–2 mph → +0.43 mph at 9 mph (~5 % fast), still inside ±0.5.
One 20 s window came back bit-identical and was dropped by the frozen guard (console fallback).

Also learned: this console reports CURRENT_KPH = 0 over FP2 while the belt runs (like the desk
console), so the step no longer refines the twin from CURRENT_*; it pushes the console's ACCEPTED
targets instead, and a zero current speed against a non-zero command is recorded as "not
reported". Desk-emulator guard (fp2.ts): the IF20 firmware changes its own targets (zeroes them
when its workout ends), so desk-origin TARGET changes steer the machine only within 3 s of a
membrane key edge and never during an automation run; otherwise ignored and re-mirrored.
International consoles: `bay.units = 'kph'` ("Displays km/h (international unit)" in the bay
card, on the BAY so tablet bays have it too) → every run from the bay gets `FP2_SPEED_UNIT` +
`TREADMILL_SPEED_UNIT` = kph → the FP2 matrices step in whole km/h (`speed_kph` per segment,
km/h companions in the records; the quick variants have km/h cell sets). TwinView presentation
follows too: `UnitInfo.units`, `TwinEngine.setSpeedUnit()` converts belt_speed in `getState()`
(values, tolerances, unit label), deviation/watchdog events and `formatSpeed()` for the FP2
event text; the Controls slider and console line work in km/h. Internals (setpoints, FP2, plant)
stay mph. The rail-tap tablet matrix does not read the flag yet.

Gateway (2026-09-17): now launchable from TwinView's `.claude/launch.json` as `fp2-gateway`
(cmd → TabletAutoTest venv uvicorn), so Claude Code can restart it and read its logs; the old
Administrator-cmd instance could not be killed from a normal shell (access denied). Subscriptions
added: `DRV_MTR_CURRENT_SPEED`, `DRV_MTR_TARG_SPEED`, `RC_CURRENT_SPEED`, `RC_TARGET_SPEED`,
`HDRV_SPEED_LPF`, `DISPLAY_UNITS`. The NTL17624/IF20 board accepted ONLY `DISPLAY_UNITS` (=1,
metric — confirms the km/h console; TwinView could auto-detect from it later) and pruned every
motor-controller speed feature: it publishes no belt speed of its own, so the Pi tach stays the
only measurement. The IF20 Renode instance hangs at PC 0x1d32a after each gateway restart until a
`machine Reset` through its monitor (telnet 33338); the link then opens on the next retry.

**Stop-to-stop over FP2** (`treadmill.fp2_accel_decel_matrix`, the twin of
`treadmill.accel_decel_matrix`): per cell belt confirmed at rest (tach), deck returned to 0 %
AND driven to the cell's incline (console CURRENT_GRADE confirms, fallback settle), TARGET_KPH
written (tach confirms), hold 10 s judged like the steady matrix, TARGET_KPH=0 (tach confirms);
`_ramp_stats` accel/decel, ASTM decel gate, cycle_faults = accel/decel timeouts + rejected
commands. `zero_incline_between` (default true — Shane's ask: expose cells that only track
because the previous one left the deck there) doubles deck travel: ~2 min per 10 % cell.
Workflows `test.ble_console_accel_decel_matrix` (auto-range) and `_quick` (4 cycles, ~6 min).
Measurement code shared with the steady step via `_measure_window()`.

## Update 2026-09-16 — Pi rig-monitor moved to the BLE-console bay (u03)

The Zero 2 W sensor hub left bay 1 (tablet console, adb relay through SZ00000141) for the
NTL17915 / `iFIT_Tread_DFAB` bay. No tablet there, so there is no adb passthrough of any
kind any more: `network_sensors.json` now keys the Pi to `u03` by
`testingraspberryzero2.local`, `u01` is a mock bay again, and the Pi's
`adb-server`/`adb-bridge` units are disabled. With the Pi owning `belt_speed` on u03 the
FP2 console attaches commander-only (main.ts warns at boot) and the unattended-motion
watchdog is armed there again (see the 2026-09-16 FP2 section above for why FP2 alone
could not do that).

Networking: the dev laptop must be on lab Wi-Fi `OS Testing` (192.168.1.0/24, the SAME
LAN as the old "isolated bench Wi-Fi") — corporate `iconwireless` has no route. The Pi's
SD card gained `OS Testing` (WPA3/SAE) next to `ifit`, instance-id bumped to
`rig-20260916-ostesting`; the Pi kept 192.168.1.134. Verified live: rig-monitor active,
0 restarts, tach_quad child up, 10 channels at 10 Hz reaching the laptop, `/api/units/u03/state`
fed by `source: net`. Tooling: `pi-rig-monitor/check_pi.sh` (plink needs `-batch -hostkey`;
PuTTY's host-key prompt goes to the console and hangs scripts otherwise). Pi MAC OUI is
`88:A2:9E` (Raspberry Pi Trading) — sweeps that only know the older Pi OUIs miss it.

Open: incline on the NTL17915 reads ≈ +2.6 % at rest — the WT901 mount differs from bay 1
and `PITCH_RAW_LEVEL` (-0.68°) is bay-1's bubble-level calibration; u03 incline sits in
FAIL until re-leveled on this unit (and `net.ts` has `scale` but no `offset` field, so a
console-units tare would need either a Pi-side constant or a small NetChannelSpec addition).
Also noticed: the boot partition holds ~10 MB of oddly named files (`XORXOR…`, `ZZZZZ…`,
`DsTpX…`, `!!!!!…`, Aug 11–Sep 14) of unknown origin — left in place.

## Update 2026-09-16 — FP2 consoles (emulator + BLE) via the TabletAutoTest FP2 gateway

A bay can now be bound to a FitPro2 console — the Renode PM210 emulator or the
physical BLE desk console — and TwinView commands it over FP2 instead of UI taps.
TypeScript never speaks FP2: the TabletAutoTest **FP2 gateway** (FastAPI,
`services/fp2_gateway`, 127.0.0.1:8102) is the single FP2 master on the host and
decodes features/keys into labels. It must be running:
`python -m uvicorn services.fp2_gateway.app:app --host 127.0.0.1 --port 8102` from the
TabletAutoTest checkout (or `python run_services.py`, which registers it). Links open
lazily on first use, so the gateway itself binds instantly even for BLE.

Config (`config.json`, restart the server after editing — `tsx watch` ignores it):
- `fp2Gateway`: gateway base URL, default `http://127.0.0.1:8102`.
- `fleet.consoles`: unit id -> gateway link name (`"u03": "dfab"`) or
  `{ "link": "emulator", "lcd": "http://127.0.0.1:8889" }` when the console is the emulator
  and its HTTP panel should be proxied for the LCD card. Link names are the gateway's
  catalog (`config/fp2_consoles.json` in TabletAutoTest): `emulator` = Renode simuart,
  `dfab` = BLE desk console. Config-only switch between them.
- `TWINVIEW_CONFIG=<path>` env var points a run at an alternate config file (absolute or
  relative to the repo root) — used by the verify runs.
- A console bay must NOT also list `belt_speed` in `fleet.channels` (that override beats the
  source's declared channels and the gauge would sit permanently stale).

Wiring (`server/src/fp2.ts`, `Fp2Console implements TelemetrySource`, kind `'fp2'`):
- Registered into `realSources` like serial/net, so Fleet makes the bay real with no
  fleet.ts change (no autorun, no seeded faults, `auto:false`). If serial/net already own
  the bay the console attaches commander-only (warned at boot): setpoints out, events in,
  no channels.
- Outbound: subscribes to the previously unused `engine.onState` (fires at the end of every
  100 ms tick, after scenario playback has replaced `engine.setpoints`, so operator API,
  playback, stop and complete are all seen). Deadband 0.05 vs the last value sent, mph ->
  `TARGET_KPH` (x1.609344), `%` -> `TARGET_GRADE`, clamped to the console's
  `MAX_KPH_LIMIT`/`MAX_GRADE` with a warn event. `running` false->true writes
  `WORKOUT_STATE=3`, true->false writes `5` (pause). Every write is `POST
  /v1/links/<link>/write` and its echo lands as a twin event (`echoed in N ms`, `unchanged`,
  `not echoed in 2 s`, or `console clamped`). Writes are skipped while an automation run is
  active on the bay (never two masters).
- Inbound: the gateway WS `/ws/links/<link>` streams 10 Hz ticks. `CURRENT_GRADE` becomes the
  `incline` sample (refreshed every tick while the link is up, so a dead link goes stale
  within 1.5 s). Console-origin `TARGET_*` changes fold back with `engine.setSetpoints` (a
  human pressing console keys moves the twin's sliders), `WORKOUT_STATE`/`KEY_COOKED` become
  info events with the gateway's labels, `SYSTEM_ERROR != 0` a warn.
- On hello the console's own targets are adopted (the machine is the source of truth at
  connect — a server restart never writes the boot-time `{0,0}` over a running belt).
- Status rides the existing 10 Hz `states` batch and `/api/units/:id/state` as
  `TwinState.console` (`ConsoleStatus`: link up/down, transport, workout state + label, target
  mph/grade, last key, last echo ms); `UnitInfo.console = { link, lcd }` says a bay is bound.

LCD proxy (`server/src/pm210.ts`), emulator bays only, keyed by unit id:
`GET /api/units/:id/lcd/panelmap` (memoized, static geometry), `GET .../lcd/frame`
(`{frame, ..., ram}` — a lit element is `ram[a] & m` against the 660-byte hex RAM),
`POST .../lcd/press {index 0..4, mask 0..255}` (down / 150 ms / up, release in `finally`:
held masks latch on the emulator until an explicit release). 503 `no LCD bound to this
unit` for BLE/unbound bays. No hold/release, no `/dmk`.

**FP2 gives COMMANDING, not WATCHING.** Both motor-less consoles (desk unit and emulator)
report `CURRENT_KPH == 0`, so FP2 must never feed `belt_speed`: a 0 mph sample would fail
against the reference plant and, worse, make `moving` permanently false and silently
disarm the unattended-motion alarm — the 2026-08-18 incident. Consequence: the FP2-only bay
has no `belt_speed` channel, so `TwinEngine.watchdogTick` returns early (twin.ts:429) and
**the unattended-motion alarm is disarmed on u03 until an independent tach (Pi net source)
owns `belt_speed`.** Watchdog semantics are otherwise untouched: an FP2-driven scenario is
"in charge" exactly like today's scenarios; `WORKOUT_STATE` was deliberately NOT made an
in-charge signal (it would disarm the alarm the watchdog exists for).

Skipped on purpose: merged source (FP2 + Pi on one bay), watchdog widening, `/dmk`, key
hold/release, a REST console route (status rides the states batch), TS-side reconnect
supervision beyond the 3 s WS retry.

### 2026-09-16 later — model-keyed binding, four emulators, IF17/IF20 LCD

Gateway link names (TabletAutoTest `config/fp2_consoles.json`): `pm210` (ETNT17915V2, TCP
3457), `if17-xylophone` (ETPF59724BCV1, 3458), `op` (bike, 3459 — not bound by TwinView),
`if20` (ETNT17624V1, 3460), `if17-esp` (ETPF90924V1, 3461), `dfab` (BLE desk console). The
old name `emulator` is gone; `fp2EmulatorLcd` went with it.

Binding (`server/src/consoles.ts`, pure + `consoles.test.ts` via
`node --import tsx --test server/src/consoles.test.ts`): `DEFAULT_CONSOLE_BY_MODEL`
(NTL17915 -> pm210, NTL17624 -> if20, PFTL59724 -> if17-xylophone, PFTL90924 -> if17-esp) and
`LCD_BY_LINK` (panel HTTP 8889/8890/8891/8892/8893, server-side only — the browser never
learns the emulator host). Per bay, first hit wins (`bindingFor` in main.ts):
1. `bay.console` from the floor editor — BLE by device code (`ble-<code>`, registered with
   `PUT /v1/links`), or `"emulator"` = the emulator for the model placed on the bay (PM210
   when the model has none);
2. `config.fleet.consoles[unitId]` — a gateway link name (`"dfab"`) or `{ link, lcd }` to
   pin a panel URL (config-only emulator <-> BLE switch);
3. `DEFAULT_CONSOLE_BY_MODEL[bay.machine.model]`.
So a bay whose placed model is one of the four automatically shows THAT emulator's LCD and
talks FP2 to THAT link; `syncConsoles()` re-derives everything from the layout on every
commit, so a model swap in the lab editor rebuilds the unit and rebinds the console (the
unit's event ring is lost; the gateway keeps the old link open by design —
`DELETE /v1/links/<name>` drops a BLE session). A console takes one master: two bays
resolving to the same link (two NTL17624s) -> first bay in floor order wins, the rest are
warned and stay mock. Sensor-owned bays (Pi/serial) still attach commander-only. The seeded
grid no longer stamps `bay.console`; `fleet.models` fixes each pinned bay's kind instead
(`kindForModel`), so the shipped `config.json` (`size 12`, models u03..u06) never lands a
treadmill model on a rower slot. `TWINVIEW_LAB=<path>` (like `TWINVIEW_CONFIG`) points a
run at an alternate live floor so verify runs never touch `lab.json`.

fp2.ts: the gateway now subscribes `KEY_ARRAY1..4` (raw membrane bytes, idle 255). Consoles
without `KEY_COOKED` (IF20, both IF17s — `hello.subscribed` says) get their presses named
from the bound emulator's panelmap (`panelmap()` memo shared with the LCD proxy): exact
`(index, mask)` hit, else chord `A+B`, else `KEY_ARRAYn=v`; the same key twice with no 255 in
between is one edge. `KEY_COOKED` wins where subscribed (PM210, BLE). A console-origin
`WORKOUT_STATE` 5/0 leaving an active state (2/3/4) while a scenario runs calls
`engine.stopScenario()` + a warn event (`Console stopped workout - scenario aborted`); our own
end-of-scenario 5 arrives as an echo and is skipped, and 6 (results) never aborts. Write
replies carry `errors` (board rejections such as `DATA_OUT_OF_RANGE`) -> one warn instead of
the misleading `not echoed` line. FP2-only bays log one warn at start (`no independent tach
... watchdog disarmed`) — the disarm is unchanged, now visible.

Web (`web/src/scene/pm210Lcd.ts`, one renderer): the schema comes from the panelmap, never
from `display`, port or model — `gpiokeys`/`punct` -> unsupported first (OP bike),
`Array.isArray(digits)` -> segments (IF17/IF20 digits + font, port of
`IF20HT1621Panel.cs draw(d)`), else dots (PM210 polygons). IF glass is letterboxed to 16:10
in the canvas; `ConsoleKeys` sections come from `keys[].sec` (adds `media`).

Follow-ups: OP bike (needs a bike `MachineKind`, `POST /gpio` presses, third panel schema;
`panelSchema()` returns `unsupported` so a hand binding cannot crash the viewer); grace bump
on console-origin START for instrumented bays (needs a TwinEngine API); per-client `_EXPECT`
in the gateway (exactly one TwinView server per gateway link today); lab-wall emulator LCDs;
key edges from `link.samples`.

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
the same knobs as NTL17915 plus one drop: `SIMPLIFY_RATIO=0.75 CREASE_DEG=40 DROP_NODES=150965-1#0`.
The first `150965-1` instance (a motor-area bracket) floats unmated 0.4 m ahead of the hood at
y=0.41 with nothing within 0.3 m — a CAD artifact, so `optimize_glb.mjs` grew `DROP_NODES`
(`name` = every instance, `name#k` = k-th in GLB node order; defaults unchanged). With it gone the
surviving instance is plain `150965-1` in the viewer (no `_1`), so the rig groups were fixed up. Bay override
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
   - SUPERSEDED for FP2-capable consoles (see 2026-09-16): FP2 is the preferred commander and telemetry path; adb taps remain for tablet consoles. Console screen: proxy TabletAutoTest LiveView MJPEG (`GET :8093/v1/devices/{id}/stream?fps=5`) in `server/src/main.ts` (stub: `server/src/screen/`), swap the mock canvas for the stream in `web/src/App.tsx`. TabletAutoTest facts: console exposes NO machine telemetry over ADB (external sensors are the only ground truth); setpoints are commanded via calibrated UI taps; its services start with `python run_services.py` on the rig machine.
4. Later: multi-model support (the fallback/rig architecture is already model-agnostic), QA pass/fail report export, tolerance config per model.

## Watch out for

- zustand v5 selectors must return stable refs (`s.twin?.events ?? []` in a selector = infinite loop crash).
- GaugeCard renders its chart div unconditionally — don't reintroduce an early `return null` before the ref exists.
- The three.js scene modules are imperative (no react-three-fiber); scene changes usually need a full page reload, not HMR.
- `.gitignore` excludes `cad/`, `*.zip`, `*.SLDASM/SLDPRT`, `models/*-raw.glb` — keep the raw CAD out of git; the optimized `models/current.glb` SHOULD be committed.
