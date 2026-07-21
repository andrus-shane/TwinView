import type { MachineKind, ScenarioInfo } from '@twinview/shared';

/**
 * A scenario is a timed setpoint profile: [atSeconds, speedAxis, inclineAxis].
 * The axes are kind-relative — treadmill: [t, mph, grade%], rower: [t, spm, level].
 */
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
    kind: 'treadmill',
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
    kind: 'treadmill',
    profile: Array.from({ length: 10 }, (_, i) => [i * 28, i + 1, 0] as ProfileStep).concat([[290, 0, 0]]),
  },
  {
    id: 'incline_sweep',
    label: 'Incline sweep (4 min)',
    description: 'Steps incline 0→12% at constant 2.5 mph, then back to flat.',
    durationS: 240,
    kind: 'treadmill',
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
  {
    id: 'steady_row',
    label: 'Steady row (3 min)',
    description: 'Warm-up to a settled 22 spm at mid resistance, then cooldown.',
    durationS: 180,
    kind: 'rower',
    profile: [
      [0, 16, 5],
      [20, 20, 7],
      [40, 22, 8],
      [140, 18, 6],
      [165, 0, 5],
    ],
  },
  {
    id: 'row_intervals',
    label: 'Stroke intervals (4 min)',
    description: '30 s sprints at 32 spm / level 12 alternating with easy recovery.',
    durationS: 240,
    kind: 'rower',
    profile: [
      [0, 16, 6],
      [30, 32, 12],
      [60, 15, 6],
      [90, 32, 12],
      [120, 15, 6],
      [150, 32, 12],
      [180, 15, 6],
      [210, 22, 8],
      [230, 0, 6],
    ],
  },
  {
    id: 'resistance_ladder',
    label: 'Resistance ladder (4 min)',
    description: 'Steps the magnetic brake 4→24 at a constant 20 spm to verify the servo.',
    durationS: 240,
    kind: 'rower',
    profile: [
      [0, 20, 4],
      [40, 20, 9],
      [80, 20, 14],
      [120, 20, 19],
      [160, 20, 24],
      [200, 20, 12],
      [225, 0, 8],
    ],
  },
  {
    id: 'steady_stride',
    label: 'Steady stride (3 min)',
    description: 'Warm-up to a settled 55 spm at mid ramp, then cooldown.',
    durationS: 180,
    kind: 'elliptical',
    profile: [
      [0, 40, 3],
      [20, 50, 5],
      [40, 55, 8],
      [140, 45, 4],
      [165, 0, 2],
    ],
  },
  {
    id: 'ramp_sweep',
    label: 'Ramp sweep (4 min)',
    description: 'Steps the power ramp 0→18% at a constant 50 spm to verify the lift.',
    durationS: 240,
    kind: 'elliptical',
    profile: [
      [0, 50, 0],
      [40, 50, 5],
      [80, 50, 10],
      [120, 50, 14],
      [160, 50, 18],
      [200, 50, 8],
      [225, 0, 2],
    ],
  },
  {
    id: 'stride_intervals',
    label: 'Stride intervals (4 min)',
    description: '30 s pushes at 65 spm alternating with easy 40 spm recovery.',
    durationS: 240,
    kind: 'elliptical',
    profile: [
      [0, 45, 5],
      [30, 65, 10],
      [60, 40, 5],
      [90, 65, 10],
      [120, 40, 5],
      [150, 65, 10],
      [180, 40, 5],
      [210, 55, 8],
      [230, 0, 3],
    ],
  },
  {
    id: 'steady_flow',
    label: 'Steady flow (3 min)',
    description: 'Settles into a controlled 18 rpm at mid tension, then winds down.',
    durationS: 180,
    kind: 'pilates',
    profile: [
      [0, 12, 3],
      [20, 16, 5],
      [40, 18, 6],
      [140, 14, 4],
      [165, 0, 3],
    ],
  },
  {
    id: 'spring_ladder',
    label: 'Tension ladder (4 min)',
    description: 'Steps the magnetic tension 2→10 at a constant 16 rpm to verify the servo.',
    durationS: 240,
    kind: 'pilates',
    profile: [
      [0, 16, 2],
      [40, 16, 4],
      [80, 16, 6],
      [120, 16, 8],
      [160, 16, 10],
      [200, 16, 5],
      [225, 0, 3],
    ],
  },
  {
    id: 'tempo_intervals',
    label: 'Tempo intervals (4 min)',
    description: '30 s brisk 26 rpm work alternating with slow 12 rpm control.',
    durationS: 240,
    kind: 'pilates',
    profile: [
      [0, 14, 5],
      [30, 26, 7],
      [60, 12, 5],
      [90, 26, 7],
      [120, 12, 5],
      [150, 26, 7],
      [180, 12, 5],
      [210, 18, 6],
      [230, 0, 4],
    ],
  },
];

export function scenariosForKind(kind: MachineKind): Scenario[] {
  return SCENARIOS.filter((s) => s.kind === kind);
}

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
