import type { ChannelId, FaultId } from '@twinview/shared';
import { stepDrive, motorCurrent, vibrationRms, type DriveState, type Setpoints } from '../plant.js';
import type { Sample, TelemetrySource } from './types.js';

/** Gaussian noise via Box-Muller */
function gauss(sigma: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
}

const TICK_MS = 50;

/**
 * Simulated machine. Runs the same plant model as the twin's reference, but
 * with injectable faults and sensor noise — so measured data diverges from
 * expected exactly the way a defective unit would.
 */
export class MockSource implements TelemetrySource {
  readonly kind = 'mock' as const;

  readonly faults: Record<FaultId, boolean> = {
    belt_slip: false,
    incline_stuck: false,
    current_spike: false,
    vibration_burst: false,
  };

  private drive: DriveState = { speed: 0, incline: 0 };
  private stuckInclineAt: number | null = null;
  private spikeLevel = 0;
  private samples = new Map<ChannelId, Sample>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private getSetpoints: () => Setpoints) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
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
  }

  latest(channel: ChannelId): Sample | null {
    return this.samples.get(channel) ?? null;
  }

  private tick(dtS: number): void {
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
}
