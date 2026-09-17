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
  /** `alarm` = safety condition (belt moving with nobody in charge), above `fail` */
  severity: 'info' | 'warn' | 'fail' | 'alarm';
  msg: string;
}

export interface ConsoleStatus {
  /** Gateway WebSocket + FP2 link health */
  link: 'connecting' | 'up' | 'down';
  transport: string | null;
  /** FP2 WORKOUT_STATE 0..6 and its name (none/ready/warmup/running/cooldown/paused/results) */
  workoutState: number | null;
  workoutLabel: string | null;
  /** Console-side targets in twin units (mph, %) */
  targetMph: number | null;
  targetGrade: number | null;
  lastKey: string | null;
  /** Echo latency of the last FP2 write, ms; null before the first write */
  lastEchoMs: number | null;
  /** Link health of the bay's desk console (the model's emulator standing in for a real BLE panel) */
  deskLink?: 'connecting' | 'up' | 'down';
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
  /**
   * Safety watchdog (real-hardware bays only): the machine is measurably moving
   * while no automation run or scenario is in charge of it. Level-triggered —
   * true for as long as the condition holds, driving the web's red banner.
   */
  unattended?: boolean;
  /** Live FP2 console status (bays with fleet.consoles); absent otherwise */
  console?: ConsoleStatus;
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

// --- Lab floor layout: rows of bays (slots), each sized independently and
// either empty or holding one machine. Persisted server-side (lab.json) and
// edited live from the web; the fleet roster is derived from the occupied bays.

export const MACHINE_KINDS: MachineKind[] = ['treadmill', 'rower', 'elliptical', 'pilates'];

export const KIND_LABELS: Record<MachineKind, string> = {
  treadmill: 'Treadmill',
  rower: 'Rower',
  elliptical: 'Elliptical',
  pilates: 'Pilates reformer',
};

/** Default CAD model per kind — what a bay gets when only a kind is chosen. */
export const DEFAULT_MODEL_BY_KIND: Record<MachineKind, string> = {
  treadmill: 'NTL99925',
  rower: 'FMRW0826-1D30',
  elliptical: 'NTEL71426',
  pilates: 'NTPL99926-6FW0',
};

/**
 * Machine kind for a model id. Known ids first, then the iFit SKU prefix
 * (NTL/PFTL/… treadmills, NTEL ellipticals, FMRW rowers, NTPL reformers);
 * anything else is a treadmill.
 */
export function kindForModel(model: string): MachineKind {
  for (const [kind, m] of Object.entries(DEFAULT_MODEL_BY_KIND) as [MachineKind, string][]) {
    if (m === model) return kind;
  }
  const up = model.toUpperCase();
  if (/^(NTEL|PFEL|FMEL|[A-Z]*EL\d)/.test(up)) return 'elliptical';
  if (/^(FMRW|NTRW|PFRW|[A-Z]*RW\d)/.test(up)) return 'rower';
  if (/^(NTPL|PFPL|[A-Z]*PL\d)/.test(up)) return 'pilates';
  return 'treadmill';
}

/** Footprint of a standard bay (m): the proxy machine is ~1 × 2.6 m plus walkway. */
export const BAY_SIZE_DEFAULT = { width: 2.0, depth: 3.4 };
export const BAY_SIZE_MIN = { width: 1.2, depth: 2.2 };
export const BAY_SIZE_MAX = { width: 6, depth: 8 };

export interface LabMachine {
  kind: MachineKind;
  /** CAD model id from models/ (falls back to the kind's proxy when no GLB exists) */
  model: string;
}

/**
 * FP2 console bound to a bay: the Renode PM210 emulator, or a BLE console
 * found by the device code printed on it (it advertises as iFIT_Tread_<CODE>).
 */
export type LabConsole = { kind: 'emulator' } | { kind: 'ble'; code: string };

/**
 * What the machine's console/tablet displays speed in. FP2 is km/h on the wire either way;
 * test runs launched from the bay get it (FP2_SPEED_UNIT / TREADMILL_SPEED_UNIT) so matrices
 * step in the unit the operator sees.
 */
export type SpeedUnit = 'mph' | 'kph';
export const KPH_PER_MPH = 1.609344;
/** Display label for a speed unit */
export const SPEED_UNIT_LABEL: Record<SpeedUnit, string> = { mph: 'mph', kph: 'km/h' };

/** BLE device code as shown on a console (e.g. 1CSF, DFAB); stored upper-case */
export const DEVICE_CODE_RE = /^[A-Za-z0-9]{2,8}$/;

/** One floor slot. `id` doubles as the unit id while the bay is occupied
 * (so hardware configs keyed "u01" keep pointing at the same slot). */
export interface LabBay {
  id: string;
  label: string;
  /** Footprint along the row (x), metres */
  width: number;
  /** Footprint front-to-back (z), metres */
  depth: number;
  /** null = empty bay */
  machine: LabMachine | null;
  /** FP2 console commanding this bay (emulator, or BLE by device code); absent/null = none */
  console?: LabConsole | null;
  /** Speed unit the machine in this bay displays (international unit = kph); absent = mph */
  units?: SpeedUnit;
}

export interface LabRow {
  id: string;
  label?: string;
  bays: LabBay[];
}

export interface LabLayout {
  version: 1;
  /** How rows of unequal width line up on the floor */
  align: 'center' | 'left';
  rows: LabRow[];
}

/** Real-hardware slots: bay id → the kind and source its sensor config declares. */
export type LabRealBays = Record<string, { kind: MachineKind; source: 'serial' | 'net' | 'fp2' }>;

/** One unit under test on the lab floor */
export interface UnitInfo {
  id: string;
  /** 1-based position in floor order (row-major); labels come from the bay */
  bay: number;
  label: string;
  serial: string;
  model: string;
  kind: MachineKind;
  source: 'mock' | 'serial' | 'net' | 'fp2';
  /** Autorun: unit cycles scenarios on its own until an operator takes over */
  auto: boolean;
  /** Speed unit this machine displays (bay.units); the twin shows belt speed in it. Absent = mph */
  units?: SpeedUnit;
  /** adb serial of the tablet console assigned to this bay (streams in lab + unit view) */
  screenSerial?: string;
  /**
   * FP2 console bound to this bay: gateway link name, whether an LCD proxy exists, and for a
   * BLE console its advertised name (the Console card offers Pair — an unbonded host gets no FP2 replies)
   */
  console?: {
    link: string;
    lcd: boolean;
    ble?: string;
    /** Emulator link acting as this bay's DESK console: its LCD shows on the unit, its keys drive the real machine */
    desk?: string;
  };
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
  | { type: 'rig'; rig: RigConfig }
  | { type: 'lab'; layout: LabLayout; real: LabRealBays };

/** Scenario descriptor for the mock source */
export interface ScenarioInfo {
  id: string;
  label: string;
  description: string;
  durationS: number;
  /** Which machine kind this test profile applies to */
  kind: MachineKind;
}
