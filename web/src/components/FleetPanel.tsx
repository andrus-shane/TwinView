import { unitStatus, useStore } from '../state/store';

const ACTIVITY = (running: boolean, scenario: string | null, speed: number): string =>
  running ? (scenario ?? 'manual') : speed > 0 ? 'manual' : 'idle';

/** Lab-level left panel: every unit on the floor, click to drill in. */
export function FleetPanel() {
  const units = useStore((s) => s.units);
  const states = useStore((s) => s.states);
  const scenarios = useStore((s) => s.scenarios);
  const { focusUnit } = useStore.getState();

  return (
    <div className="parts-panel">
      <div className="card-title">Units under test ({units.length})</div>
      <div className="part-list">
        {units.map((u) => {
          const st = states[u.id];
          const status = unitStatus(st);
          const running = st?.running ?? false;
          const activity = ACTIVITY(running, st?.scenario ?? null, st?.setpoints.speed ?? 0);
          const dur = scenarios.find((s) => s.id === st?.scenario)?.durationS ?? 0;
          const pct = running && dur > 0 ? Math.min(100, ((st?.elapsed ?? 0) / dur) * 100) : 0;
          return (
            <div key={u.id} className="unit-row" onClick={() => focusUnit(u.id)}>
              <span className={`dot dot-${status === 'ok' && !running ? 'none' : status}`} />
              <div className="unit-main">
                <div className="unit-title">
                  <span className="part-name">{u.label}</span>
                  <span className="unit-serial">{u.serial}</span>
                </div>
                <div className="unit-sub">
                  <span className={`unit-activity ${running ? 'on' : ''}`}>{activity}</span>
                  {u.kind !== 'treadmill' && (
                    <span className="auto-chip kind" title={u.model}>
                      {u.kind}
                    </span>
                  )}
                  {u.auto && <span className="auto-chip">auto</span>}
                  {u.source === 'serial' && <span className="auto-chip live">HW</span>}
                </div>
                {running && (
                  <div className="scenario-progress mini">
                    <div className="scenario-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              {status !== 'ok' && status !== 'stale' && (
                <span className={`pill pill-${status}`}>{status.toUpperCase()}</span>
              )}
            </div>
          );
        })}
        {units.length === 0 && <div className="muted">Connecting to the lab…</div>}
      </div>
    </div>
  );
}
