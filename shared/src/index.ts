/** Shared types for TwinView — the twin-state wire contract between server and web. */

/** What kind of machine a unit is — drives channels, faults, scenarios, and 3D rigging. */
export type MachineKind = 'treadmill' | 'rower' | 'elliptical' | 'pilates';

export type ChannelId =
  | 'belt_speed'
  | 'incline'
  | 'motor_current'
  | 'vibration'
  | 'stroke_rate'
  | 'flywheel_speed'
  | 'drive_power'
  | 'resistance'
  | 'stride_rate'
  | 'rep_rate'
  | 'carriage_travel';

export const CHANNEL_IDS: ChannelId[] = [
  'belt_speed',
  'incline',
  'motor_current',
  'vibration',
  'stroke_rate',
  'flywheel_speed',
  'drive_power',
  'resistance',
  'stride_rate',
  'rep_rate',
  'carriage_travel',
];

/** The sensor channels a unit of a given kind actually reports. Some ids are
 * shared across kinds (incline, vibration, drive_power, resistance) — the twin
 * engine resolves the expected-value model per (kind, channel). */
export const CHANNELS_BY_KIND: Record<MachineKind, ChannelId[]> = {
  treadmill: ['belt_speed', 'incline', 'motor_current', 'vibration'],
  rower: ['stroke_rate', 'flywheel_speed', 'drive_power', 'resistance'],
  elliptical: ['stride_rate', 'incline', 'drive_power', 'vibration'],
  pilates: ['rep_rate', 'carriage_travel', 'drive_power', 'resistance'],
};

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

export type FaultId =
  | 'belt_slip'
  | 'incline_stuck'
  | 'current_spike'
  | 'vibration_burst'
  | 'drive_belt_slip'
  | 'resistance_stuck'
  | 'power_drift'
  | 'stroke_dropout'
  | 'ramp_stuck'
  | 'bearing_knock'
  | 'gen_drag'
  | 'cadence_dropout'
  | 'spring_fatigue'
  | 'carriage_drag'
  | 'tension_stuck'
  | 'rep_dropout';

export const FAULT_IDS: FaultId[] = [
  'belt_slip',
  'incline_stuck',
  'current_spike',
  'vibration_burst',
  'drive_belt_slip',
  'resistance_stuck',
  'power_drift',
  'stroke_dropout',
  'ramp_stuck',
  'bearing_knock',
  'gen_drag',
  'cadence_dropout',
  'spring_fatigue',
  'carriage_drag',
  'tension_stuck',
  'rep_dropout',
];

export const FAULT_LABELS: Record<FaultId, string> = {
  belt_slip: 'Belt slip',
  incline_stuck: 'Incline stuck',
  current_spike: 'Current spike',
  vibration_burst: 'Vibration burst',
  drive_belt_slip: 'Drive belt slip',
  resistance_stuck: 'Resistance stuck',
  power_drift: 'Power sensor drift',
  stroke_dropout: 'Stroke sensor dropout',
  ramp_stuck: 'Ramp stuck',
  bearing_knock: 'Bearing knock',
  gen_drag: 'Generator drag',
  cadence_dropout: 'Cadence dropout',
  spring_fatigue: 'Spring fatigue',
  carriage_drag: 'Carriage drag',
  tension_stuck: 'Tension stuck',
  rep_dropout: 'Rep sensor dropout',
};

/** Faults injectable on a unit of a given kind. */
export const FAULTS_BY_KIND: Record<MachineKind, FaultId[]> = {
  treadmill: ['belt_slip', 'incline_stuck', 'current_spike', 'vibration_burst'],
  rower: ['drive_belt_slip', 'resistance_stuck', 'power_drift', 'stroke_dropout'],
  elliptical: ['ramp_stuck', 'bearing_knock', 'gen_drag', 'cadence_dropout'],
  pilates: ['spring_fatigue', 'carriage_drag', 'tension_stuck', 'rep_dropout'],
};

/**
 * How the two generic operator setpoint axes read for each machine kind.
 * The wire keeps `{ speed, incline }` for every kind — a rower's "speed" is
 * its stroke-rate target (spm) and its "incline" is the magnetic resistance
 * level, exactly like a robotic test rig would command them.
 */
export interface SetpointAxisMeta {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

export const SETPOINT_META: Record<MachineKind, { speed: SetpointAxisMeta; incline: SetpointAxisMeta }> = {
  treadmill: {
    speed: { label: 'Speed', unit: 'mph', min: 0, max: 12, step: 0.5 },
    incline: { label: 'Incline', unit: '%', min: -3, max: 15, step: 0.5 },
  },
  rower: {
    speed: { label: 'Stroke rate', unit: 'spm', min: 0, max: 40, step: 1 },
    incline: { label: 'Resistance', unit: 'lvl', min: 0, max: 26, step: 1 },
  },
  elliptical: {
    speed: { label: 'Stride rate', unit: 'spm', min: 0, max: 70, step: 1 },
    incline: { label: 'Ramp incline', unit: '%', min: 0, max: 20, step: 0.5 },
  },
  pilates: {
    speed: { label: 'Rep cadence', unit: 'rpm', min: 0, max: 40, step: 1 },
    incline: { label: 'Resistance', unit: 'lvl', min: 0, max: 12, step: 1 },
  },
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
  /** Only the unit kind's channels are present (see CHANNELS_BY_KIND) */
  channels: Partial<Record<ChannelId, ChannelReading>>;
  faults: Record<FaultId, boolean>;
  /** Ring buffer of recent events, newest last */
  events: TwinEvent[];
}

/** Roles a 3D part can play in the twin visualization */
export type RigRole =
  | 'belt'
  | 'deck'
  | 'motor'
  | 'console_screen'
  | 'roller'
  | 'frame'
  | 'seat'
  | 'handle'
  | 'flywheel'
  | 'pedal'
  | 'arm'
  | 'carriage'
  | 'crank'
  | 'spring';

export const RIG_ROLES: RigRole[] = [
  'belt',
  'deck',
  'motor',
  'console_screen',
  'roller',
  'frame',
  'seat',
  'handle',
  'flywheel',
  'pedal',
  'arm',
  'carriage',
  'crank',
  'spring',
];

export const ROLE_LABELS: Record<RigRole, string> = {
  belt: 'Belt (scrolls at measured speed)',
  deck: 'Deck (tilts to measured incline)',
  motor: 'Motor (tinted by current status)',
  console_screen: 'Console screen (live tablet view)',
  roller: 'Roller (spins with belt)',
  frame: 'Frame (static reference)',
  seat: 'Seat (slides with the stroke)',
  handle: 'Handle (pulls with the stroke)',
  flywheel: 'Flywheel (spins at measured rpm)',
  pedal: 'Pedal (rides the stride path)',
  arm: 'Arm pole (swings with the stride)',
  carriage: 'Carriage (slides with the rep)',
  crank: 'Crank (turns with the cadence)',
  spring: 'Spring (stretches with the carriage)',
};

export interface RigBinding {
  /** glTF node name this binding attaches to */
  nodeName: string;
  role?: RigRole;
  /** Sensor channels attached to this part */
  channels: ChannelId[];
  sensor?: { kind: 'mock' | 'serial' | 'net'; port?: string; host?: string; note?: string };
  /**
   * Scene nodes that ride this binding's animation as one rigid group (a seat's
   * sled wheels, a pedal's arm link, the carriage's shoulder blocks). Explicit
   * lists beat the geometric capture heuristics on flat CAD assemblies.
   */
  attach?: string[];
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

/** One unit under test on the lab floor */
export interface UnitInfo {
  id: string;
  /** 1-based bay number; drives floor placement */
  bay: number;
  label: string;
  serial: string;
  model: string;
  kind: MachineKind;
  source: 'mock' | 'serial' | 'net';
  /** Autorun: unit cycles scenarios on its own until an operator takes over */
  auto: boolean;
  /** adb serial of the tablet console assigned to this bay (streams in lab + unit view) */
  screenSerial?: string;
}

/** A twin event tagged with the unit it came from (lab-wide detections feed) */
export interface UnitEvent extends TwinEvent {
  unitId: string;
}

/**
 * WebSocket messages, server -> client.
 * `states` is the 10 Hz batch for every unit with `events` stripped (empty) —
 * events arrive individually as `event` messages so the lab feed stays cheap.
 */
export type ServerMessage =
  | { type: 'fleet'; units: UnitInfo[]; events: UnitEvent[] }
  | { type: 'states'; states: Record<string, TwinState> }
  | { type: 'event'; event: UnitEvent }
  | { type: 'rig'; rig: RigConfig };

/** Scenario descriptor for the mock source */
export interface ScenarioInfo {
  id: string;
  label: string;
  description: string;
  durationS: number;
  /** Which machine kind this test profile applies to */
  kind: MachineKind;
}
