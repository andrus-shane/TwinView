import { readFileSync } from 'node:fs';
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
 * Sensors stream newline-delimited text; group 1 of `pattern` is the value.
 * Multiple channels may share one physical port (e.g. one Arduino Mega
 * emitting both inclinometer and tachometer lines).
 *
 * STUB: parsing/config plumbing is real; the port I/O activates once the
 * `serialport` package is installed and real hardware is attached
 * (npm i serialport -w server, then wire openPort()).
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
    const active = [...this.matchers.keys()];
    if (active.length === 0) return;
    // TODO(hardware): open each unique COM port with `serialport` + ReadlineParser,
    // route lines through ingestLine(). Until then this source reports stale.
    console.warn(
      `[serial] configured channels [${active.join(', ')}] but serialport I/O is not wired yet — install hardware and the serialport package`,
    );
  }

  async stop(): Promise<void> {}

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
