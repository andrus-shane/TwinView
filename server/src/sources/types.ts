import type { ChannelId } from '@twinview/shared';

export interface Sample {
  /**
   * Measurement time (Unix ms). For sources whose hardware stamps samples at
   * the origin (the Pi rigs), this is the source's own sample clock mapped
   * onto the host timeline — use THIS for interval/derivative math (speed,
   * RPM, coast-down fits): consecutive differences carry the source clock's
   * precision, free of transport jitter. Sources with no clock of their own
   * (mock, serial, legacy Pi firmware) set t === tHost.
   */
  t: number;
  /**
   * Host arrival time (Unix ms, Date.now() when the sample was received).
   * Use ONLY for staleness watchdogs ("is data still flowing") — it carries
   * TCP/Wi-Fi jitter and read-coalescing artifacts (several 10 ms samples
   * can share one arrival stamp), so never difference it.
   */
  tHost: number;
  value: number;
}

/**
 * A source of measured telemetry. The mock source synthesizes data from a plant
 * model; the serial source (later) reads the same channels from USB sensors.
 */
export interface TelemetrySource {
  readonly kind: 'mock' | 'serial' | 'net' | 'fp2';
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Latest measured sample for a channel, or null if none yet (stale). */
  latest(channel: ChannelId): Sample | null;
}
