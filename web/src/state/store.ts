import { create } from 'zustand';
import type {
  ChannelId,
  FaultId,
  RigBinding,
  RigConfig,
  ScenarioInfo,
  TwinState,
} from '@twinview/shared';

export interface ModelInfo {
  glbUrl: string | null;
  manifestUrl: string | null;
}

interface Store {
  twin: TwinState | null;
  rig: RigConfig;
  scenarios: ScenarioInfo[];
  modelInfo: ModelInfo | null;
  partNames: string[];
  selectedNode: string | null;
  connected: boolean;

  setTwin(s: TwinState): void;
  setRig(r: RigConfig): void;
  setConnected(c: boolean): void;
  setPartNames(names: string[]): void;
  select(node: string | null): void;

  init(): Promise<void>;
  saveBinding(b: RigBinding): Promise<void>;
  removeBinding(nodeName: string): Promise<void>;
  startScenario(id: string): Promise<void>;
  stopScenario(): Promise<void>;
  setSetpoints(sp: { speed?: number; incline?: number }): Promise<void>;
  toggleFault(fault: FaultId, active: boolean): Promise<void>;
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

export const useStore = create<Store>((set, get) => ({
  twin: null,
  rig: { model: 'NTL99925', bindings: [] },
  scenarios: [],
  modelInfo: null,
  partNames: [],
  selectedNode: null,
  connected: false,

  setTwin: (twin) => set({ twin }),
  setRig: (rig) => set({ rig }),
  setConnected: (connected) => set({ connected }),
  setPartNames: (partNames) => set({ partNames }),
  select: (selectedNode) => set({ selectedNode }),

  init: async () => {
    const [scenarios, modelInfo, rig] = await Promise.all([
      api('/scenarios'),
      api('/model-info'),
      api('/rig'),
    ]);
    set({ scenarios, modelInfo, rig });
  },

  saveBinding: async (b) => {
    const rig = structuredClone(get().rig);
    const i = rig.bindings.findIndex((x) => x.nodeName === b.nodeName);
    if (i >= 0) rig.bindings[i] = b;
    else rig.bindings.push(b);
    set({ rig });
    await api('/rig', 'PUT', rig);
  },

  removeBinding: async (nodeName) => {
    const rig = structuredClone(get().rig);
    rig.bindings = rig.bindings.filter((x) => x.nodeName !== nodeName);
    set({ rig });
    await api('/rig', 'PUT', rig);
  },

  startScenario: async (id) => {
    await api('/scenario/start', 'POST', { id });
  },
  stopScenario: async () => {
    await api('/scenario/stop', 'POST', {});
  },
  setSetpoints: async (sp) => {
    await api('/setpoints', 'POST', sp);
  },
  toggleFault: async (fault, active) => {
    await api('/faults', 'POST', { fault, active });
  },
}));

/**
 * Rolling chart history, kept outside zustand so 10 Hz appends don't re-render
 * the React tree; uPlot charts read it imperatively.
 */
const WINDOW = 900; // 90 s @ 10 Hz
export const chartHistory: Record<ChannelId, { t: number[]; cmd: number[]; meas: number[] }> = {
  belt_speed: { t: [], cmd: [], meas: [] },
  incline: { t: [], cmd: [], meas: [] },
  motor_current: { t: [], cmd: [], meas: [] },
  vibration: { t: [], cmd: [], meas: [] },
};

export function appendHistory(s: TwinState): void {
  for (const id of Object.keys(chartHistory) as ChannelId[]) {
    const h = chartHistory[id];
    const c = s.channels[id];
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
