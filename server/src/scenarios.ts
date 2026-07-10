import type { ScenarioInfo } from '@twinview/shared';

/** A scenario is a timed setpoint profile: [atSeconds, speedMph, inclinePct] */
export type ProfileStep = [number, number, number];

export interface Scenario extends ScenarioInfo {
  profile: ProfileStep[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'quick_check',
    label: 'Quick check (2 min)',
    description: 'Short speed/incline exercise: walk, run, climb, cooldown.',
    durationS: 120,
    profile: [
      [0, 1.5, 0],
      [15, 3.0, 0],
      [35, 6.0, 0],
      [60, 6.0, 5],
      [90, 3.0, 2],
      [110, 0, 0],
    ],
  },
  {
    id: 'speed_ramp',
    label: 'Speed staircase (5 min)',
    description: 'Steps belt speed 1→10 mph to verify tracking at each setpoint.',
    durationS: 300,
    profile: Array.from({ length: 10 }, (_, i) => [i * 28, i + 1, 0] as ProfileStep).concat([[290, 0, 0]]),
  },
  {
    id: 'incline_sweep',
    label: 'Incline sweep (4 min)',
    description: 'Steps incline 0→12% at constant 2.5 mph, then back to flat.',
    durationS: 240,
    profile: [
      [0, 2.5, 0],
      [20, 2.5, 3],
      [60, 2.5, 6],
      [100, 2.5, 9],
      [140, 2.5, 12],
      [180, 2.5, 6],
      [210, 2.5, 0],
      [230, 0, 0],
    ],
  },
];

export function scenarioSetpoints(s: Scenario, elapsedS: number): { speed: number; incline: number } {
  let speed = 0;
  let incline = 0;
  for (const [at, sp, inc] of s.profile) {
    if (elapsedS >= at) {
      speed = sp;
      incline = inc;
    }
  }
  return { speed, incline };
}
