import { create } from 'zustand';
import type {
  ChannelId,
  ChannelStatus,
  FaultId,
  GroupDisplay,
  PartGroup,
  RigBinding,
  RigConfig,
  ScenarioInfo,
  TwinState,
  UnitEvent,
  UnitInfo,
} from '@twinview/shared';
import { CHANNEL_IDS } from '@twinview/shared';
import type { ChannelReading } from '@twinview/shared';
import { FALLBACKS_BY_KIND } from '../scene/fallback';

export interface ModelInfo {
  model?: string;
  glbUrl: string | null;
  manifestUrl: string | null;
}

/** One entry of the server's model catalog (GET /api/models) */
export interface ModelEntry {
  model: string;
  glbUrl: string | null;
  manifestUrl: string | null;
  default: boolean;
}

/** Selected machine model, persisted across reloads; null = server default (treadmill). */
const MODEL_KEY = 'twinview.model';
export const savedModel = (): string | null => localStorage.getItem(MODEL_KEY);

/** Drill-down depth: lab floor → one unit → one component of that unit */
export type ViewLevel = 'lab' | 'unit' | 'component';

const LAB_EVENT_BUFFER = 400;

interface Store {
  units: UnitInfo[];
  /** Latest state per unit (10 Hz batch; events stripped — see labEvents) */
  states: Record<string, TwinState>;
  /** Lab-wide event stream, newest last, tagged with unit id */
  labEvents: UnitEvent[];
  focusedUnitId: string | null;
  selectedNode: string | null;
  /** Focused unit's state — the single-unit dashboard components read this */
  twin: TwinState | null;
  bindDialogOpen: boolean;
  /** Component level: x-ray everything but the selected part */
  isolateOn: boolean;

  /** The selected model's rig — what the bind/layers editors write to */
  rig: RigConfig;
  /** Every model's rig, keyed by model id (multi-CAD floor reads these) */
  rigs: Record<string, RigConfig>;
  scenarios: ScenarioInfo[];
  modelInfo: ModelInfo | null;
  /** Server's model catalog — drives the header model picker */
  models: ModelEntry[];
  partNames: string[];
  connected: boolean;

  setFleet(units: UnitInfo[], events: UnitEvent[]): void;
  setStates(states: Record<string, TwinState>): void;
  addEvent(e: UnitEvent): void;
  setRig(r: RigConfig): void;
  setConnected(c: boolean): void;
  setPartNames(names: string[]): void;

  focusUnit(id: string | null): void;
  select(node: string | null): void;
  setBindDialogOpen(open: boolean): void;
  setIsolateOn(on: boolean): void;
  /** Switch the viewed machine model (persists, then reloads to rebuild the scene) */
  selectModel(model: string): void;

  init(): Promise<void>;
  saveBinding(b: RigBinding): Promise<void>;
  removeBinding(nodeName: string): Promise<void>;
  seedGroups(model: string, groups: PartGroup[]): Promise<void>;
  setGroupDisplay(name: string, display: GroupDisplay): Promise<void>;
  setAllGroups(display: GroupDisplay, except?: string[]): Promise<void>;
  setPartGroup(nodeName: string, groupName: string | null): Promise<void>;
  startScenario(id: string): Promise<void>;
  stopScenario(): Promise<void>;
  setSetpoints(sp: { speed?: number; incline?: number }): Promise<void>;
  toggleFault(fault: FaultId, active: boolean): Promise<void>;
  setAuto(active: boolean): Promise<void>;
}

async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
}

export const viewLevel = (s: Pick<Store, 'focusedUnitId' | 'selectedNode'>): ViewLevel =>
  !s.focusedUnitId ? 'lab' : s.selectedNode ? 'component' : 'unit';

/**
 * The rig that actually drives the focused unit's 3D view. The server rig is
 * model-scoped (the header picker's model) — a focused unit of a *different*
 * model (e.g. a rower bay on a treadmill floor) runs its proxy's built-in rig
 * instead, so parts/inspector panels must read the same one the viewer uses.
 */
export function effectiveRig(
  s: Pick<Store, 'rig' | 'rigs' | 'focusedUnitId' | 'units' | 'models' | 'modelInfo'>,
): RigConfig {
  const u = s.units.find((x) => x.id === s.focusedUnitId);
  if (!u || u.model === (s.modelInfo?.model ?? s.rig.model)) return s.rig;
  // other-model bay with converted CAD: its own model-scoped rig drives the view
  const hasCad = !!s.models.find((m) => m.model === u.model)?.glbUrl;
  if (hasCad && s.rigs[u.model]) return s.rigs[u.model];
  return FALLBACKS_BY_KIND[u.kind].rig;
}

const STATUS_RANK: Record<ChannelStatus, number> = { ok: 0, stale: 1, warn: 2, fail: 3 };

/** Worst channel status for a unit — drives halos, dots, and fleet rollups.
 * Channels are kind-partial, so only the readings actually present count. */
export function unitStatus(state: TwinState | undefined): ChannelStatus {
  if (!state) return 'stale';
  const readings = Object.values(state.channels).filter(Boolean) as ChannelReading[];
  if (readings.length === 0) return 'stale';
  let worst: ChannelStatus = 'ok';
  for (const c of readings) {
    if (STATUS_RANK[c.status] > STATUS_RANK[worst]) worst = c.status;
  }
  return worst;
}

/** Detections = warn/fail events (deviations + injected faults), lab-wide. */
export const detections = (events: UnitEvent[]): UnitEvent[] =>
  events.filter((e) => e.severity !== 'info');

export const useStore = create<Store>((set, get) => {
  /** Commit an edited selected-model rig locally (both `rig` and `rigs`) before the PUT. */
  const commitRig = (rig: RigConfig) =>
    set((s) => ({ rig, rigs: { ...s.rigs, [rig.model || s.modelInfo?.model || '']: rig } }));

  return {
  units: [],
  states: {},
  labEvents: [],
  focusedUnitId: null,
  selectedNode: null,
  twin: null,
  bindDialogOpen: false,
  isolateOn: true,

  rig: { model: 'NTL99925', bindings: [] },
  rigs: {},
  scenarios: [],
  modelInfo: null,
  models: [],
  partNames: [],
  connected: false,

  setFleet: (units, events) =>
    set((s) => ({
      units,
      // roster refreshes (auto-flag flips) come with an empty backlog — keep ours
      labEvents: events.length > 0 ? events.slice(-LAB_EVENT_BUFFER) : s.labEvents,
    })),

  setStates: (states) => {
    const { focusedUnitId } = get();
    const twin = focusedUnitId ? states[focusedUnitId] ?? null : null;
    if (twin) appendHistory(twin);
    set({ states, twin });
  },

  addEvent: (e) =>
    set((s) => ({
      labEvents:
        s.labEvents.length >= LAB_EVENT_BUFFER
          ? [...s.labEvents.slice(-LAB_EVENT_BUFFER + 1), e]
          : [...s.labEvents, e],
    })),

  // Model-scoped: rigs[model] always updates; `rig` only if it's the selected model's
  setRig: (rig) =>
    set((s) => {
      const model = rig.model || s.modelInfo?.model || s.rig.model;
      const selected = s.modelInfo?.model ?? s.rig.model;
      return {
        rig: model === selected ? rig : s.rig,
        rigs: { ...s.rigs, [model]: rig },
      };
    }),
  setConnected: (connected) => set({ connected }),
  setPartNames: (partNames) => set({ partNames }),

  focusUnit: (id) => {
    if (id === get().focusedUnitId) return;
    clearHistory();
    set({
      focusedUnitId: id,
      selectedNode: null,
      bindDialogOpen: false,
      twin: id ? get().states[id] ?? null : null,
    });
  },

  select: (selectedNode) => set({ selectedNode, bindDialogOpen: false }),
  setBindDialogOpen: (bindDialogOpen) => set({ bindDialogOpen }),
  setIsolateOn: (isolateOn) => set({ isolateOn }),

  selectModel: (model) => {
    if (get().modelInfo?.model === model) return;
    const def = get().models.find((m) => m.default);
    if (model === def?.model) localStorage.removeItem(MODEL_KEY);
    else localStorage.setItem(MODEL_KEY, model);
    // the three.js scene modules are imperative and cache the loaded CAD —
    // a full reload is the clean swap (matches the existing HMR guidance)
    location.reload();
  },

  init: async () => {
    // ?model= scopes model-info + rig to the persisted pick; absent = server default
    const q = savedModel() ? `?model=${encodeURIComponent(savedModel()!)}` : '';
    const [scenarios, models, modelInfo, rig, units] = (await Promise.all([
      api('/scenarios'),
      api('/models'),
      api(`/model-info${q}`),
      api(`/rig${q}`),
      api('/units'),
    ])) as [ScenarioInfo[], ModelEntry[], ModelInfo, RigConfig, UnitInfo[]];
    // every converted model's rig loads too — the floor animates all of them
    const rigs: Record<string, RigConfig> = { [rig.model || modelInfo.model || '']: rig };
    await Promise.all(
      models
        .filter((m) => m.glbUrl && !rigs[m.model])
        .map(async (m) => {
          rigs[m.model] = await api(`/rig?model=${encodeURIComponent(m.model)}`);
        }),
    );
    set({ scenarios, models, modelInfo, rig, rigs, units });
  },

  saveBinding: async (b) => {
    const rig = structuredClone(get().rig);
    const i = rig.bindings.findIndex((x) => x.nodeName === b.nodeName);
    if (i >= 0) rig.bindings[i] = b;
    else rig.bindings.push(b);
    commitRig(rig);
    await api('/rig', 'PUT', rig);
  },

  removeBinding: async (nodeName) => {
    const rig = structuredClone(get().rig);
    rig.bindings = rig.bindings.filter((x) => x.nodeName !== nodeName);
    commitRig(rig);
    await api('/rig', 'PUT', rig);
  },

  // model-scoped: group seeding happens for whichever model's CAD was focused
  seedGroups: async (model, groups) => {
    const s = get();
    const selected = s.modelInfo?.model ?? s.rig.model;
    const base = model === selected ? s.rig : s.rigs[model];
    if (!base || base.groups?.length) return; // user's layout already exists
    const rig = structuredClone(base);
    rig.groups = groups;
    set((st) => ({
      rig: model === selected ? rig : st.rig,
      rigs: { ...st.rigs, [model]: rig },
    }));
    await api('/rig', 'PUT', rig);
  },

  setGroupDisplay: async (name, display) => {
    const rig = structuredClone(get().rig);
    const g = rig.groups?.find((x) => x.name === name);
    if (!g) return;
    g.display = display;
    commitRig(rig);
    await api('/rig', 'PUT', rig);
  },

  setAllGroups: async (display, except = []) => {
    const rig = structuredClone(get().rig);
    for (const g of rig.groups ?? []) {
      g.display = except.includes(g.name) ? 'solid' : display;
    }
    commitRig(rig);
    await api('/rig', 'PUT', rig);
  },

  setPartGroup: async (nodeName, groupName) => {
    const rig = structuredClone(get().rig);
    for (const g of rig.groups ?? []) g.parts = g.parts.filter((p) => p !== nodeName);
    if (groupName) rig.groups?.find((g) => g.name === groupName)?.parts.push(nodeName);
    commitRig(rig);
    await api('/rig', 'PUT', rig);
  },

  startScenario: async (id) => {
    const unit = get().focusedUnitId;
    if (unit) await api(`/units/${unit}/scenario/start`, 'POST', { id });
  },
  stopScenario: async () => {
    const unit = get().focusedUnitId;
    if (unit) await api(`/units/${unit}/scenario/stop`, 'POST', {});
  },
  setSetpoints: async (sp) => {
    const unit = get().focusedUnitId;
    if (unit) await api(`/units/${unit}/setpoints`, 'POST', sp);
  },
  toggleFault: async (fault, active) => {
    const unit = get().focusedUnitId;
    if (unit) await api(`/units/${unit}/faults`, 'POST', { fault, active });
  },
  setAuto: async (active) => {
    const unit = get().focusedUnitId;
    if (unit) await api(`/units/${unit}/auto`, 'POST', { active });
  },
  };
});

/**
 * Rolling chart history for the FOCUSED unit, kept outside zustand so 10 Hz
 * appends don't re-render the React tree; uPlot charts read it imperatively.
 * Cleared whenever the focused unit changes.
 */
const WINDOW = 900; // 90 s @ 10 Hz
export const chartHistory = Object.fromEntries(
  CHANNEL_IDS.map((id) => [id, { t: [] as number[], cmd: [] as number[], meas: [] as number[] }]),
) as Record<ChannelId, { t: number[]; cmd: number[]; meas: number[] }>;

function clearHistory(): void {
  for (const id of Object.keys(chartHistory) as ChannelId[]) {
    chartHistory[id].t.length = 0;
    chartHistory[id].cmd.length = 0;
    chartHistory[id].meas.length = 0;
  }
}

export function appendHistory(s: TwinState): void {
  for (const id of Object.keys(chartHistory) as ChannelId[]) {
    const c = s.channels[id];
    if (!c) continue; // kind-partial: the focused unit only reports its own channels
    const h = chartHistory[id];
    h.t.push(s.t / 1000);
    h.cmd.push(c.cmd);
    h.meas.push(c.meas);
    if (h.t.length > WINDOW) {
      h.t.splice(0, h.t.length - WINDOW);
      h.cmd.splice(0, h.cmd.length - WINDOW);
      h.meas.splice(0, h.meas.length - WINDOW);
    }
  }
}
