import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  FAULT_IDS,
  MACHINE_KINDS,
  kindForModel,
  type ChannelId,
  type FaultId,
  type LabBay,
  type LabLayout,
  type LabRealBays,
  type MachineKind,
  type RigConfig,
  type ServerMessage,
} from '@twinview/shared';
import { AutomationBridge } from './automation.js';
import {
  DEFAULT_CONSOLE_BY_MODEL,
  LCD_BY_LINK,
  resolveConsole,
  type ConsoleBinding,
  type ConsoleSpec,
} from './consoles.js';
import { Fleet, type RealBaySpec } from './fleet.js';
import { Fp2Console } from './fp2.js';
import { LabStore, baysInOrder, normalizeLayout, seedLayout } from './lab.js';
import { registerLcdRoutes } from './pm210.js';
import { NetSource, loadNetConfig } from './sources/net.js';
import { SerialSource, loadSerialConfig } from './sources/serial.js';
import type { TelemetrySource } from './sources/types.js';
import { SCENARIOS } from './scenarios.js';
import {
  initScreens,
  isStreamProfile,
  listScreenDevices,
  screensReady,
  ScreenStream,
  SERIAL_RE,
  swipeDevice,
  tapDevice,
} from './screens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const MODELS_DIR = join(ROOT, 'models');
const RIG_PATH = join(MODELS_DIR, 'rig.json');
// TWINVIEW_CONFIG (absolute or relative to the repo root) points a run at an alternate config
const CONFIG_PATH = process.env.TWINVIEW_CONFIG
  ? resolve(ROOT, process.env.TWINVIEW_CONFIG)
  : join(ROOT, 'config.json');
/**
 * The live lab floor (rows of bays); rewritten on every edit. Named snapshots go in layouts/.
 * TWINVIEW_LAB (absolute or relative to the repo root) points a run at an alternate live floor — used by the verify runs.
 */
const LAB_PATH = process.env.TWINVIEW_LAB ? resolve(ROOT, process.env.TWINVIEW_LAB) : join(ROOT, 'lab.json');
const LAYOUTS_DIR = join(ROOT, 'layouts');

const STATES_TICK_MS = 100; // 10 Hz fleet state batch
const EVENT_BACKLOG = 120; // merged events sent to new WS clients

interface AppConfig {
  source: 'mock' | 'serial';
  serialConfigPath?: string;
  /** Path to the network-units config (Raspberry Pi TCP rigs); see network_sensors.json */
  netConfigPath?: string;
  port: number;
  scrcpyDir?: string;
  /** FP2 gateway base URL (TabletAutoTest services/fp2_gateway); default http://127.0.0.1:8102 */
  fp2Gateway?: string;
  /** Advertised BLE name prefix — the device code shown on the console completes it; default iFIT_Tread_ */
  fp2BleNamePrefix?: string;
  /**
   * Seed for the lab floor the FIRST time the server runs (no lab.json yet):
   * size/rowers/ellipticals/pilates/models describe the classic grid. After
   * that the floor lives in lab.json and is edited from the web UI.
   */
  fleet?: {
    size?: number;
    rowers?: number;
    ellipticals?: number;
    pilates?: number;
    autorun?: boolean;
    seedFaults?: boolean;
    /** Pin a unit's console to a tablet: unit id → adb serial */
    screens?: Record<string, string>;
    /** Assign the remaining connected tablets to unpinned bays in order (default on) */
    autoScreens?: boolean;
    /** Override a bay's CAD model: unit id -> model id from models/ (e.g. "u02": "NTL17915") */
    models?: Record<string, string>;
    /** Restrict a bay's tracked channels: unit id -> channel ids (e.g. "u03": ["belt_speed","incline"]) */
    channels?: Record<string, string[]>;
    /**
     * Pin a bay's FP2 console: unit id -> gateway link name ("dfab") or { link, lcd }.
     * Beaten by bay.console from the floor editor; default = DEFAULT_CONSOLE_BY_MODEL[model]
     * (server/src/consoles.ts) for the model placed on the bay.
     */
    consoles?: Record<string, ConsoleSpec>;
  };
  /** Bridge to the TabletAutoTest repo (list + launch automation workflows) */
  automation?: {
    /** Checkout path, absolute or relative to the TwinView root (default ../TabletAutoTest) */
    repo?: string;
    /** Python used for tools/headless_runner.py (default: the repo's .venv, else "python") */
    python?: string;
  };
}

const config: AppConfig = existsSync(CONFIG_PATH)
  ? { source: 'mock', port: 8720, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) }
  : { source: 'mock', port: 8720 };

mkdirSync(MODELS_DIR, { recursive: true });

// --- Real-hardware bays: serial/net configs make specific bay ids real.
// Legacy serial config → bay u01 treadmill on a COM port; the net config
// declares real units by id, each aggregating one or more Pi TCP endpoints.
// Sources are built per placement (they can't restart after stop()). ---
const realBays = new Map<string, RealBaySpec>();
if (config.source === 'serial' && config.serialConfigPath) {
  const serialCfg = loadSerialConfig(resolve(ROOT, config.serialConfigPath));
  realBays.set('u01', {
    kind: 'treadmill',
    sourceKind: 'serial',
    makeSource: (): TelemetrySource => new SerialSource(serialCfg),
    // non-null entries are the instrumented channels; the twin tracks only those
    channels: Object.entries(serialCfg)
      .filter(([, spec]) => spec)
      .map(([channel]) => channel as ChannelId),
  });
}
if (config.netConfigPath) {
  const netCfg = loadNetConfig(resolve(ROOT, config.netConfigPath));
  for (const [unitId, spec] of Object.entries(netCfg)) {
    if (realBays.has(unitId)) {
      console.warn(`[config] unit ${unitId} is defined by both serial and net config — using net`);
    }
    const channels = new Set<ChannelId>();
    for (const ep of spec.endpoints) {
      for (const channel of Object.keys(ep.channels)) channels.add(channel as ChannelId);
    }
    realBays.set(unitId, {
      kind: spec.kind,
      sourceKind: 'net',
      makeSource: (): TelemetrySource => new NetSource(spec.endpoints),
      channels: [...channels],
    });
  }
}
// Bridge to the TabletAutoTest repo: real bays can launch its automation
// workflows on their assigned tablet console straight from Test Control.
const automation = new AutomationBridge(
  config.automation,
  ROOT,
  join(ROOT, 'automation-logs'),
  `http://127.0.0.1:${config.port}`,
);

// --- FP2 consoles (the Renode emulators, or a BLE console found by the device
// code shown on it) via the TabletAutoTest FP2 gateway. Binding per bay, first
// hit wins:
//   1. bay.console in the lab layout (floor editor): BLE by device code, or
//      "emulator" = the emulator for the model placed on the bay;
//   2. config fleet.consoles[unitId]: a gateway link name ("dfab") or { link, lcd };
//   3. DEFAULT_CONSOLE_BY_MODEL[bay.machine.model] (server/src/consoles.ts) — an
//      NTL17624 dropped on any bay talks to the IF20 emulator and shows its LCD.
// A console makes its bay real (source kind 'fp2', incline channel only) unless
// serial/net already own the bay — then it attaches commander-only: setpoints
// out, events in, no channels. Like every real source it is built per placement
// (Fleet.addUnit -> makeSource); `consoles` tracks the live instance for status
// decoration + the LCD proxy. ---
const FP2_GATEWAY = config.fp2Gateway ?? 'http://127.0.0.1:8102';
/** Advertised BLE name = this prefix + the device code (iFIT_Tread_1CSF) */
const BLE_NAME_PREFIX = config.fp2BleNamePrefix ?? 'iFIT_Tread_';
interface ConsoleEntry extends ConsoleBinding {
  /** Current instance; undefined until the bay has a machine placed */
  con?: Fp2Console;
  /** Gateway catalog entry for a BLE console (device_name drives Pair); null for catalog links */
  catalog?: Record<string, unknown> | null;
  /**
   * The model's emulator acting as DESK console for a real (BLE) panel we cannot render:
   * its LCD shows on the unit and its membrane keys drive the machine through the twin.
   */
  desk?: { link: string; lcd?: string; con?: Fp2Console };
}
const consoles = new Map<string, ConsoleEntry>();
/** The serial/net bays as configured; `realBays` is rebuilt from these on every layout commit. */
const sensorBays = new Map(realBays);
const sensorKinds = new Map([...sensorBays].map(([id, r]) => [id, r.kind] as const));
const commanderWarned = new Set<string>();
let realBaysWire: LabRealBays = {};

/**
 * Gateway link for a bay (see the precedence above). Emulator links are in the
 * gateway's static catalog and carry their Renode panel URL; a BLE console is
 * registered at connect time by device code (PUT /v1/links/<name>, same
 * timeouts as the catalog's desk console).
 */
function bindingFor(bay: LabBay): (ConsoleBinding & { catalog: Record<string, unknown> | null }) | undefined {
  const c = bay.console;
  if (c?.kind === 'ble') {
    return {
      link: `ble-${c.code.toLowerCase()}`,
      catalog: {
        transport: 'ble',
        device_name: `${BLE_NAME_PREFIX}${c.code}`,
        setup_timeout_s: 45,
        connect_timeout_s: 60,
      },
    };
  }
  const model = bay.machine?.model ?? '';
  if (c?.kind === 'emulator') {
    // the editor's "emulator" = the emulator for the placed model; PM210 when the model has none
    const link = DEFAULT_CONSOLE_BY_MODEL[model] ?? 'pm210';
    return { link, lcd: LCD_BY_LINK[link], catalog: null };
  }
  if (!bay.machine) return undefined;
  const bound = resolveConsole(bay.id, model, config.fleet?.consoles);
  return bound && { ...bound, catalog: null };
}

/** Rebuild realBays + the console map from the layout's bindings; Fleet.applyLayout then reconciles units. */
function syncConsoles(next: LabLayout): void {
  realBays.clear();
  for (const [id, spec] of sensorBays) realBays.set(id, { ...spec });
  const prev = new Map(consoles);
  consoles.clear();
  // A console takes ONE master: two bays resolving to the same link (two NTL17624s on the
  // floor) would fight over it. Bays with an explicit binding (bay.console in the layout,
  // including the desk emulator a BLE bay borrows) claim their links first, then model
  // defaults in floor order; the rest get no console.
  const linkOwners = new Map<string, string>();
  const claim = (link: string, unitId: string, what: string): boolean => {
    const owner = linkOwners.get(link);
    if (owner && owner !== unitId) {
      console.warn(`[lab] ${unitId}: ${what} '${link}' is already bound to ${owner} — ${unitId} gets none`);
      return false;
    }
    linkOwners.set(link, unitId);
    return true;
  };
  const bays = baysInOrder(next);
  for (const bay of [...bays.filter((b) => b.console), ...bays.filter((b) => !b.console)]) {
    const bound = bindingFor(bay);
    if (!bound) continue;
    const unitId = bay.id;
    if (!claim(bound.link, unitId, 'console')) continue;
    const { link, catalog } = bound;
    let lcd = bound.lcd;
    // A real (BLE) console has no panel we can render, so the model's emulator becomes the
    // bay's DESK console: LCD on the unit, membrane keys driving this machine via the twin.
    let desk: ConsoleEntry['desk'];
    const deskLink = bay.console?.kind === 'ble' ? DEFAULT_CONSOLE_BY_MODEL[bay.machine?.model ?? ''] : undefined;
    if (deskLink && claim(deskLink, unitId, 'desk console')) {
      desk = { link: deskLink, lcd: LCD_BY_LINK[deskLink] };
      lcd = desk.lcd;
    }
    // Same links as before = Fleet keeps the unit (specChanged is false) and the running
    // instances must survive the rebuild of this map.
    const kept = prev.get(unitId);
    const keep = kept?.link === link && (kept?.desk?.link ?? null) === (desk?.link ?? null);
    const entry: ConsoleEntry = {
      link,
      lcd,
      catalog,
      con: keep ? kept?.con : undefined,
      desk: desk && { ...desk, con: keep ? kept?.desk?.con : undefined },
    };
    consoles.set(unitId, entry);
    // closures over the later consts: only invoked from start(), after construction
    const engineOf = () => fleet.get(unitId)!.engine;
    const automationOn = () => automation.status(unitId)?.status === 'running';
    /** The bay's console(s): the machine panel, plus the desk emulator paired with it. */
    const makeConsoles = (): Fp2Console[] => {
      entry.con = new Fp2Console(unitId, link, FP2_GATEWAY, desk ? undefined : lcd, engineOf, automationOn, catalog);
      const made = [entry.con];
      if (entry.desk) {
        entry.desk.con = new Fp2Console(
          unitId,
          entry.desk.link,
          FP2_GATEWAY,
          entry.desk.lcd,
          engineOf,
          automationOn,
          null,
          'desk',
        );
        entry.con.setPeer(entry.desk.con);
        entry.desk.con.setPeer(entry.con);
        made.push(entry.desk.con);
      }
      return made;
    };
    const ble = catalog?.device_name;
    const consoleInfo = {
      link,
      lcd: !!lcd,
      ...(typeof ble === 'string' ? { ble } : {}),
      ...(desk ? { desk: desk.link } : {}),
    };
    const owned = realBays.get(unitId);
    if (owned) {
      if (!commanderWarned.has(unitId)) {
        commanderWarned.add(unitId);
        console.warn(
          `[lab] ${unitId} already has ${owned.sourceKind} telemetry — console '${link}' attaches commander-only (setpoints out, events in, no channels)`,
        );
      }
      // Commander-only: ride along with the bay's sensor source so the console(s)
      // start/stop with each placement; latest() stays the sensor's alone.
      const makeInner = owned.makeSource;
      owned.makeSource = (): TelemetrySource => {
        const inner = makeInner();
        const cons = makeConsoles();
        return {
          kind: inner.kind,
          start: async () => {
            await inner.start();
            for (const c of cons) await c.start();
          },
          stop: async () => {
            for (const c of cons) await c.stop();
            await inner.stop();
          },
          latest: (ch) => inner.latest(ch),
        };
      };
      owned.console = consoleInfo;
    } else {
      realBays.set(unitId, {
        kind: bay.machine?.kind ?? 'treadmill', // the bay's own kind: Fleet.applyLayout compares kinds to decide rebuilds
        sourceKind: 'fp2',
        makeSource: (): TelemetrySource => {
          const cons = makeConsoles();
          const [machine] = cons;
          if (cons.length === 1) return machine;
          return {
            kind: 'fp2',
            start: async () => {
              for (const c of cons) await c.start();
            },
            stop: async () => {
              for (const c of cons) await c.stop();
            },
            latest: (ch) => machine.latest(ch),
          };
        },
        channels: ['incline'], // never belt_speed: see fp2.ts
        console: consoleInfo,
      });
    }
  }
  realBaysWire = Object.fromEntries(
    [...realBays].map(([id, r]) => [id, { kind: r.kind, source: r.sourceKind }]),
  );
}

const fleet = new Fleet({
  channels: config.fleet?.channels as Record<string, ChannelId[]> | undefined,
  autorun: config.fleet?.autorun ?? true,
  seedFaults: config.fleet?.seedFaults ?? true,
  real: realBays,
  // real bays' unattended-motion watchdog asks the bridge who's in charge
  automationRunning: (unitId) => automation.status(unitId)?.status === 'running',
});

// --- The lab floor: lab.json when it exists, else the classic config grid
// (same bay count and kind spread the fixed fleet used to build) ---
const labStore = new LabStore(LAB_PATH, LAYOUTS_DIR);
const seedFromConfig = (): LabLayout =>
  seedLayout({
    size: Math.max(1, config.fleet?.size ?? 12),
    // the mixed floor: rower + elliptical + pilates bays spread among the treadmills
    rowers: config.fleet?.rowers ?? 2,
    ellipticals: config.fleet?.ellipticals ?? 2,
    pilates: config.fleet?.pilates ?? 2,
    models: config.fleet?.models,
    realKinds: sensorKinds,
    consoles: config.fleet?.consoles,
  });
let layout: LabLayout;
{
  const live = labStore.loadLive();
  const norm = live ? normalizeLayout(live, sensorKinds) : null;
  if (norm && 'layout' in norm) {
    layout = norm.layout;
  } else {
    if (norm) console.warn(`[lab] lab.json rejected (${norm.error}) — reseeding from config`);
    layout = seedFromConfig();
    labStore.saveLive(layout);
    console.log(`[lab] seeded ${LAB_PATH} from config.json (${layout.rows.length} rows)`);
  }
}
syncConsoles(layout);
fleet.applyLayout(layout);
for (const u of fleet.units()) {
  if (u.console) console.log(`[fp2] ${u.id} (${u.model}) -> ${u.console.link}${u.console.lcd ? ' + LCD' : ''}`);
}

/** Install a validated layout: reconcile the roster, persist, tell every client. */
function commitLayout(next: LabLayout): void {
  layout = next;
  syncConsoles(layout); // console bindings live in the layout; the fleet rebuilds rebound bays
  fleet.applyLayout(layout); // broadcasts `fleet` itself when the roster changed
  labStore.saveLive(layout);
  broadcast({ type: 'lab', layout, real: realBaysWire });
  void assignScreens(lastDevices); // new bays pick up spare tablets
}

/** The 10 Hz states batch with each console bay's live FP2 status decorated in. */
/** The bay's console status with the desk console's link health folded in; undefined = no live console. */
function consoleStatusFor(id: string) {
  const entry = consoles.get(id);
  if (!entry?.con) return undefined;
  const deskCon = entry.desk?.con;
  return deskCon ? { ...entry.con.status(), deskLink: deskCon.status().link } : entry.con.status();
}

function statesWithConsole() {
  const states = fleet.statesSnapshot();
  for (const id of consoles.keys()) {
    const status = consoleStatusFor(id);
    if (status && states[id]) states[id].console = status;
  }
  return states;
}

// --- Model catalog: legacy current.glb (treadmill) + any <MODEL>.glb dropped
// into models/ by the CAD pipeline (manifest may land before/after the GLB) ---
const LEGACY_GLB = 'current.glb';
const LEGACY_MANIFEST = 'parts-manifest.json';
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // ids become filenames — keep them tame

interface ModelEntry {
  model: string;
  /** Machine kind: manifest `kind` when present, else inferred from the SKU */
  kind: MachineKind;
  glbUrl: string | null;
  manifestUrl: string | null;
  default: boolean;
}

/** A manifest may pin the machine kind; the SKU prefix is the fallback. */
function modelKind(id: string, manifestPath: string): MachineKind {
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (MACHINE_KINDS.includes(m.kind)) return m.kind as MachineKind;
    } catch {
      /* fall through */
    }
  }
  return kindForModel(id);
}

/** The legacy/default model id — read from parts-manifest.json when it exists. */
function defaultModelId(): string {
  const p = join(MODELS_DIR, LEGACY_MANIFEST);
  if (existsSync(p)) {
    try {
      const m = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof m.model === 'string' && m.model) return m.model;
    } catch {
      /* fall through to the fleet default */
    }
  }
  return 'NTL99925';
}

function modelEntry(id: string): ModelEntry {
  if (id === defaultModelId()) {
    return {
      model: id,
      kind: modelKind(id, join(MODELS_DIR, LEGACY_MANIFEST)),
      glbUrl: existsSync(join(MODELS_DIR, LEGACY_GLB)) ? `/models/${LEGACY_GLB}` : null,
      manifestUrl: existsSync(join(MODELS_DIR, LEGACY_MANIFEST)) ? `/models/${LEGACY_MANIFEST}` : null,
      default: true,
    };
  }
  return {
    model: id,
    kind: modelKind(id, join(MODELS_DIR, `${id}.manifest.json`)),
    glbUrl: existsSync(join(MODELS_DIR, `${id}.glb`)) ? `/models/${id}.glb` : null,
    manifestUrl: existsSync(join(MODELS_DIR, `${id}.manifest.json`))
      ? `/models/${id}.manifest.json`
      : null,
    default: false,
  };
}

/** Scan models/ for available machine models: *.glb (not *-raw.glb) ∪ *.manifest.json. */
function listModels(): ModelEntry[] {
  const seen = new Set<string>([defaultModelId()]);
  for (const f of readdirSync(MODELS_DIR)) {
    let id: string | null = null;
    if (f.endsWith('.glb') && !f.endsWith('-raw.glb') && f !== LEGACY_GLB) id = f.slice(0, -4);
    else if (f.endsWith('.manifest.json')) id = f.slice(0, -'.manifest.json'.length);
    if (id && MODEL_ID_RE.test(id)) seen.add(id);
  }
  return [...seen]
    .map(modelEntry)
    .sort((a, b) => (a.default !== b.default ? (a.default ? -1 : 1) : a.model.localeCompare(b.model)));
}

// --- Rig persistence (per model type, shared by every unit of the fleet).
// Legacy rig.json is the default model's rig; others live in rig.<MODEL>.json ---
function rigPathFor(model?: string): string {
  if (!model || model === defaultModelId()) return RIG_PATH;
  return join(MODELS_DIR, `rig.${model}.json`);
}

function loadRig(model?: string): RigConfig {
  const path = rigPathFor(model);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  return { model: model ?? defaultModelId(), bindings: [] };
}

const app = Fastify({ logger: { level: 'warn' } });

await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: MODELS_DIR, prefix: '/models/' });

// Serve built frontend in production (web/dist); dev uses the Vite server.
const webDist = join(ROOT, 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
}

app.get('/api/health', async () => ({ ok: true, units: fleet.units().length }));

app.get('/api/units', async () => fleet.units());

app.get('/api/scenarios', async () =>
  SCENARIOS.map(({ id, label, description, durationS, kind }) => ({ id, label, description, durationS, kind })),
);

app.get<{ Params: { id: string } }>('/api/units/:id/state', async (req, reply) => {
  const u = fleet.get(req.params.id);
  if (!u) return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
  const status = consoleStatusFor(req.params.id);
  return status ? { ...u.engine.getState(), console: status } : u.engine.getState();
});

// Bond this PC with the bay's BLE console (Windows "Just Works" pairing, done by the
// gateway which owns the host's BLE). An unbonded host gets a GATT connection but no
// FP2 replies, so a console pairs once per host; the link then opens on its own retry.
app.post<{ Params: { id: string } }>('/api/units/:id/console/pair', async (req, reply) => {
  const id = req.params.id;
  const u = fleet.get(id);
  if (!u) return reply.code(404).send({ error: `unknown unit: ${id}` });
  const entry = consoles.get(id);
  const device = entry?.catalog?.device_name;
  if (!entry || typeof device !== 'string') {
    return reply.code(409).send({ error: 'this bay has no BLE console to pair' });
  }
  u.engine.logEvent('system', 'info', `Pairing this PC with ${device} (Just Works)…`);
  try {
    const r = await fetch(`${FP2_GATEWAY}/v1/ble/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_name: device, link: entry.link, timeout_s: 20 }),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; detail?: string; address?: string };
    if (!r.ok || !body.ok) {
      const msg = body.detail ?? `HTTP ${r.status}`;
      u.engine.logEvent('system', 'warn', `Pairing with ${device} failed: ${msg}`);
      return reply.code(502).send({ error: msg });
    }
    u.engine.logEvent('system', 'info', `Paired with ${device} (${body.address ?? '?'}) — the FP2 link reconnects on its own`);
    return { ok: true, device, address: body.address ?? null };
  } catch (e) {
    const msg = `FP2 gateway unreachable: ${String((e as Error).message ?? e)}`;
    u.engine.logEvent('system', 'warn', msg);
    return reply.code(502).send({ error: msg });
  }
});

app.post<{ Params: { id: string }; Body: { id: string } }>(
  '/api/units/:id/scenario/start',
  async (req, reply) => {
    if (!fleet.get(req.params.id)) return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
    const ok = fleet.startScenario(req.params.id, req.body?.id);
    if (!ok) return reply.code(404).send({ error: `unknown scenario: ${req.body?.id}` });
    return { ok: true };
  },
);

app.post<{ Params: { id: string } }>('/api/units/:id/scenario/stop', async (req, reply) => {
  if (!fleet.stopScenario(req.params.id)) {
    return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
  }
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { speed?: number; incline?: number } }>(
  '/api/units/:id/setpoints',
  async (req, reply) => {
    if (!fleet.setSetpoints(req.params.id, req.body ?? {})) {
      return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
    }
    return { ok: true };
  },
);

app.post<{ Params: { id: string }; Body: { fault: FaultId; active: boolean } }>(
  '/api/units/:id/faults',
  async (req, reply) => {
    const { fault, active } = req.body ?? {};
    if (!FAULT_IDS.includes(fault)) return reply.code(400).send({ error: `unknown fault: ${fault}` });
    const res = fleet.setFault(req.params.id, fault, !!active);
    if (res === 'no-unit') return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
    if (res === 'not-mock') {
      return reply.code(409).send({ error: 'fault injection only available on mock units' });
    }
    if (res === 'wrong-kind') {
      return reply.code(409).send({ error: `fault ${fault} does not apply to this machine kind` });
    }
    return { ok: true };
  },
);

app.post<{ Params: { id: string }; Body: { active: boolean } }>(
  '/api/units/:id/auto',
  async (req, reply) => {
    if (!fleet.setAuto(req.params.id, !!req.body?.active)) {
      return reply.code(404).send({ error: `unknown unit or not autorunnable: ${req.params.id}` });
    }
    return { ok: true };
  },
);

// --- TabletAutoTest automation: catalog + per-unit launch/status ---

app.get('/api/automation/workflows', async (_req, reply) => {
  if (!automation.available()) {
    return reply.code(503).send({
      error: 'TabletAutoTest repo not found — set "automation.repo" in config.json',
    });
  }
  try {
    return await automation.listWorkflows();
  } catch (err) {
    return reply.code(502).send({ error: `workflow listing failed: ${err}` });
  }
});

app.get<{ Params: { id: string } }>('/api/units/:id/automation', async (req, reply) => {
  const u = fleet.get(req.params.id);
  if (!u) return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
  return {
    available: automation.available(),
    serial: u.info.screenSerial ?? null,
    /** FP2 gateway link of the bay's console — device-less console workflows run against it */
    console: consoles.get(req.params.id)?.link ?? null,
    run: automation.status(req.params.id),
  };
});

app.post<{ Params: { id: string }; Body: { workflowId: string } }>(
  '/api/units/:id/automation/run',
  async (req, reply) => {
    const u = fleet.get(req.params.id);
    if (!u) return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
    if (!automation.available()) {
      return reply.code(503).send({ error: 'TabletAutoTest repo not found' });
    }
    if (u.info.source === 'mock') {
      return reply.code(409).send({ error: 'automation workflows target real hardware bays only' });
    }
    // Console-bound bays also run the device-less FP2 workflows (test.ble_console_*): those go
    // out with serial `host` even when the bay has a tablet, and command the console through
    // the gateway link TwinView already holds.
    const workflowId = req.body?.workflowId ?? '';
    const consoleEntry = consoles.get(req.params.id);
    const deviceless = consoleEntry && /^test\.ble_console_/.test(workflowId);
    const serial = deviceless ? 'host' : (u.info.screenSerial ?? (consoleEntry ? 'host' : undefined));
    if (!serial) {
      return reply.code(409).send({ error: 'no tablet console or FP2 console on this bay' });
    }
    // An international machine (bay.units = kph) tells every run from this bay to work in the unit
    // its console/tablet displays: the FP2 matrix steps in whole km/h; tablet workflows can read
    // TREADMILL_SPEED_UNIT the same way.
    const units = baysInOrder(layout).find((b) => b.id === req.params.id)?.units;
    const res = automation.run(req.params.id, workflowId, serial, {
      ...(consoleEntry ? { FP2_GATEWAY_URL: FP2_GATEWAY, FP2_GATEWAY_LINK: consoleEntry.link } : {}),
      ...(units ? { FP2_SPEED_UNIT: units, TREADMILL_SPEED_UNIT: units } : {}),
    });
    if ('error' in res) return reply.code(409).send(res);
    return res;
  },
);

app.get<{ Params: { id: string } }>('/api/units/:id/export.csv', async (req, reply) => {
  const u = fleet.get(req.params.id);
  if (!u) return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
  reply
    .header('content-type', 'text/csv')
    .header('content-disposition', `attachment; filename="twinview-${u.info.serial}.csv"`);
  return u.engine.exportCsv();
});

// --- Lab floor layout: rows of bays, edited live; occupied bays are the fleet ---

app.get('/api/lab', async () => ({ layout, real: realBaysWire }));

// Whole-layout replace: the web is the editor, the server reconciles the fleet.
app.put<{ Body: unknown }>('/api/lab', async (req, reply) => {
  const norm = normalizeLayout(req.body, sensorKinds);
  if ('error' in norm) return reply.code(400).send({ error: norm.error });
  commitLayout(norm.layout);
  return { layout, real: realBaysWire };
});

// Back to the config.json grid (also what a fresh install boots into).
app.post('/api/lab/reset', async () => {
  commitLayout(seedFromConfig());
  return { layout, real: realBaysWire };
});

app.get('/api/lab/layouts', async () => labStore.list());

app.put<{ Params: { name: string } }>('/api/lab/layouts/:name', async (req, reply) => {
  const name = req.params.name.trim();
  if (!LabStore.validName(name)) return reply.code(400).send({ error: 'invalid layout name' });
  labStore.save(name, layout);
  return { ok: true, layouts: labStore.list() };
});

app.post<{ Params: { name: string } }>('/api/lab/layouts/:name/load', async (req, reply) => {
  const name = req.params.name.trim();
  if (!LabStore.validName(name)) return reply.code(400).send({ error: 'invalid layout name' });
  const saved = labStore.load(name);
  if (!saved) return reply.code(404).send({ error: `no saved layout: ${name}` });
  const norm = normalizeLayout(saved, sensorKinds);
  if ('error' in norm) return reply.code(409).send({ error: `saved layout invalid: ${norm.error}` });
  commitLayout(norm.layout);
  return { layout, real: realBaysWire };
});

app.delete<{ Params: { name: string } }>('/api/lab/layouts/:name', async (req, reply) => {
  const name = req.params.name.trim();
  if (!LabStore.validName(name) || !labStore.delete(name)) {
    return reply.code(404).send({ error: `no saved layout: ${name}` });
  }
  return { ok: true, layouts: labStore.list() };
});

app.get<{ Querystring: { model?: string } }>('/api/rig', async (req, reply) => {
  const model = req.query.model;
  if (model !== undefined && !MODEL_ID_RE.test(model)) {
    return reply.code(400).send({ error: `invalid model: ${model}` });
  }
  return loadRig(model);
});

// The rig's own `model` field routes it to rig.<MODEL>.json (default → rig.json)
app.put<{ Body: RigConfig }>('/api/rig', async (req, reply) => {
  const rig = req.body;
  if (rig?.model && !MODEL_ID_RE.test(rig.model)) {
    return reply.code(400).send({ error: `invalid model: ${rig.model}` });
  }
  writeFileSync(rigPathFor(rig?.model), JSON.stringify(rig, null, 2));
  broadcast({ type: 'rig', rig });
  return { ok: true };
});

/**
 * Map units to tablet consoles: config pins first, then (unless disabled)
 * remaining connected devices fill unpinned bays in bay order. Re-run on every
 * device rescan so tablets plugged in later get a bay without a restart.
 */
let lastDevices: { serial: string }[] = [];
async function assignScreens(devices: { serial: string }[]): Promise<void> {
  lastDevices = devices;
  const pinned = config.fleet?.screens ?? {};
  const map = new Map<string, string>(Object.entries(pinned));
  if (config.fleet?.autoScreens ?? true) {
    const taken = new Set(map.values());
    // serial-sorted, so assignments are stable across rescans and restarts
    const free = devices
      .map((d) => d.serial)
      .filter((s) => !taken.has(s))
      .sort();
    for (const u of fleet.units()) {
      if (map.has(u.id)) continue;
      const serial = free.shift();
      if (!serial) break;
      map.set(u.id, serial);
    }
  }
  fleet.setScreens(map);
}

// Connected adb devices whose screens can be live-streamed to the console.
// Listing doubles as a rescan: bay assignments refresh from what's plugged in.
app.get('/api/screens', async () => {
  const devices = await listScreenDevices();
  await assignScreens(devices);
  return devices;
});

// Tap-through: forward a normalized screen position (u,v in [0,1], origin
// top-left) as a real tap on the device. w/h = the streamed frame's pixel
// dims, used to detect display rotation. Keyed on serial, not unit: the
// Console Screen dropdown can show any device, not just the bay's own.
app.post<{ Params: { serial: string }; Body: { u?: number; v?: number; w?: number; h?: number } }>(
  '/api/screens/:serial/tap',
  async (req, reply) => {
    if (!screensReady()) return reply.code(503).send({ error: 'adb not available on this host' });
    if (!SERIAL_RE.test(req.params.serial)) {
      return reply.code(400).send({ error: 'invalid device serial' });
    }
    const { u, v, w, h } = req.body ?? {};
    if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) {
      return reply.code(400).send({ error: 'u and v must be numbers in [0,1]' });
    }
    try {
      const frame = typeof w === 'number' && typeof h === 'number' ? { w, h } : undefined;
      const { x, y } = await tapDevice(req.params.serial, u, v, frame);
      return { ok: true, x, y };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      return reply.code(msg.includes('too many inputs') ? 409 : 502).send({ error: msg.slice(0, 200) });
    }
  },
);

// Swipe-through: forward a normalized drag (u1,v1)→(u2,v2) as a real swipe.
// durMs is the on-screen gesture's real duration so flicks stay flicks;
// the server clamps it to sane bounds. Same frame-rotation handling as tap.
app.post<{
  Params: { serial: string };
  Body: { u1?: number; v1?: number; u2?: number; v2?: number; durMs?: number; w?: number; h?: number };
}>('/api/screens/:serial/swipe', async (req, reply) => {
  if (!screensReady()) return reply.code(503).send({ error: 'adb not available on this host' });
  if (!SERIAL_RE.test(req.params.serial)) {
    return reply.code(400).send({ error: 'invalid device serial' });
  }
  const { u1, v1, u2, v2, durMs, w, h } = req.body ?? {};
  if (![u1, v1, u2, v2].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return reply.code(400).send({ error: 'u1/v1/u2/v2 must be numbers in [0,1]' });
  }
  try {
    const frame = typeof w === 'number' && typeof h === 'number' ? { w, h } : undefined;
    const res = await swipeDevice(
      req.params.serial,
      u1 as number,
      v1 as number,
      u2 as number,
      v2 as number,
      typeof durMs === 'number' ? durMs : NaN,
      frame,
    );
    return { ok: true, ...res };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    return reply.code(msg.includes('too many inputs') ? 409 : 502).send({ error: msg.slice(0, 200) });
  }
});

// Emulated LCD (Renode PM210 / IF17 / IF20) proxy for console bays with an `lcd` URL;
// keyed on unit id so the browser never picks the upstream host.
registerLcdRoutes(app, (id) => (fleet.get(id) ? consoles.get(id)?.lcd : null));

// Per-model CAD info; no ?model= (or the default id) = legacy current.glb behavior.
// A model whose files haven't landed yet returns nulls — the web falls back to the proxy.
app.get<{ Querystring: { model?: string } }>('/api/model-info', async (req, reply) => {
  const q = req.query.model;
  if (q !== undefined && !MODEL_ID_RE.test(q)) {
    return reply.code(400).send({ error: `invalid model: ${q}` });
  }
  const { model, glbUrl, manifestUrl } = modelEntry(q || defaultModelId());
  return { model, glbUrl, manifestUrl };
});

app.get('/api/models', async () => listModels());

// DEV-ONLY: accept a base64 PNG from the browser and write it to disk so the
// dev harness can inspect the rendered canvas. Remove before shipping.
app.post<{ Body: { dataUrl: string } }>('/api/_devshot', async (req) => {
  const b64 = (req.body?.dataUrl ?? '').replace(/^data:image\/\w+;base64,/, '');
  const path = join(ROOT, 'models', '_devshot.png');
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return { ok: true, bytes: b64.length };
});

// --- WebSocket: fleet roster + batched states + live event stream ---
const sockets = new Set<{ send(data: string): void }>();

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of sockets) {
    try {
      ws.send(data);
    } catch {
      /* dropped on close */
    }
  }
}

app.register(async (scoped) => {
  scoped.get('/ws/twin', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(
      JSON.stringify({
        type: 'fleet',
        units: fleet.units(),
        events: fleet.recentEvents(EVENT_BACKLOG),
      } satisfies ServerMessage),
    );
    socket.send(JSON.stringify({ type: 'lab', layout, real: realBaysWire } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: 'rig', rig: loadRig() } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: 'states', states: statesWithConsole() } satisfies ServerMessage));
    socket.on('close', () => sockets.delete(socket));
  });

  // Raw H.264 (Annex-B) from scrcpy-server on the device, one session per
  // viewer. ?profile=lab|unit picks a fixed server-side encoder preset.
  scoped.get<{ Params: { serial: string }; Querystring: { profile?: string } }>(
    '/ws/screen/:serial',
    { websocket: true },
    (socket, req) => {
    const profile = req.query.profile ?? 'unit';
    if (!isStreamProfile(profile)) {
      socket.close(1008, `unknown stream profile: ${profile}`.slice(0, 120));
      return;
    }
    const stream = new ScreenStream(req.params.serial, profile);
    socket.on('close', () => stream.stop());
    stream
      .start(
        (chunk) => socket.send(chunk),
        (reason) => socket.close(1011, reason.slice(0, 120)),
      )
      .catch((e: Error) => socket.close(1011, String(e.message).slice(0, 120)));
    },
  );
});

fleet.onEvent((event) => {
  // safety alarms also land in the server log — the web UI may not be open
  if (event.severity === 'alarm') {
    console.error(`[SAFETY] ${event.unitId}: ${event.msg}`);
  }
  broadcast({ type: 'event', event });
});
fleet.onFleetChange(() =>
  broadcast({ type: 'fleet', units: fleet.units(), events: [] }),
);

setInterval(() => {
  if (sockets.size > 0) broadcast({ type: 'states', states: statesWithConsole() });
}, STATES_TICK_MS);

await fleet.start();
if (await initScreens(config.scrcpyDir)) {
  await assignScreens(await listScreenDevices());
}

await app.listen({ port: config.port, host: '127.0.0.1' });
const bayCount = layout.rows.reduce((n, r) => n + r.bays.length, 0);
console.log(
  `TwinView server on http://127.0.0.1:${config.port} (${fleet.units().length} units in ${bayCount} bays, ${layout.rows.length} rows)`,
);
