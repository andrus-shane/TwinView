/**
 * Reference plant models — a treadmill drivetrain and a rower drive.
 *
 * The twin engine runs these fault-free to produce *expected* behavior
 * (including natural lag, so a commanded 6 mph doesn't flag a deviation while
 * the belt is still legitimately spinning up). The mock telemetry source runs
 * a second copy with faults + noise to produce *measured* behavior.
 */

export interface Setpoints {
  /** treadmill: mph · rower: stroke rate target (spm) */
  speed: number;
  /** treadmill: grade % · rower: magnetic resistance level */
  incline: number;
}

export interface DriveState {
  speed: number;
  incline: number;
}

/** Belt spin-up/down time constant (s) */
const SPEED_TAU = 1.4;
/** Incline actuator slew rate (grade %/s) — treadmill lift motors are slow */
const INCLINE_RATE = 0.6;

export function stepDrive(state: DriveState, sp: Setpoints, dtS: number): void {
  // first-order lag toward speed setpoint
  const alpha = 1 - Math.exp(-dtS / SPEED_TAU);
  state.speed += (sp.speed - state.speed) * alpha;

  // rate-limited incline actuator
  const dIncline = sp.incline - state.incline;
  const maxStep = INCLINE_RATE * dtS;
  state.incline += Math.abs(dIncline) <= maxStep ? dIncline : Math.sign(dIncline) * maxStep;
}

/** Motor current (A) as a function of drive state — simple drivetrain load model. */
export function motorCurrent(s: DriveState): number {
  if (s.speed < 0.05) return 0.4; // idle electronics draw
  return 1.8 + 0.9 * s.speed + 0.055 * s.speed * s.speed + 0.32 * Math.max(0, s.incline);
}

/** Baseline vibration RMS (g) as a function of drive state. */
export function vibrationRms(s: DriveState): number {
  if (s.speed < 0.05) return 0.02;
  return 0.12 + 0.035 * s.speed + 0.002 * s.speed * s.speed;
}

// --- Rower (FMRW-class: belt drive into a magnetically braked flywheel) ---

export interface RowerState {
  /** strokes per minute the "rower" (test rig) is actually pulling */
  strokeRate: number;
  /** flywheel speed, rpm */
  flywheelRpm: number;
  /** magnetic brake servo position, resistance level */
  resistance: number;
}

/** How fast a test rig ramps its stroke cadence (s) */
const STROKE_TAU = 1.8;
/** Magnetic brake servo slew (levels/s) */
const RESISTANCE_RATE = 3.0;
/** Flywheel spin-up lag (s); freewheel decay is slower than the driven ramp */
const FLY_TAU_UP = 0.9;
const FLY_TAU_DOWN = 2.4;

export function stepRower(state: RowerState, sp: Setpoints, dtS: number): void {
  // cadence ramps like a human/robot settling into rhythm
  const aStroke = 1 - Math.exp(-dtS / STROKE_TAU);
  state.strokeRate += (sp.speed - state.strokeRate) * aStroke;
  if (state.strokeRate < 0.05 && sp.speed === 0) state.strokeRate = 0;

  // rate-limited brake servo
  const dRes = sp.incline - state.resistance;
  const maxStep = RESISTANCE_RATE * dtS;
  state.resistance += Math.abs(dRes) <= maxStep ? dRes : Math.sign(dRes) * maxStep;

  // flywheel chases the cadence; a higher brake level drags the mean rpm down
  const target = state.strokeRate < 0.5 ? 0 : state.strokeRate * (34 - 0.5 * state.resistance);
  const tau = target > state.flywheelRpm ? FLY_TAU_UP : FLY_TAU_DOWN;
  const aFly = 1 - Math.exp(-dtS / tau);
  state.flywheelRpm += (target - state.flywheelRpm) * aFly;
}

/** Drive power (W) at the handle — cubic-ish in cadence, scaled by brake level. */
export function rowerPower(s: RowerState): number {
  if (s.strokeRate < 1) return 0;
  return 0.0355 * Math.pow(s.strokeRate, 2.6) * (0.55 + 0.045 * s.resistance);
}

// --- Elliptical (NTEL-class: front drive, power incline ramp) ---

export interface EllipticalState {
  /** strides per minute (full crank revolutions) */
  strideRate: number;
  /** power ramp position, grade % */
  incline: number;
}

/** Rider settles into cadence (s) */
const STRIDE_TAU = 1.6;
/** Ramp actuator slew (grade %/s) — lift motors are slow, like the treadmill's */
const RAMP_RATE = 0.8;

export function stepElliptical(state: EllipticalState, sp: Setpoints, dtS: number): void {
  const aStride = 1 - Math.exp(-dtS / STRIDE_TAU);
  state.strideRate += (sp.speed - state.strideRate) * aStride;
  if (state.strideRate < 0.05 && sp.speed === 0) state.strideRate = 0;

  const dRamp = sp.incline - state.incline;
  const maxStep = RAMP_RATE * dtS;
  state.incline += Math.abs(dRamp) <= maxStep ? dRamp : Math.sign(dRamp) * maxStep;
}

/** Generator/brake load (W) — rises with cadence, steeper ramp works harder. */
export function ellipticalPower(s: EllipticalState): number {
  if (s.strideRate < 1) return 0;
  return 0.011 * Math.pow(s.strideRate, 2.2) * (1 + 0.035 * s.incline);
}

/** Baseline frame vibration RMS (g) as a function of cadence. */
export function ellipticalVibration(s: EllipticalState): number {
  if (s.strideRate < 1) return 0.02;
  return 0.05 + 0.0035 * s.strideRate;
}

// --- Pilates reformer (NTPL-class: sliding carriage, magnetic spring resistance) ---

export interface PilatesState {
  /** carriage reps per minute (one out-and-back per rep) */
  repRate: number;
  /** magnetic tension level */
  resistance: number;
}

/** User settles into rep tempo (s) */
const REP_TAU = 1.5;
/** Tension servo slew (levels/s) */
const TENSION_RATE = 2.0;

export function stepPilates(state: PilatesState, sp: Setpoints, dtS: number): void {
  const aRep = 1 - Math.exp(-dtS / REP_TAU);
  state.repRate += (sp.speed - state.repRate) * aRep;
  if (state.repRate < 0.05 && sp.speed === 0) state.repRate = 0;

  const dRes = sp.incline - state.resistance;
  const maxStep = TENSION_RATE * dtS;
  state.resistance += Math.abs(dRes) <= maxStep ? dRes : Math.sign(dRes) * maxStep;
}

/** Carriage travel per rep (cm) — brisk tempos shorten the stroke slightly. */
export function pilatesTravel(s: PilatesState): number {
  if (s.repRate < 1) return 0;
  return 62 - 0.3 * s.repRate;
}

/** Work rate (W): spring force × stroke × tempo. */
export function pilatesPower(s: PilatesState): number {
  if (s.repRate < 1) return 0;
  return (30 + 22 * s.resistance) * (pilatesTravel(s) / 100) * (s.repRate / 60);
}
