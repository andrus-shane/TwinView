import type { ChannelId } from '@twinview/shared';

export interface Sample {
  /** Unix ms */
  t: number;
  value: number;
}

/**
 * A source of measured telemetry. The mock source synthesizes data from a plant
 * model; the serial source (later) reads the same channels from USB sensors.
 */
export interface TelemetrySource {
  readonly kind: 'mock' | 'serial';
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Latest measured sample for a channel, or null if none yet (stale). */
  latest(channel: ChannelId): Sample | null;
}
