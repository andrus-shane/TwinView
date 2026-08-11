import { readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import type { ChannelId, MachineKind } from '@twinview/shared';
import type { Sample, TelemetrySource } from './types.js';

/**
 * Network telemetry source — the same newline-delimited, regex-matched channel
 * lines as {@link SerialSource}, but read over TCP instead of a COM port. Built
 * for the Raspberry Pi rigs: each Pi runs a TCP server that streams rig-monitor
 * lines (`incline.pitch: 1.07`, `tach.mph: 11.13`); TwinView dials in as a
 * client and retries on drop.
 *
 * One unit may aggregate SEVERAL Pi endpoints (e.g. one Pi for the IMU, another
 * for the tachometer) into its channel set — each endpoint contributes the
 * channels it knows how to extract. Config shape (see `network_sensors.json`),
 * keyed by unit id:
 *
 *   { "u01": { "kind": "treadmill", "endpoints": [
 *       { "host": "testingraspberryzero2.local", "port": 5000,
 *         "channels": {
 *           "incline":    { "pattern": "^incline\\.grade: (-?\\d+(?:\\.\\d+)?)", "unit": "%" },
 *           "belt_speed": { "pattern": "^tach\\.mph: (-?\\d+(?:\\.\\d+)?)",     "unit": "mph" }
 *         } } ] } }
 *
 * Group 1 of `pattern` is the value; `scale` (default 1) multiplies it, and
 * `unit` labels what the channel receives AFTER scaling. The twin's incline
 * channel is percent grade, NOT degrees of pitch — consume `incline.grade`
 * (100·tan(pitch), emitted by the Pi firmware), not `incline.pitch`. Address
 * Pis by their mDNS `.local` name rather than a DHCP IP.
 */

export interface NetChannelSpec {
  pattern: string;
  scale?: number;
  unit?: string;
}

export interface NetEndpointSpec {
  host: string;
  port: number;
  /** channel id -> how to pull it out of a line arriving on this endpoint */
  channels: Partial<Record<ChannelId, NetChannelSpec>>;
}

/** One real unit: the machine kind that bay runs and the Pi endpoints feeding it. */
export interface NetUnitSpec {
  kind: MachineKind;
  endpoints: NetEndpointSpec[];
}

/** Network-units config, keyed by unit id (e.g. "u01"). */
export type NetConfig = Record<string, NetUnitSpec>;

const MACHINE_KINDS: MachineKind[] = ['treadmill', 'rower', 'elliptical', 'pilates'];
const RETRY_MS = 3000;
/** Drop a runaway stream that never sends a newline rather than buffer forever. */
const MAX_BUFFER = 64 * 1024;

export function loadNetConfig(path: string): NetConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, NetUnitSpec>;
  const cfg: NetConfig = {};
  for (const [unitId, spec] of Object.entries(raw)) {
    if (!spec || !MACHINE_KINDS.includes(spec.kind)) {
      throw new Error(`net config unit "${unitId}": "kind" must be one of ${MACHINE_KINDS.join(', ')}`);
    }
    if (!Array.isArray(spec.endpoints) || spec.endpoints.length === 0) {
      throw new Error(`net config unit "${unitId}": at least one endpoint is required`);
    }
    for (const ep of spec.endpoints) {
      if (!ep.host || !ep.port) {
        throw new Error(`net config unit "${unitId}": every endpoint needs "host" and "port"`);
      }
      if (!ep.channels || Object.keys(ep.channels).length === 0) {
        throw new Error(`net config unit "${unitId}" ${ep.host}:${ep.port}: at least one channel is required`);
      }
      for (const [channel, c] of Object.entries(ep.channels)) {
        if (!c || !c.pattern) {
          throw new Error(`net config unit "${unitId}" channel "${channel}": "pattern" is required`);
        }
      }
    }
    cfg[unitId] = spec;
  }
  return cfg;
}

interface Matcher {
  channel: ChannelId;
  re: RegExp;
  scale: number;
}

export class NetSource implements TelemetrySource {
  readonly kind = 'net' as const;

  private samples = new Map<ChannelId, Sample>();
  private sockets = new Set<Socket>();
  private stopped = false;

  constructor(private endpoints: NetEndpointSpec[]) {}

  async start(): Promise<void> {
    for (const ep of this.endpoints) this.connect(ep);
  }

  private connect(ep: NetEndpointSpec): void {
    if (this.stopped) return;
    const matchers: Matcher[] = [];
    for (const [channel, spec] of Object.entries(ep.channels)) {
      if (!spec) continue;
      matchers.push({ channel: channel as ChannelId, re: new RegExp(spec.pattern), scale: spec.scale ?? 1 });
    }
    const label = `${ep.host}:${ep.port}`;
    let buf = '';

    const socket = createConnection({ host: ep.host, port: ep.port });
    this.sockets.add(socket);
    socket.setEncoding('utf-8');

    const retry = () => {
      this.sockets.delete(socket);
      if (!this.stopped) setTimeout(() => this.connect(ep), RETRY_MS);
    };

    socket.on('connect', () => console.log(`[net] ${label} connected`));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      // Keep only the tail if a peer floods without newlines — bounds memory.
      if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.ingestLine(line, matchers);
      }
    });
    // 'error' always precedes 'close'; schedule the single retry from 'close'.
    socket.on('error', (err: Error) => {
      console.warn(`[net] ${label}: ${err.message} — retrying in ${RETRY_MS / 1000} s`);
    });
    socket.on('close', () => {
      if (!this.stopped) console.warn(`[net] ${label} closed — retrying in ${RETRY_MS / 1000} s`);
      retry();
    });
  }

  /** Feed one raw line through this endpoint's matchers; returns the channel it hit. */
  ingestLine(line: string, matchers: Matcher[]): ChannelId | null {
    for (const m of matchers) {
      const hit = m.re.exec(line);
      if (hit?.[1] !== undefined) {
        this.samples.set(m.channel, { t: Date.now(), value: parseFloat(hit[1]) * m.scale });
        return m.channel;
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  latest(channel: ChannelId): Sample | null {
    return this.samples.get(channel) ?? null;
  }
}
