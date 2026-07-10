import {
  CHANNEL_IDS,
  type ChannelId,
  type ChannelReading,
  type ChannelStatus,
  type FaultId,
  type TwinEvent,
  type TwinState,
} from '@twinview/shared';
import { stepDrive, motorCurrent, vibrationRms, type DriveState, type Setpoints } from './plant.js';
import { SCENARIOS, scenarioSetpoints, type Scenario } from './scenarios.js';
import type { TelemetrySource } from './sources/types.js';

const TICK_MS = 100; // 10 Hz state broadcast
const STALE_MS = 1500;
/** Deviation must persist this long before a status change (debounce) */
const DEBOUNCE_MS = 900;
const EVENT_BUFFER = 200;
const EVENTS_IN_STATE = 50;
/** History depth for CSV export: 10 min @ 10 Hz */
const HISTORY_MAX = 6000;

interface ChannelSpec {
  label: string;
  unit: string;
  warnTol: number;
  failTol: number;
  /** Expected value from the fault-free reference plant */
  expected(drive: DriveState): number;
}

const CHANNEL_SPECS: Record<ChannelId, ChannelSpec> = {
  belt_speed: {
    label: 'Belt speed',
    unit: 'mph',
    warnTol: 0.35,
    failTol: 0.8,
    expected: (d) => d.speed,
  },
  incline: {
    label: 'Incline',
    unit: '%',
    warnTol: 0.5,
    failTol: 1.5,
    expected: (d) => d.incline,
  },
  motor_current: {
    label: 'Motor current',
    unit: 'A',
    warnTol: 2.0,
    failTol: 4.5,
    expected: (d) => motorCurrent(d),
  },
  vibration: {
    label: 'Vibration',
    unit: 'g RMS',
    warnTol: 0.15,
    failTol: 0.35,
    expected: (d) => vibrationRms(d),
  },
};

interface HistoryRow {
  t: number;
  values: Record<ChannelId, { cmd: number; meas: number }>;
}

/**
 * The digital twin: runs the fault-free reference plant from the commanded
 * setpoints, compares measured telemetry against it, tracks deviation status
 * per channel, and logs QA events on transitions.
 */
export class TwinEngine {
  setpoints: Setpoints = { speed: 0, incline: 0 };

  private reference: DriveState = { speed: 0, incline: 0 };
  private scenario: Scenario | null = null;
  private scenarioStart = 0;
  private events: TwinEvent[] = [];
  private history: HistoryRow[] = [];
  private status: Record<ChannelId, ChannelStatus> = {
    belt_speed: 'ok', incline: 'ok', motor_current: 'ok', vibration: 'ok',
  };
  private pendingStatus: Partial<Record<ChannelId, { status: ChannelStatus; since: number }>> = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: TwinState) => void>();
  private lastTick = Date.now();

  constructor(
    private source: TelemetrySource,
    private getFaults: () => Record<FaultId, boolean>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.logEvent('system', 'info', `Twin engine started (source: ${this.source.kind})`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onState(fn: (s: TwinState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  startScenario(id: string): boolean {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) return false;
    this.scenario = s;
    this.scenarioStart = Date.now();
    this.logEvent('system', 'info', `Scenario started: ${s.label}`);
    return true;
  }

  stopScenario(): void {
    if (this.scenario) this.logEvent('system', 'info', `Scenario stopped: ${this.scenario.label}`);
    this.scenario = null;
    this.setpoints = { speed: 0, incline: 0 };
  }

  setSetpoints(sp: Partial<Setpoints>): void {
    if (sp.speed !== undefined) this.setpoints.speed = Math.max(0, Math.min(12, sp.speed));
    if (sp.incline !== undefined) this.setpoints.incline = Math.max(-3, Math.min(15, sp.incline));
  }

  logEvent(channel: ChannelId | 'system', severity: TwinEvent['severity'], msg: string): void {
    this.events.push({ t: Date.now(), channel, severity, msg });
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
  }

  exportCsv(): string {
    const header = ['t', ...CHANNEL_IDS.flatMap((c) => [`${c}_cmd`, `${c}_meas`])].join(',');
    const rows = this.history.map((r) =>
      [
        new Date(r.t).toISOString(),
        ...CHANNEL_IDS.flatMap((c) => [r.values[c].cmd.toFixed(3), r.values[c].meas.toFixed(3)]),
      ].join(','),
    );
    return [header, ...rows].join('\n');
  }

  getState(): TwinState {
    const now = Date.now();
    const channels = {} as Record<ChannelId, ChannelReading>;
    for (const id of CHANNEL_IDS) {
      const spec = CHANNEL_SPECS[id];
      const sample = this.source.latest(id);
      const stale = !sample || now - sample.t > STALE_MS;
      channels[id] = {
        cmd: spec.expected(this.reference),
        meas: sample?.value ?? 0,
        status: stale ? 'stale' : this.status[id],
        warnTol: spec.warnTol,
        failTol: spec.failTol,
        unit: spec.unit,
        label: spec.label,
      };
    }
    return {
      t: now,
      running: this.scenario !== null,
      scenario: this.scenario?.id ?? null,
      elapsed: this.scenario ? (now - this.scenarioStart) / 1000 : 0,
      setpoints: { ...this.setpoints },
      channels,
      faults: { ...this.getFaults() },
      events: this.events.slice(-EVENTS_IN_STATE),
    };
  }

  private tick(): void {
    const now = Date.now();
    const dtS = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    // Scenario playback drives setpoints
    if (this.scenario) {
      const elapsed = (now - this.scenarioStart) / 1000;
      if (elapsed >= this.scenario.durationS) {
        this.logEvent('system', 'info', `Scenario complete: ${this.scenario.label}`);
        this.scenario = null;
        this.setpoints = { speed: 0, incline: 0 };
      } else {
        this.setpoints = scenarioSetpoints(this.scenario, elapsed);
      }
    }

    // Advance the fault-free reference plant
    stepDrive(this.reference, this.setpoints, dtS);

    // Compare measured vs expected with debounce
    for (const id of CHANNEL_IDS) {
      const spec = CHANNEL_SPECS[id];
      const sample = this.source.latest(id);
      if (!sample || now - sample.t > STALE_MS) continue;
      const dev = Math.abs(sample.value - spec.expected(this.reference));
      const target: ChannelStatus = dev > spec.failTol ? 'fail' : dev > spec.warnTol ? 'warn' : 'ok';
      this.applyStatus(id, target, now, dev, spec);
    }

    // History for CSV export
    const values = {} as HistoryRow['values'];
    for (const id of CHANNEL_IDS) {
      values[id] = {
        cmd: CHANNEL_SPECS[id].expected(this.reference),
        meas: this.source.latest(id)?.value ?? NaN,
      };
    }
    this.history.push({ t: now, values });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);

    const state = this.getState();
    for (const fn of this.listeners) fn(state);
  }

  private applyStatus(id: ChannelId, target: ChannelStatus, now: number, dev: number, spec: ChannelSpec): void {
    if (target === this.status[id]) {
      delete this.pendingStatus[id];
      return;
    }
    const pending = this.pendingStatus[id];
    if (!pending || pending.status !== target) {
      this.pendingStatus[id] = { status: target, since: now };
      return;
    }
    if (now - pending.since >= DEBOUNCE_MS) {
      const prev = this.status[id];
      this.status[id] = target;
      delete this.pendingStatus[id];
      const sev: TwinEvent['severity'] = target === 'ok' ? 'info' : target === 'fail' ? 'fail' : 'warn';
      const msg =
        target === 'ok'
          ? `${spec.label} back within tolerance`
          : `${spec.label} deviation ${dev.toFixed(2)} ${spec.unit} (was ${prev}, tol ±${
              target === 'fail' ? spec.failTol : spec.warnTol
            })`;
      this.logEvent(id, sev, msg);
    }
  }
}
