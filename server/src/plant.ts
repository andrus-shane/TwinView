/**
 * Reference plant model of a treadmill drivetrain.
 *
 * The twin engine runs this fault-free to produce *expected* behavior
 * (including natural lag, so a commanded 6 mph doesn't flag a deviation while
 * the belt is still legitimately spinning up). The mock telemetry source runs
 * a second copy with faults + noise to produce *measured* behavior.
 */

export interface Setpoints {
  /** mph */
  speed: number;
  /** grade % */
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
