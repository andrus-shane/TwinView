/** Shared types for TwinView — the twin-state wire contract between server and web. */

export type ChannelId = 'belt_speed' | 'incline' | 'motor_current' | 'vibration';

export const CHANNEL_IDS: ChannelId[] = ['belt_speed', 'incline', 'motor_current', 'vibration'];

export type ChannelStatus = 'ok' | 'warn' | 'fail' | 'stale';

export interface ChannelReading {
  /** Commanded / twin-model expected value */
  cmd: number;
  /** Measured value (mock plant now, real sensor later) */
  meas: number;
  status: ChannelStatus;
  warnTol: number;
  failTol: number;
  unit: string;
  label: string;
}

export type FaultId = 'belt_slip' | 'incline_stuck' | 'current_spike' | 'vibration_burst';

export const FAULT_IDS: FaultId[] = ['belt_slip', 'incline_stuck', 'current_spike', 'vibration_burst'];

export const FAULT_LABELS: Record<FaultId, string> = {
  belt_slip: 'Belt slip',
  incline_stuck: 'Incline stuck',
  current_spike: 'Current spike',
  vibration_burst: 'Vibration burst',
};

export interface TwinEvent {
  t: number;
  channel: ChannelId | 'system';
  severity: 'info' | 'warn' | 'fail';
  msg: string;
}

export interface TwinState {
  /** Unix ms */
  t: number;
  running: boolean;
  scenario: string | null;
  /** Seconds into the running scenario */
  elapsed: number;
  /** Operator setpoints (what the console was told to do) */
  setpoints: { speed: number; incline: number };
  channels: Record<ChannelId, ChannelReading>;
  faults: Record<FaultId, boolean>;
  /** Ring buffer of recent events, newest last */
  events: TwinEvent[];
}

/** Roles a 3D part can play in the twin visualization */
export type RigRole = 'belt' | 'deck' | 'motor' | 'console_screen' | 'roller' | 'frame';

export const RIG_ROLES: RigRole[] = ['belt', 'deck', 'motor', 'console_screen', 'roller', 'frame'];

export const ROLE_LABELS: Record<RigRole, string> = {
  belt: 'Belt (scrolls at measured speed)',
  deck: 'Deck (tilts to measured incline)',
  motor: 'Motor (tinted by current status)',
  console_screen: 'Console screen (live tablet view)',
  roller: 'Roller (spins with belt)',
  frame: 'Frame (static reference)',
};

export interface RigBinding {
  /** glTF node name this binding attaches to */
  nodeName: string;
  role?: RigRole;
  /** Sensor channels attached to this part */
  channels: ChannelId[];
  sensor?: { kind: 'mock' | 'serial'; port?: string; note?: string };
}

/** How a part group renders: normal, see-through shell, or not at all. */
export type GroupDisplay = 'solid' | 'xray' | 'hidden';

export const GROUP_DISPLAYS: GroupDisplay[] = ['solid', 'xray', 'hidden'];

export interface PartGroup {
  name: string;
  parts: string[];
  display: GroupDisplay;
}

export interface RigConfig {
  model: string;
  bindings: RigBinding[];
  /** Visibility layers — seeded from material heuristics, user-editable. */
  groups?: PartGroup[];
}

/** WebSocket messages, server -> client */
export type ServerMessage =
  | { type: 'state'; state: TwinState }
  | { type: 'rig'; rig: RigConfig };

/** Scenario descriptor for the mock source */
export interface ScenarioInfo {
  id: string;
  label: string;
  description: string;
  durationS: number;
}
