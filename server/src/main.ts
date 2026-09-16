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
  type LabLayout,
  type LabRealBays,
  type MachineKind,
  type RigConfig,
  type ServerMessage,
} from '@twinview/shared';
import { AutomationBridge } from './automation.js';
import { Fleet, type RealBaySpec } from './fleet.js';
import { LabStore, normalizeLayout, seedLayout } from './lab.js';
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
const CONFIG_PATH = join(ROOT, 'config.json');
/** The live lab floor (rows of bays); rewritten on every edit. Named snapshots go in layouts/. */
const LAB_PATH = join(ROOT, 'lab.json');
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
const realBaysWire: LabRealBays = Object.fromEntries(
  [...realBays].map(([id, r]) => [id, { kind: r.kind, source: r.sourceKind }]),
);

// Bridge to the TabletAutoTest repo: real bays can launch its automation
// workflows on their assigned tablet console straight from Test Control.
const automation = new AutomationBridge(
  config.automation,
  ROOT,
  join(ROOT, 'automation-logs'),
  `http://127.0.0.1:${config.port}`,
);

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
    realKinds: fleet.realKinds(),
  });
let layout: LabLayout;
{
  const live = labStore.loadLive();
  const norm = live ? normalizeLayout(live, fleet.realKinds()) : null;
  if (norm && 'layout' in norm) {
    layout = norm.layout;
  } else {
    if (norm) console.warn(`[lab] lab.json rejected (${norm.error}) — reseeding from config`);
    layout = seedFromConfig();
    labStore.saveLive(layout);
    console.log(`[lab] seeded ${LAB_PATH} from config.json (${layout.rows.length} rows)`);
  }
}
fleet.applyLayout(layout);

/** Install a validated layout: reconcile the roster, persist, tell every client. */
function commitLayout(next: LabLayout): void {
  layout = next;
  fleet.applyLayout(layout); // broadcasts `fleet` itself when the roster changed
  labStore.saveLive(layout);
  broadcast({ type: 'lab', layout, real: realBaysWire });
  void assignScreens(lastDevices); // new bays pick up spare tablets
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
  return u.engine.getState();
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
    const serial = u.info.screenSerial;
    if (!serial) {
      return reply.code(409).send({ error: 'no tablet console assigned to this bay' });
    }
    const res = automation.run(req.params.id, req.body?.workflowId ?? '', serial);
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
  const norm = normalizeLayout(req.body, fleet.realKinds());
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
  const norm = normalizeLayout(saved, fleet.realKinds());
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
    socket.send(JSON.stringify({ type: 'states', states: fleet.statesSnapshot() } satisfies ServerMessage));
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
  if (sockets.size > 0) broadcast({ type: 'states', states: fleet.statesSnapshot() });
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
