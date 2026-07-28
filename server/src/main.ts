import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  FAULT_IDS,
  type FaultId,
  type MachineKind,
  type RigConfig,
  type ServerMessage,
} from '@twinview/shared';
import { Fleet } from './fleet.js';
import { NetSource, loadNetConfig } from './sources/net.js';
import { SerialSource, loadSerialConfig } from './sources/serial.js';
import type { TelemetrySource } from './sources/types.js';
import { SCENARIOS } from './scenarios.js';
import { initScreens, isStreamProfile, listScreenDevices, ScreenStream } from './screens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const MODELS_DIR = join(ROOT, 'models');
const RIG_PATH = join(MODELS_DIR, 'rig.json');
const CONFIG_PATH = join(ROOT, 'config.json');

const STATES_TICK_MS = 100; // 10 Hz fleet state batch
const EVENT_BACKLOG = 120; // merged events sent to new WS clients

interface AppConfig {
  source: 'mock' | 'serial';
  serialConfigPath?: string;
  /** Path to the network-units config (Raspberry Pi TCP rigs); see network_sensors.json */
  netConfigPath?: string;
  port: number;
  scrcpyDir?: string;
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
  };
}

const config: AppConfig = existsSync(CONFIG_PATH)
  ? { source: 'mock', port: 8720, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) }
  : { source: 'mock', port: 8720 };

mkdirSync(MODELS_DIR, { recursive: true });

// --- The lab fleet: N mock units; serial/net configs make specific bays real.
// Legacy serial config → bay 1 (u01) treadmill on a COM port; the net config
// declares real units by id, each aggregating one or more Pi TCP endpoints. ---
const realSources = new Map<string, { kind: MachineKind; source: TelemetrySource }>();
if (config.source === 'serial' && config.serialConfigPath) {
  realSources.set('u01', {
    kind: 'treadmill',
    source: new SerialSource(loadSerialConfig(resolve(ROOT, config.serialConfigPath))),
  });
}
if (config.netConfigPath) {
  const netCfg = loadNetConfig(resolve(ROOT, config.netConfigPath));
  for (const [unitId, spec] of Object.entries(netCfg)) {
    if (realSources.has(unitId)) {
      console.warn(`[config] unit ${unitId} is defined by both serial and net config — using net`);
    }
    realSources.set(unitId, { kind: spec.kind, source: new NetSource(spec.endpoints) });
  }
}

const fleet = new Fleet({
  size: Math.max(1, config.fleet?.size ?? 12),
  model: 'NTL99925',
  // the mixed floor: rower + elliptical + pilates bays spread among the treadmills
  rowers: config.fleet?.rowers ?? 2,
  rowerModel: 'FMRW0826-1D30',
  ellipticals: config.fleet?.ellipticals ?? 2,
  ellipticalModel: 'NTEL71426',
  pilates: config.fleet?.pilates ?? 2,
  pilatesModel: 'NTPL99926-6FW0',
  autorun: config.fleet?.autorun ?? true,
  seedFaults: config.fleet?.seedFaults ?? true,
  realSources,
});

// --- Model catalog: legacy current.glb (treadmill) + any <MODEL>.glb dropped
// into models/ by the CAD pipeline (manifest may land before/after the GLB) ---
const LEGACY_GLB = 'current.glb';
const LEGACY_MANIFEST = 'parts-manifest.json';
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // ids become filenames — keep them tame

interface ModelEntry {
  model: string;
  glbUrl: string | null;
  manifestUrl: string | null;
  default: boolean;
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
      glbUrl: existsSync(join(MODELS_DIR, LEGACY_GLB)) ? `/models/${LEGACY_GLB}` : null,
      manifestUrl: existsSync(join(MODELS_DIR, LEGACY_MANIFEST)) ? `/models/${LEGACY_MANIFEST}` : null,
      default: true,
    };
  }
  return {
    model: id,
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

app.get<{ Params: { id: string } }>('/api/units/:id/export.csv', async (req, reply) => {
  const u = fleet.get(req.params.id);
  if (!u) return reply.code(404).send({ error: `unknown unit: ${req.params.id}` });
  reply
    .header('content-type', 'text/csv')
    .header('content-disposition', `attachment; filename="twinview-${u.info.serial}.csv"`);
  return u.engine.exportCsv();
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
async function assignScreens(devices: { serial: string }[]): Promise<void> {
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

fleet.onEvent((event) => broadcast({ type: 'event', event }));
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
console.log(`TwinView server on http://127.0.0.1:${config.port} (${fleet.units().length} units)`);
