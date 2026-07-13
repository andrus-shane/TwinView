import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  FAULT_IDS,
  type FaultId,
  type RigConfig,
  type ServerMessage,
} from '@twinview/shared';
import { MockSource } from './sources/mock.js';
import { SerialSource, loadSerialConfig } from './sources/serial.js';
import type { TelemetrySource } from './sources/types.js';
import { SCENARIOS } from './scenarios.js';
import { TwinEngine } from './twin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const MODELS_DIR = join(ROOT, 'models');
const RIG_PATH = join(MODELS_DIR, 'rig.json');
const CONFIG_PATH = join(ROOT, 'config.json');

interface AppConfig {
  source: 'mock' | 'serial';
  serialConfigPath?: string;
  port: number;
}

const config: AppConfig = existsSync(CONFIG_PATH)
  ? { source: 'mock', port: 8720, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) }
  : { source: 'mock', port: 8720 };

mkdirSync(MODELS_DIR, { recursive: true });

// --- Telemetry source (mock now; serial via config switch later) ---
let mock: MockSource | null = null;
let source: TelemetrySource;
if (config.source === 'serial' && config.serialConfigPath) {
  source = new SerialSource(loadSerialConfig(resolve(ROOT, config.serialConfigPath)));
} else {
  mock = new MockSource(() => engine.setpoints);
  source = mock;
}

const noFaults = Object.fromEntries(FAULT_IDS.map((f) => [f, false])) as Record<FaultId, boolean>;
const engine: TwinEngine = new TwinEngine(source, () => (mock ? mock.faults : noFaults));

// --- Rig persistence ---
function loadRig(): RigConfig {
  if (existsSync(RIG_PATH)) return JSON.parse(readFileSync(RIG_PATH, 'utf-8'));
  return { model: 'NTL99925', bindings: [] };
}

const app = Fastify({ logger: { level: 'warn' } });

await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: MODELS_DIR, prefix: '/models/' });

// Serve built frontend in production (web/dist); dev uses the Vite server.
const webDist = join(ROOT, 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
}

app.get('/api/health', async () => ({ ok: true, source: source.kind }));

app.get('/api/state', async () => engine.getState());

app.get('/api/scenarios', async () =>
  SCENARIOS.map(({ id, label, description, durationS }) => ({ id, label, description, durationS })),
);

app.post<{ Body: { id: string } }>('/api/scenario/start', async (req, reply) => {
  const ok = engine.startScenario(req.body?.id);
  if (!ok) return reply.code(404).send({ error: `unknown scenario: ${req.body?.id}` });
  return { ok: true };
});

app.post('/api/scenario/stop', async () => {
  engine.stopScenario();
  return { ok: true };
});

app.post<{ Body: { speed?: number; incline?: number } }>('/api/setpoints', async (req) => {
  engine.setSetpoints(req.body ?? {});
  return { ok: true, setpoints: engine.setpoints };
});

app.post<{ Body: { fault: FaultId; active: boolean } }>('/api/faults', async (req, reply) => {
  const { fault, active } = req.body ?? {};
  if (!mock) return reply.code(409).send({ error: 'fault injection only available with mock source' });
  if (!FAULT_IDS.includes(fault)) return reply.code(400).send({ error: `unknown fault: ${fault}` });
  mock.setFault(fault, !!active);
  engine.logEvent('system', 'info', `Fault ${active ? 'injected' : 'cleared'}: ${fault}`);
  return { ok: true };
});

app.get('/api/rig', async () => loadRig());

app.put<{ Body: RigConfig }>('/api/rig', async (req) => {
  const rig = req.body;
  writeFileSync(RIG_PATH, JSON.stringify(rig, null, 2));
  broadcast({ type: 'rig', rig });
  return { ok: true };
});

app.get('/api/model-info', async () => {
  const glb = join(MODELS_DIR, 'current.glb');
  const manifest = join(MODELS_DIR, 'parts-manifest.json');
  return {
    glbUrl: existsSync(glb) ? '/models/current.glb' : null,
    manifestUrl: existsSync(manifest) ? '/models/parts-manifest.json' : null,
  };
});

// DEV-ONLY: accept a base64 PNG from the browser and write it to disk so the
// dev harness can inspect the rendered canvas. Remove before shipping.
app.post<{ Body: { dataUrl: string } }>('/api/_devshot', async (req) => {
  const b64 = (req.body?.dataUrl ?? '').replace(/^data:image\/\w+;base64,/, '');
  const path = join(ROOT, 'models', '_devshot.png');
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return { ok: true, bytes: b64.length };
});

app.get('/api/export.csv', async (_req, reply) => {
  reply
    .header('content-type', 'text/csv')
    .header('content-disposition', 'attachment; filename="twinview-session.csv"');
  return engine.exportCsv();
});

// --- WebSocket: twin state push ---
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
    socket.send(JSON.stringify({ type: 'rig', rig: loadRig() } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: 'state', state: engine.getState() } satisfies ServerMessage));
    socket.on('close', () => sockets.delete(socket));
  });
});

engine.onState((state) => broadcast({ type: 'state', state }));

await source.start();
engine.start();

await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`TwinView server on http://127.0.0.1:${config.port} (source: ${source.kind})`);
