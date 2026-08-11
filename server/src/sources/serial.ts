import { readFileSync } from 'node:fs';
import { SerialPort, ReadlineParser } from 'serialport';
import type { ChannelId } from '@twinview/shared';
import type { Sample, TelemetrySource } from './types.js';

/**
 * USB serial sensor source — same architecture as TabletAutoTest's
 * `treadmill_sensors.py` and config-compatible with its
 * `config/treadmill_sensors.json`:
 *
 *   { "<channel>": { "port": "COM24", "baud": 115200,
 *                    "pattern": "Pitch:\\s*(-?\\d+(?:\\.\\d+)?)",
 *                    "scale": 1.0, "unit": "deg" } | null }
 *
 * Sensors stream newline-delimited text; group 1 of `pattern` is the value,
 * `scale` multiplies it into the channel's native unit, and `unit` labels the
 * post-scale value. The incline channel is percent grade, but the rig-monitor
 * sketch flashed on the bench Mega may only report WT901 pitch in degrees —
 * hence scale 1.7453293 (100·π/180, the small-angle tan() conversion, within
 * 0.11 grade-points of exact over -3..15 %) in `treadmill_sensors.json`.
 * Switch that channel to `^incline\.grade:` at scale 1 once the flashed sketch
 * is confirmed to emit it (the Pi firmware already does).
 * Multiple channels may share one physical port (e.g. one Arduino Mega
 * emitting both inclinometer and tachometer lines).
 *
 * Opening a port asserts DTR, which resets an Arduino — expect ~2 s of
 * silence after (re)connect before lines flow. Ports that fail to open or
 * that disappear (USB unplug) are retried every 3 s; affected channels
 * simply read stale until the device returns.
 */

export interface SerialChannelSpec {
  port: string;
  baud: number;
  pattern: string;
  scale?: number;
  unit?: string;
}

export type SerialConfig = Partial<Record<ChannelId, SerialChannelSpec | null>>;

export function loadSerialConfig(path: string): SerialConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, SerialChannelSpec | null>;
  const cfg: SerialConfig = {};
  for (const [channel, spec] of Object.entries(raw)) {
    if (spec && (!spec.port || !spec.pattern)) {
      throw new Error(`serial config channel "${channel}": port and pattern are required`);
    }
    cfg[channel as ChannelId] = spec;
  }
  return cfg;
}

export class SerialSource implements TelemetrySource {
  readonly kind = 'serial' as const;

  private samples = new Map<ChannelId, Sample>();
  private matchers = new Map<ChannelId, { re: RegExp; scale: number }>();
  private ports = new Map<string, SerialPort>();
  private stopped = false;

  constructor(private config: SerialConfig) {
    for (const [channel, spec] of Object.entries(config)) {
      if (!spec) continue;
      this.matchers.set(channel as ChannelId, {
        re: new RegExp(spec.pattern),
        scale: spec.scale ?? 1,
      });
    }
  }

  async start(): Promise<void> {
    if (this.matchers.size === 0) return;
    const bauds = new Map<string, number>();
    for (const [channel, spec] of Object.entries(this.config)) {
      if (!spec || !this.matchers.has(channel as ChannelId)) continue;
      const prev = bauds.get(spec.port);
      if (prev !== undefined && prev !== spec.baud) {
        throw new Error(`serial config: ${spec.port} listed at both ${prev} and ${spec.baud} baud`);
      }
      bauds.set(spec.port, spec.baud);
    }
    for (const [path, baudRate] of bauds) this.openPort(path, baudRate);
  }

  private openPort(path: string, baudRate: number): void {
    if (this.stopped) return;
    const retry = () => {
      this.ports.delete(path);
      if (!this.stopped) setTimeout(() => this.openPort(path, baudRate), 3000);
    };
    const port = new SerialPort({ path, baudRate }, (err) => {
      if (err) {
        console.warn(`[serial] ${path}: ${err.message} — retrying in 3 s`);
        retry();
        return;
      }
      console.log(`[serial] ${path} open @ ${baudRate}`);
    });
    this.ports.set(path, port);
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line: string) => this.ingestLine(line.trim()));
    port.on('error', (err) => console.warn(`[serial] ${path}: ${err.message}`));
    port.on('close', () => {
      if (!this.stopped) console.warn(`[serial] ${path} closed — retrying in 3 s`);
      retry();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.ports.values()].map(
        (p) => new Promise<void>((res) => (p.isOpen ? p.close(() => res()) : res())),
      ),
    );
    this.ports.clear();
  }

  /** Feed one raw line from a port; returns the channel it matched, if any. */
  ingestLine(line: string): ChannelId | null {
    for (const [channel, m] of this.matchers) {
      const hit = m.re.exec(line);
      if (hit?.[1] !== undefined) {
        this.samples.set(channel, { t: Date.now(), value: parseFloat(hit[1]) * m.scale });
        return channel;
      }
    }
    return null;
  }

  latest(channel: ChannelId): Sample | null {
    return this.samples.get(channel) ?? null;
  }
}
