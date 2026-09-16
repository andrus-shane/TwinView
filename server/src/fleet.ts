import {
  FAULT_IDS,
  FAULT_LABELS,
  FAULTS_BY_KIND,
  type ChannelId,
  type FaultId,
  type LabBay,
  type LabLayout,
  type MachineKind,
  type TwinState,
  type UnitEvent,
  type UnitInfo,
} from '@twinview/shared';
import { baysInOrder } from './lab.js';
import { MockSource } from './sources/mock.js';
import type { TelemetrySource } from './sources/types.js';
import { scenariosForKind } from './scenarios.js';
import { TwinEngine } from './twin.js';

/**
 * A real-hardware bay: the kind its sensor config declares, the channels that
 * config feeds (the twin tracks ONLY those), and a factory for the source —
 * sources can't restart after stop(), so re-placing a machine in a real bay
 * builds a fresh one.
 */
export interface RealBaySpec {
  kind: MachineKind;
  channels: ChannelId[];
  sourceKind: 'serial' | 'net';
  makeSource(): TelemetrySource;
}

export interface FleetOptions {
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
  /** Real-hardware bays keyed by bay/unit id (e.g. "u01"); exempt from autorun and fault injection. */
  real?: Map<string, RealBaySpec>;
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

const SERIAL_PREFIX: Record<MachineKind, string> = {
  treadmill: 'A1',
  rower: 'R2',
  elliptical: 'E3',
  pilates: 'P4',
};

/**
 * Lab floor: the occupied bays of the lab layout, each an independently
 * simulated (or real) unit with its own plant + twin engine. The roster is
 * driven by {@link applyLayout} — bays gain and lose machines at run time.
 */
export class Fleet {
  private unitList: Unit[] = [];
  private byId = new Map<string, Unit>();
  private eventListeners = new Set<(e: UnitEvent) => void>();
  private fleetListeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
  private started = false;

  constructor(private opts: FleetOptions) {}

  /** Real-hardware bay ids → declared kind (layout validation coerces to these). */
  realKinds(): Map<string, MachineKind> {
    return new Map([...(this.opts.real ?? [])].map(([id, spec]) => [id, spec.kind]));
  }

  /**
   * Make the roster match the layout's occupied bays: new machines are built,
   * emptied bays torn down, a kind change rebuilds the unit (new plant), and a
   * model/label/order change just updates the roster. Returns true if anything
   * about the roster changed.
   */
  applyLayout(layout: LabLayout): boolean {
    const bays = baysInOrder(layout);
    const wanted = new Map<string, { bay: LabBay; ordinal: number }>();
    bays.forEach((bay, i) => {
      if (bay.machine) wanted.set(bay.id, { bay, ordinal: i + 1 });
    });

    let changed = false;
    for (const u of [...this.unitList]) {
      const w = wanted.get(u.info.id);
      if (!w || w.bay.machine!.kind !== u.info.kind) {
        this.removeUnit(u.info.id, false);
        changed = true;
      }
    }
    for (const { bay, ordinal } of wanted.values()) {
      const u = this.byId.get(bay.id);
      if (!u) {
        this.addUnit(bay, ordinal);
        changed = true;
        continue;
      }
      const m = bay.machine!;
      if (u.info.model !== m.model || u.info.label !== bay.label || u.info.bay !== ordinal) {
        u.info.model = m.model;
        u.info.label = bay.label;
        u.info.bay = ordinal;
        changed = true;
      }
    }
    if (changed) {
      this.unitList.sort((a, b) => a.info.bay - b.info.bay);
      this.notifyFleet();
    }
    return changed;
  }

  private addUnit(bay: LabBay, ordinal: number): void {
    const id = bay.id;
    const real = this.opts.real?.get(id);
    const kind: MachineKind = real ? real.kind : bay.machine!.kind;
    const num = Number.parseInt(id.replace(/^\D+/, ''), 10);
    const unit: Partial<Unit> = {
      info: {
        id,
        bay: ordinal,
        label: bay.label,
        serial: `SN-${SERIAL_PREFIX[kind]}${String(Number.isInteger(num) ? num : ordinal).padStart(3, '0')}`,
        model: bay.machine!.model,
        kind,
        source: real ? real.sourceKind : 'mock',
        auto: this.opts.autorun && !real,
      },
      nextRunAt: 0,
    };
    // The mock plant reads its own engine's setpoints — forward ref via closure
    const mock = real ? null : new MockSource(() => unit.engine!.setpoints, kind);
    unit.mock = mock;
    unit.source = real ? real.makeSource() : mock!;
    unit.engine = new TwinEngine(
      unit.source,
      () => (mock ? mock.faults : NO_FAULTS),
      kind,
      this.opts.channels?.[id] ?? real?.channels,
      real ? () => this.opts.automationRunning?.(id) ?? false : undefined,
    );
    unit.engine.onEvent((e) => {
      for (const fn of this.eventListeners) fn({ ...e, unitId: id });
    });
    const full = unit as Unit;
    this.unitList.push(full);
    this.byId.set(id, full);
    if (this.started) this.startUnit(full);
  }

  private startUnit(u: Unit): void {
    void u.source.start();
    u.engine.start();
    // stagger the first autorun starts so the floor spins up within seconds, not in lockstep
    if (u.info.auto) u.nextRunAt = Date.now() + (1 + Math.random() * 12) * 1000;
  }

  private removeUnit(id: string, notify = true): boolean {
    const u = this.byId.get(id);
    if (!u) return false;
    u.engine.stop();
    void u.source.stop();
    this.byId.delete(id);
    this.unitList = this.unitList.filter((x) => x !== u);
    if (notify) this.notifyFleet();
    return true;
  }

  async start(): Promise<void> {
    this.started = true;
    for (const u of this.unitList) {
      await u.source.start();
      u.engine.start();
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

  /** Fires when the roster changes (auto flags, bays placed/emptied) so clients can refresh the fleet message. */
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
    // captured by id, not index: the roster can change before the timers fire
    const seed = (u: Unit | undefined, fault: FaultId, afterMs: number) => {
      if (!u || !u.mock || !FAULTS_BY_KIND[u.info.kind].includes(fault)) return;
      const id = u.info.id;
      this.timers.push(setTimeout(() => this.setFault(id, fault, true), afterMs));
    };
    const firstOf = (kind: MachineKind, minIdx = 0): Unit | undefined =>
      this.unitList.find((u, i) => i >= minIdx && u.info.kind === kind && !!u.mock);
    seed(firstOf('treadmill', 2), 'belt_slip', 8000);
    seed(firstOf('rower'), 'drive_belt_slip', 12000);
    seed(firstOf('elliptical'), 'bearing_knock', 20000);
    seed(firstOf('pilates'), 'carriage_drag', 24000);
    // last treadmill on the floor gets the vibration burst
    for (let i = this.unitList.length - 2; i >= 0; i--) {
      if (this.unitList[i].info.kind === 'treadmill') {
        seed(this.unitList[i], 'vibration_burst', 16000);
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
