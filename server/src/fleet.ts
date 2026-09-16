import {
  FAULT_IDS,
  FAULT_LABELS,
  FAULTS_BY_KIND,
  type ChannelId,
  type FaultId,
  type MachineKind,
  type TwinState,
  type UnitEvent,
  type UnitInfo,
} from '@twinview/shared';
import { MockSource } from './sources/mock.js';
import type { TelemetrySource } from './sources/types.js';
import { scenariosForKind } from './scenarios.js';
import { TwinEngine } from './twin.js';

export interface FleetOptions {
  size: number;
  model: string;
  /** How many bays hold non-treadmill machines (spread through the floor) */
  rowers: number;
  rowerModel: string;
  ellipticals: number;
  ellipticalModel: string;
  pilates: number;
  pilatesModel: string;
  /** Per-bay CAD model override (unit id -> model id); wins over the kind default */
  models?: Record<string, string>;
  /**
   * Per-bay channel subset (unit id -> channel ids). The twin tracks ONLY these — same
   * mechanism real-hardware bays use, but for mock bays too (e.g. a treadmill twin that
   * should only show belt speed + incline). Unknown ids for the kind are ignored.
   */
  channels?: Record<string, ChannelId[]>;
  /** Idle units start scenarios on their own (staggered) until an operator takes over */
  autorun: boolean;
  /** Inject a couple of deterministic faults shortly after boot so the lab view has detections to show */
  seedFaults: boolean;
  /**
   * Real-hardware units keyed by unit id (e.g. "u01"): the machine kind that
   * bay runs, its telemetry source (serial or net), and which channels that
   * source is configured to feed (the twin tracks ONLY those — no mock
   * expected values for uninstrumented channels). These bays are exempt
   * from autorun and fault injection. Unit ids outside 1..size are ignored.
   */
  realSources?: Map<string, { kind: MachineKind; source: TelemetrySource; channels?: ChannelId[] }>;
  /**
   * Is a TabletAutoTest automation run currently active on this unit? Feeds the
   * real bays' unattended-motion safety watchdog (see TwinEngine.watchdogTick).
   */
  automationRunning?: (unitId: string) => boolean;
}

interface Unit {
  info: UnitInfo;
  source: TelemetrySource;
  mock: MockSource | null;
  engine: TwinEngine;
  /** Autorun: when to start the next scenario; 0 = not scheduled */
  nextRunAt: number;
}

const NO_FAULTS = Object.fromEntries(FAULT_IDS.map((f) => [f, false])) as Record<FaultId, boolean>;

/** Lab floor: N independently simulated units, each its own plant + twin engine. */
export class Fleet {
  private unitList: Unit[] = [];
  private byId = new Map<string, Unit>();
  private eventListeners = new Set<(e: UnitEvent) => void>();
  private fleetListeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];

  constructor(private opts: FleetOptions) {
    const real =
      opts.realSources ??
      new Map<string, { kind: MachineKind; source: TelemetrySource; channels?: ChannelId[] }>();
    // 0-based bay indices backed by real hardware — they keep their declared
    // kind and never get a mock plant, autorun, or seeded faults.
    const realIdx = new Set<number>();
    for (const id of real.keys()) {
      const bay = Number.parseInt(id.replace(/^u/, ''), 10);
      if (Number.isInteger(bay) && bay >= 1 && bay <= opts.size) realIdx.add(bay - 1);
    }

    // Non-treadmill mock bays spread evenly through the floor ("into the mix"),
    // never bay 1 and never a real-hardware bay.
    const kindAt = new Map<number, MachineKind>();
    const specials: MachineKind[] = [
      ...Array<MachineKind>(Math.max(0, opts.rowers)).fill('rower'),
      ...Array<MachineKind>(Math.max(0, opts.ellipticals)).fill('elliptical'),
      ...Array<MachineKind>(Math.max(0, opts.pilates)).fill('pilates'),
    ].slice(0, opts.size - 1);
    specials.forEach((kind, k) => {
      let idx = Math.floor(((k + 1) * opts.size) / (specials.length + 1));
      for (let guard = 0; (kindAt.has(idx) || idx === 0 || realIdx.has(idx)) && guard < opts.size; guard++) {
        idx = (idx + 1) % opts.size || 1;
      }
      if (!kindAt.has(idx) && idx !== 0 && !realIdx.has(idx)) kindAt.set(idx, kind);
    });

    const MODEL: Record<MachineKind, string> = {
      treadmill: opts.model,
      rower: opts.rowerModel,
      elliptical: opts.ellipticalModel,
      pilates: opts.pilatesModel,
    };
    const SERIAL_PREFIX: Record<MachineKind, string> = {
      treadmill: 'A1',
      rower: 'R2',
      elliptical: 'E3',
      pilates: 'P4',
    };

    for (let i = 0; i < opts.size; i++) {
      const bay = i + 1;
      const id = `u${String(bay).padStart(2, '0')}`;
      const realEntry = real.get(id);
      const kind: MachineKind = realEntry ? realEntry.kind : kindAt.get(i) ?? 'treadmill';
      const unit: Partial<Unit> = {
        info: {
          id,
          bay,
          label: `Bay ${String(bay).padStart(2, '0')}`,
          serial: `SN-${SERIAL_PREFIX[kind]}${String(bay).padStart(3, '0')}`,
          model: opts.models?.[id] ?? MODEL[kind],
          kind,
          source: realEntry ? realEntry.source.kind : 'mock',
          auto: opts.autorun && !realEntry,
        },
        nextRunAt: 0,
      };
      // The mock plant reads its own engine's setpoints — forward ref via closure
      const mock = realEntry ? null : new MockSource(() => unit.engine!.setpoints, kind);
      unit.mock = mock;
      unit.source = realEntry ? realEntry.source : mock!;
      unit.engine = new TwinEngine(
        unit.source,
        () => (mock ? mock.faults : NO_FAULTS),
        kind,
        opts.channels?.[id] ?? realEntry?.channels,
        realEntry ? () => opts.automationRunning?.(id) ?? false : undefined,
      );
      unit.engine.onEvent((e) => {
        for (const fn of this.eventListeners) fn({ ...e, unitId: id });
      });
      this.unitList.push(unit as Unit);
      this.byId.set(id, unit as Unit);
    }
  }

  async start(): Promise<void> {
    for (const u of this.unitList) {
      await u.source.start();
      u.engine.start();
      // stagger the first autorun starts so the floor spins up within seconds, not in lockstep
      if (u.info.auto) u.nextRunAt = Date.now() + (1 + Math.random() * 12) * 1000;
    }
    this.timers.push(setInterval(() => this.autorunTick(), 1000));
    if (this.opts.seedFaults) this.scheduleSeedFaults();
  }

  units(): UnitInfo[] {
    return this.unitList.map((u) => ({ ...u.info }));
  }

  get(id: string): { info: UnitInfo; engine: TwinEngine; mock: MockSource | null } | undefined {
    return this.byId.get(id);
  }

  /** 10 Hz batch payload: every unit's state with events stripped (they stream separately). */
  statesSnapshot(): Record<string, TwinState> {
    const out: Record<string, TwinState> = {};
    for (const u of this.unitList) out[u.info.id] = { ...u.engine.getState(), events: [] };
    return out;
  }

  /** Merged recent events across the fleet, oldest first — backlog for new WS clients. */
  recentEvents(n: number): UnitEvent[] {
    const all: UnitEvent[] = [];
    for (const u of this.unitList) {
      for (const e of u.engine.recentEvents(n)) all.push({ ...e, unitId: u.info.id });
    }
    all.sort((a, b) => a.t - b.t);
    return all.slice(-n);
  }

  onEvent(fn: (e: UnitEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Fires when the roster changes (auto flags) so clients can refresh the fleet message. */
  onFleetChange(fn: () => void): () => void {
    this.fleetListeners.add(fn);
    return () => this.fleetListeners.delete(fn);
  }

  // --- Operator controls (manual action pauses autorun for that unit) ---

  startScenario(id: string, scenarioId: string): boolean {
    const u = this.byId.get(id);
    if (!u) return false;
    this.takeOver(u);
    return u.engine.startScenario(scenarioId);
  }

  stopScenario(id: string): boolean {
    const u = this.byId.get(id);
    if (!u) return false;
    this.takeOver(u);
    u.engine.stopScenario();
    return true;
  }

  setSetpoints(id: string, sp: { speed?: number; incline?: number }): boolean {
    const u = this.byId.get(id);
    if (!u) return false;
    this.takeOver(u);
    u.engine.setSetpoints(sp);
    return true;
  }

  setFault(id: string, fault: FaultId, active: boolean): 'ok' | 'no-unit' | 'not-mock' | 'wrong-kind' {
    const u = this.byId.get(id);
    if (!u) return 'no-unit';
    if (!u.mock) return 'not-mock';
    if (!FAULTS_BY_KIND[u.info.kind].includes(fault)) return 'wrong-kind';
    u.mock.setFault(fault, active);
    u.engine.logEvent('system', 'info', `Fault ${active ? 'injected' : 'cleared'}: ${FAULT_LABELS[fault]}`);
    return 'ok';
  }

  /** Replace the unit → tablet-console assignment; broadcasts only on real change. */
  setScreens(map: Map<string, string>): void {
    let changed = false;
    for (const u of this.unitList) {
      const serial = map.get(u.info.id);
      if (u.info.screenSerial !== serial) {
        u.info.screenSerial = serial;
        changed = true;
      }
    }
    if (changed) this.notifyFleet();
  }

  setAuto(id: string, active: boolean): boolean {
    const u = this.byId.get(id);
    if (!u || (active && !u.mock)) return false;
    if (u.info.auto !== active) {
      u.info.auto = active;
      u.nextRunAt = 0;
      this.notifyFleet();
    }
    return true;
  }

  private takeOver(u: Unit): void {
    if (u.info.auto) {
      u.info.auto = false;
      u.nextRunAt = 0;
      this.notifyFleet();
    }
  }

  private notifyFleet(): void {
    for (const fn of this.fleetListeners) fn();
  }

  /** Idle auto units pick a random scenario after a staggered pause — the floor stays alive. */
  private autorunTick(): void {
    const now = Date.now();
    for (const u of this.unitList) {
      if (!u.info.auto || !u.mock) continue;
      if (u.engine.getState().running) {
        u.nextRunAt = 0;
        continue;
      }
      if (u.nextRunAt === 0) {
        u.nextRunAt = now + (8 + Math.random() * 25) * 1000;
      } else if (now >= u.nextRunAt) {
        const pool = scenariosForKind(u.info.kind);
        const s = pool[Math.floor(Math.random() * pool.length)];
        if (s) u.engine.startScenario(s.id);
        u.nextRunAt = 0;
      }
    }
  }

  /** A few deterministic faults early on: the lab view should light up without operator help. */
  private scheduleSeedFaults(): void {
    const seed = (idx: number, fault: FaultId, afterMs: number) => {
      const u = this.unitList[idx];
      if (!u || !u.mock || !FAULTS_BY_KIND[u.info.kind].includes(fault)) return;
      this.timers.push(setTimeout(() => this.setFault(u.info.id, fault, true), afterMs));
    };
    const firstOf = (kind: MachineKind, minIdx = 0): number =>
      this.unitList.findIndex((u, i) => i >= minIdx && u.info.kind === kind && !!u.mock);
    seed(firstOf('treadmill', 2), 'belt_slip', 8000);
    seed(firstOf('rower'), 'drive_belt_slip', 12000);
    seed(firstOf('elliptical'), 'bearing_knock', 20000);
    seed(firstOf('pilates'), 'carriage_drag', 24000);
    // last treadmill on the floor gets the vibration burst
    for (let i = this.unitList.length - 2; i >= 0; i--) {
      if (this.unitList[i].info.kind === 'treadmill') {
        seed(i, 'vibration_burst', 16000);
        break;
      }
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t as ReturnType<typeof setInterval>);
    this.timers = [];
    for (const u of this.unitList) {
      u.engine.stop();
      void u.source.stop();
    }
  }
}
