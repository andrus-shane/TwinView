import { detections, unitStatus, useStore } from '../state/store';

/** Lab-level right panel: fleet rollup KPIs + the all-units detections feed. */
export function LabDashboard() {
  const units = useStore((s) => s.units);
  const states = useStore((s) => s.states);
  const labEvents = useStore((s) => s.labEvents);
  const { focusUnit } = useStore.getState();

  let running = 0;
  let warn = 0;
  let fail = 0;
  const kindCounts = new Map<string, number>();
  for (const u of units) {
    const st = states[u.id];
    if (st?.running || (st?.setpoints.speed ?? 0) > 0) running++;
    kindCounts.set(u.kind, (kindCounts.get(u.kind) ?? 0) + 1);
    const status = unitStatus(st);
    if (status === 'warn') warn++;
    if (status === 'fail') fail++;
  }
  const KIND_SHORT: Record<string, string> = {
    treadmill: 'tread',
    rower: 'row',
    elliptical: 'ell',
    pilates: 'pil',
  };
  const mixLabel = [...kindCounts]
    .map(([kind, n]) => `${n} ${KIND_SHORT[kind] ?? kind}`)
    .join(' · ');

  const feed = detections(labEvents).slice(-100).reverse();
  const unitLabel = (id: string) => units.find((u) => u.id === id)?.label ?? id;

  return (
    <>
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-num">{units.length}</div>
          <div className="kpi-label">Units</div>
          {kindCounts.size > 1 && <div className="kpi-sub">{mixLabel}</div>}
        </div>
        <div className="kpi">
          <div className="kpi-num accent">{running}</div>
          <div className="kpi-label">Testing</div>
        </div>
        <div className={`kpi ${warn > 0 ? 'kpi-warn' : ''}`}>
          <div className="kpi-num">{warn}</div>
          <div className="kpi-label">Warning</div>
        </div>
        <div className={`kpi ${fail > 0 ? 'kpi-fail' : ''}`}>
          <div className="kpi-num">{fail}</div>
          <div className="kpi-label">Failing</div>
        </div>
      </div>

      <div className="card detections-card">
        <div className="card-title">Detections — all units ({feed.length})</div>
        <div className="eventlog-list">
          {feed.map((e, i) => (
            <div
              key={`${e.t}-${e.unitId}-${i}`}
              className={`event event-${e.severity} clickable`}
              onClick={() => focusUnit(e.unitId)}
              title="Jump to unit"
            >
              <span className="event-time">{new Date(e.t).toLocaleTimeString()}</span>
              <span className="unit-chip">{unitLabel(e.unitId)}</span>
              <span className="event-msg">{e.msg}</span>
            </div>
          ))}
          {feed.length === 0 && (
            <div className="muted">No detections yet — all units within tolerance.</div>
          )}
        </div>
      </div>
    </>
  );
}
