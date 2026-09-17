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
 * Group 1 of `pattern` is the value; `scale` (default 1) multiplies it, `offset`
 * (default 0) is then added — the tare for a sensor whose mount reads a bias at
 * rest (the WT901 grade board sits ~+2.6 % on a flat deck) — and `unit` labels
 * what the channel receives AFTER both. The twin's incline
 * channel is percent grade, NOT degrees of pitch — consume `incline.grade`
 * (100·tan(pitch), emitted by the Pi firmware), not `incline.pitch`. Address
 * Pis by their mDNS `.local` name rather than a DHCP IP.
 *
 * Timestamps: the Pi firmware suffixes every line with the sample's own
 * CLOCK_MONOTONIC time (`tach.mph: 11.130 @123456789012345`, nanoseconds).
 * That suffix is stripped before the channel patterns run, so configs never
 * see it. The Pi clock has an arbitrary epoch and ~20 ppm drift, so each
 * endpoint gets a {@link PiClockSync} that maps it onto the host timeline;
 * the mapped time lands in `Sample.t` (use for interval/derivative math),
 * while `Sample.tHost` keeps the raw arrival Date.now() (staleness watchdogs
 * only). Lines from older firmware without the suffix fall back to t = tHost.
 */

export interface NetChannelSpec {
  pattern: string;
  scale?: number;
  /** Added after `scale`: the at-rest tare in channel units (e.g. -2.64 for a grade board reading +2.64 % flat) */
  offset?: number;
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
  offset: number;
}

/** Firmware source-timestamp suffix: " @<CLOCK_MONOTONIC ns>" at end of line. */
const TS_SUFFIX_RE = / @(\d+)$/;

/** Pi-time window the min-delay offset is tracked over. Long enough that a few
 * near-minimum-delay packets always land in it (Wi-Fi jitter is bursty, calm
 * gaps are seconds apart); short enough that the Pi's ~20 ppm clock drift
 * accumulates only ~2.4 ms across it, well under the jitter being filtered —
 * the sliding window IS the skew tracking, so no explicit skew fit is needed. */
const SYNC_WINDOW_MS = 120_000;
/** An offset jump beyond this means the clock relation itself changed (Pi
 * reboot resets CLOCK_MONOTONIC's epoch; host suffered an NTP step) — restart
 * the fit rather than trusting a window that spans two different epochs. */
const SYNC_RESET_MS = 10_000;

/**
 * Maps one Pi's CLOCK_MONOTONIC onto the host's Date.now() timeline.
 *
 * Every (t_pi, t_host) arrival pair overstates the offset by that packet's
 * transport delay — Wi-Fi retries, TCP queuing, and read coalescing (several
 * 10 ms samples sharing one arrival stamp) all push t_host late, never early.
 * The true offset is therefore best estimated by the MINIMUM of
 * t_host − t_pi over a sliding window: the least-delayed packet seen
 * recently. Mapped absolute times carry that packet's residual delay as a
 * small constant bias, but DIFFERENCES between mapped samples are exactly
 * Pi-clock differences, which is what derivative math needs. (The bench
 * Wi-Fi is isolated with no NTP path to the Pi; running chrony on the Pi
 * pointed at this host would be the ops-side alternative to this fit.)
 *
 * Implemented as a monotonic deque (front = window minimum), O(1) amortized.
 */
class PiClockSync {
  private deque: { tPi: number; delta: number }[] = [];
  private offset: number | null = null;

  /** Feed one arrival pair (both ms; tPi on the Pi clock, tHost = Date.now()). */
  update(tPi: number, tHost: number): void {
    const delta = tHost - tPi;
    if (this.offset !== null && Math.abs(delta - this.offset) > SYNC_RESET_MS) {
      this.deque.length = 0;
      this.offset = null;
    }
    while (this.deque.length > 0 && this.deque[0].tPi < tPi - SYNC_WINDOW_MS) this.deque.shift();
    while (this.deque.length > 0 && this.deque[this.deque.length - 1].delta >= delta) this.deque.pop();
    this.deque.push({ tPi, delta });
    this.offset = this.deque[0].delta;
  }

  /** Pi-clock ms → host-timeline Unix ms (identity + current offset estimate). */
  toHostMs(tPi: number): number {
    return tPi + (this.offset ?? 0);
  }
}

export class NetSource implements TelemetrySource {
  readonly kind = 'net' as const;

  private samples = new Map<ChannelId, Sample>();
  private sockets = new Set<Socket>();
  private stopped = false;
  /** One clock fit per Pi, persistent across reconnects (both clocks keep running). */
  private syncs = new Map<NetEndpointSpec, PiClockSync>();

  constructor(private endpoints: NetEndpointSpec[]) {}

  async start(): Promise<void> {
    for (const ep of this.endpoints) this.connect(ep);
  }

  private connect(ep: NetEndpointSpec): void {
    if (this.stopped) return;
    const matchers: Matcher[] = [];
    for (const [channel, spec] of Object.entries(ep.channels)) {
      if (!spec) continue;
      matchers.push({
        channel: channel as ChannelId,
        re: new RegExp(spec.pattern),
        scale: spec.scale ?? 1,
        offset: spec.offset ?? 0,
      });
    }
    const label = `${ep.host}:${ep.port}`;
    let sync = this.syncs.get(ep);
    if (!sync) {
      sync = new PiClockSync();
      this.syncs.set(ep, sync);
    }
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
        if (line) this.ingestLine(line, matchers, sync);
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
  ingestLine(line: string, matchers: Matcher[], sync?: PiClockSync): ChannelId | null {
    const tHost = Date.now();
    // Peel the firmware's " @<ns>" source-timestamp suffix off BEFORE the
    // channel patterns run — configs match the bare "channel: value" line
    // (and stay compatible with $-anchored patterns and old firmware).
    let t = tHost;
    const stamp = TS_SUFFIX_RE.exec(line);
    if (stamp) {
      line = line.slice(0, stamp.index);
      if (sync) {
        const tPiMs = Number(stamp[1]) / 1e6;
        sync.update(tPiMs, tHost);
        t = sync.toHostMs(tPiMs);
      }
    }
    for (const m of matchers) {
      const hit = m.re.exec(line);
      if (hit?.[1] !== undefined) {
        this.samples.set(m.channel, { t, tHost, value: parseFloat(hit[1]) * m.scale + m.offset });
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
