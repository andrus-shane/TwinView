import { unitStatus, useStore } from '../state/store';

const ACTIVITY = (running: boolean, scenario: string | null, speed: number): string =>
  running ? (scenario ?? 'manual') : speed > 0 ? 'manual' : 'idle';

/** Lab-level left panel: every unit on the floor, click to drill in. */
export function FleetPanel() {
  const units = useStore((s) => s.units);
  const states = useStore((s) => s.states);
  const scenarios = useStore((s) => s.scenarios);
  const emptyBays = useStore((s) =>
    s.lab ? s.lab.rows.reduce((n, r) => n + r.bays.filter((b) => !b.machine).length, 0) : 0,
  );
  const { focusUnit, setLabEditing } = useStore.getState();

  return (
    <div className="parts-panel">
      <div className="card-title row-between">
        <span>Units under test ({units.length})</span>
        <button
          className="btn tiny"
          onClick={() => setLabEditing(true)}
          title="Add/remove bays, resize them, and choose which machine sits in each"
        >
          ✎ Edit floor
        </button>
      </div>
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
                  {u.source !== 'mock' && <span className="auto-chip live">HW</span>}
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
        {units.length === 0 && emptyBays === 0 && <div className="muted">Connecting to the lab…</div>}
        {emptyBays > 0 && (
          <div className="muted empty-bays-note" onClick={() => setLabEditing(true)}>
            {emptyBays} empty bay{emptyBays > 1 ? 's' : ''} — click a dashed outline on the floor (or Edit floor) to
            place a machine.
          </div>
        )}
      </div>
    </div>
  );
}
