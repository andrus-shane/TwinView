import type { ChannelId, FaultId, MachineKind } from '@twinview/shared';
import {
  stepDrive,
  motorCurrent,
  vibrationRms,
  stepRower,
  rowerPower,
  stepElliptical,
  ellipticalPower,
  ellipticalVibration,
  stepPilates,
  pilatesTravel,
  pilatesPower,
  type DriveState,
  type EllipticalState,
  type PilatesState,
  type RowerState,
  type Setpoints,
} from '../plant.js';
import type { Sample, TelemetrySource } from './types.js';

/** Gaussian noise via Box-Muller */
function gauss(sigma: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
}

const TICK_MS = 50;

/**
 * Simulated machine. Runs the same plant model as the twin's reference
 * (treadmill drivetrain or rower drive, per kind), but with injectable faults
 * and sensor noise — so measured data diverges from expected exactly the way
 * a defective unit would.
 */
export class MockSource implements TelemetrySource {
  readonly kind = 'mock' as const;

  readonly faults: Record<FaultId, boolean> = {
    belt_slip: false,
    incline_stuck: false,
    current_spike: false,
    vibration_burst: false,
    drive_belt_slip: false,
    resistance_stuck: false,
    power_drift: false,
    stroke_dropout: false,
    ramp_stuck: false,
    bearing_knock: false,
    gen_drag: false,
    cadence_dropout: false,
    spring_fatigue: false,
    carriage_drag: false,
    tension_stuck: false,
    rep_dropout: false,
  };

  private drive: DriveState = { speed: 0, incline: 0 };
  private rower: RowerState = { strokeRate: 0, flywheelRpm: 0, resistance: 0 };
  private ell: EllipticalState = { strideRate: 0, incline: 0 };
  private pil: PilatesState = { repRate: 0, resistance: 0 };
  private stuckInclineAt: number | null = null;
  private stuckResistanceAt: number | null = null;
  private stuckRampAt: number | null = null;
  private stuckTensionAt: number | null = null;
  private spikeLevel = 0;
  private powerDrift = 0;
  private samples = new Map<ChannelId, Sample>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();

  constructor(
    private getSetpoints: () => Setpoints,
    private machine: MachineKind = 'treadmill',
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.lastTick = Date.now();
    // Integrate with measured elapsed time, not the nominal interval — with a
    // whole fleet of mocks, late timer fires would otherwise make every plant
    // lag its reference and ramps would flag phantom deviations.
    this.timer = setInterval(() => {
      const now = Date.now();
      const dtS = Math.min(0.5, (now - this.lastTick) / 1000);
      this.lastTick = now;
      if (this.machine === 'rower') this.tickRower(dtS);
      else if (this.machine === 'elliptical') this.tickElliptical(dtS);
      else if (this.machine === 'pilates') this.tickPilates(dtS);
      else this.tickTreadmill(dtS);
    }, TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setFault(fault: FaultId, active: boolean): void {
    this.faults[fault] = active;
    if (fault === 'incline_stuck') {
      this.stuckInclineAt = active ? this.drive.incline : null;
    }
    if (fault === 'resistance_stuck') {
      this.stuckResistanceAt = active ? this.rower.resistance : null;
    }
    if (fault === 'ramp_stuck') {
      this.stuckRampAt = active ? this.ell.incline : null;
    }
    if (fault === 'tension_stuck') {
      this.stuckTensionAt = active ? this.pil.resistance : null;
    }
  }

  latest(channel: ChannelId): Sample | null {
    return this.samples.get(channel) ?? null;
  }

  private tickTreadmill(dtS: number): void {
    const sp = this.getSetpoints();

    // Plant with actuator faults
    const effectiveSp: Setpoints = { ...sp };
    if (this.faults.incline_stuck && this.stuckInclineAt !== null) {
      effectiveSp.incline = this.stuckInclineAt;
      this.drive.incline = this.stuckInclineAt;
    }
    stepDrive(this.drive, effectiveSp, dtS);

    // Belt slip: drive turns the motor but the belt loses ~14% under load
    const beltSpeed = this.faults.belt_slip ? this.drive.speed * 0.86 : this.drive.speed;

    // Current spikes: decaying random bursts on top of the load model
    let current = motorCurrent(this.drive);
    if (this.faults.current_spike) {
      if (Math.random() < 0.06) this.spikeLevel += 3 + Math.random() * 4;
    }
    // slipping belts also load the motor
    if (this.faults.belt_slip) current *= 1.18;
    this.spikeLevel *= Math.exp(-dtS / 0.8);
    current += this.spikeLevel;

    let vib = vibrationRms(this.drive);
    if (this.faults.vibration_burst) {
      const gate = Math.sin(Date.now() / 900) > -0.2 ? 1 : 0;
      vib += gate * (0.45 + 0.15 * Math.sin(Date.now() / 70));
    }

    const t = Date.now();
    this.samples.set('belt_speed', { t, value: Math.max(0, beltSpeed + gauss(0.045)) });
    this.samples.set('incline', { t, value: this.drive.incline + gauss(0.05) });
    this.samples.set('motor_current', { t, value: Math.max(0, current + gauss(0.12)) });
    this.samples.set('vibration', { t, value: Math.max(0, vib + gauss(0.012)) });
  }

  private tickRower(dtS: number): void {
    const sp = this.getSetpoints();

    // Plant with actuator faults
    const effectiveSp: Setpoints = { ...sp };
    if (this.faults.resistance_stuck && this.stuckResistanceAt !== null) {
      effectiveSp.incline = this.stuckResistanceAt;
      this.rower.resistance = this.stuckResistanceAt;
    }
    stepRower(this.rower, effectiveSp, dtS);

    // Drive belt slip: strokes stop reaching the flywheel cleanly — the
    // flywheel runs ~20% slow and the handle wastes work in the slipping belt
    const slipping = this.faults.drive_belt_slip;
    const flywheel = slipping ? this.rower.flywheelRpm * 0.8 : this.rower.flywheelRpm;

    let power = rowerPower(this.rower);
    if (slipping) power *= 0.85;
    // Strain-gauge drift: the power reading creeps upward while active, decays back when cleared
    if (this.faults.power_drift) this.powerDrift = Math.min(38, this.powerDrift + 1.6 * dtS);
    else this.powerDrift *= Math.exp(-dtS / 2.5);
    if (power > 1) power += this.powerDrift;

    // Handle-encoder dropout: intermittent windows where strokes go uncounted
    let strokeRate = this.rower.strokeRate;
    if (this.faults.stroke_dropout && Math.sin(Date.now() / 1400) > 0.1) {
      strokeRate *= 0.55;
    }

    const t = Date.now();
    this.samples.set('stroke_rate', { t, value: Math.max(0, strokeRate + gauss(0.25)) });
    this.samples.set('flywheel_speed', { t, value: Math.max(0, flywheel + gauss(6)) });
    this.samples.set('drive_power', { t, value: Math.max(0, power + gauss(2.2)) });
    this.samples.set('resistance', { t, value: Math.max(0, this.rower.resistance + gauss(0.12)) });
  }

  private tickElliptical(dtS: number): void {
    const sp = this.getSetpoints();

    // Plant with actuator faults
    const effectiveSp: Setpoints = { ...sp };
    if (this.faults.ramp_stuck && this.stuckRampAt !== null) {
      effectiveSp.incline = this.stuckRampAt;
      this.ell.incline = this.stuckRampAt;
    }
    stepElliptical(this.ell, effectiveSp, dtS);

    let power = ellipticalPower(this.ell);
    // Generator drag: brake/generator binds — the rider works ~22% harder for the same cadence
    if (this.faults.gen_drag && power > 1) power = power * 1.22 + 6;

    let vib = ellipticalVibration(this.ell);
    // Bearing knock: periodic thumps once the drivetrain is turning
    if (this.faults.bearing_knock && this.ell.strideRate > 3) {
      const gate = Math.sin(Date.now() / 700) > 0.35 ? 1 : 0;
      vib += gate * (0.35 + 0.12 * Math.sin(Date.now() / 55));
    }

    // Cadence-sensor dropout: intermittent windows where strides go uncounted
    let strideRate = this.ell.strideRate;
    if (this.faults.cadence_dropout && Math.sin(Date.now() / 1500) > 0.15) {
      strideRate *= 0.55;
    }

    const t = Date.now();
    this.samples.set('stride_rate', { t, value: Math.max(0, strideRate + gauss(0.35)) });
    this.samples.set('incline', { t, value: this.ell.incline + gauss(0.05) });
    this.samples.set('drive_power', { t, value: Math.max(0, power + gauss(2.2)) });
    this.samples.set('vibration', { t, value: Math.max(0, vib + gauss(0.015)) });
  }

  private tickPilates(dtS: number): void {
    const sp = this.getSetpoints();

    // Plant with actuator faults
    const effectiveSp: Setpoints = { ...sp };
    if (this.faults.tension_stuck && this.stuckTensionAt !== null) {
      effectiveSp.incline = this.stuckTensionAt;
      this.pil.resistance = this.stuckTensionAt;
    }
    stepPilates(this.pil, effectiveSp, dtS);

    let travel = pilatesTravel(this.pil);
    let power = pilatesPower(this.pil);
    let resistance = this.pil.resistance;

    // A fatigued spring delivers less force: the same reps read light on the
    // load cell and the tension sensor sits below the commanded level.
    if (this.faults.spring_fatigue) {
      power *= 0.8;
      resistance *= 0.85;
    }
    // Roller obstruction: the carriage binds before full extension and the
    // user works against the drag.
    if (this.faults.carriage_drag && travel > 0) {
      travel *= 0.75;
      power *= 1.15;
    }

    // Encoder dropout: intermittent windows where reps go uncounted
    let repRate = this.pil.repRate;
    if (this.faults.rep_dropout && Math.sin(Date.now() / 1600) > 0.15) {
      repRate *= 0.55;
    }

    const t = Date.now();
    this.samples.set('rep_rate', { t, value: Math.max(0, repRate + gauss(0.2)) });
    this.samples.set('carriage_travel', { t, value: Math.max(0, travel + gauss(0.8)) });
    this.samples.set('drive_power', { t, value: Math.max(0, power + gauss(1.2)) });
    this.samples.set('resistance', { t, value: Math.max(0, resistance + gauss(0.1)) });
  }
}
