import { detections, useStore, viewLevel } from '../state/store';

/**
 * Bottom log strip. Lab level: detections across every unit (click → jump to
 * the unit). Unit/component level: the focused unit's full event history.
 */
export function EventLog() {
  const labEvents = useStore((s) => s.labEvents);
  const units = useStore((s) => s.units);
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const selectedNode = useStore((s) => s.selectedNode);
  const { focusUnit } = useStore.getState();

  const level = viewLevel({ focusedUnitId, selectedNode });
  const atLab = level === 'lab';
  const events = atLab
    ? detections(labEvents).slice(-150)
    : labEvents.filter((e) => e.unitId === focusedUnitId).slice(-150);
  const unitLabel = (id: string) => units.find((u) => u.id === id)?.label ?? id;

  return (
    <div className="card eventlog">
      <div className="card-title row-between">
        <span>{atLab ? 'Lab Detections' : 'QA Event Log'}</span>
        {!atLab && focusedUnitId && (
          <a className="btn small" href={`/api/units/${focusedUnitId}/export.csv`} download>
            Export CSV
          </a>
        )}
      </div>
      <div className="eventlog-list">
        {[...events].reverse().map((e, i) => (
          <div
            key={`${e.t}-${e.unitId}-${i}`}
            className={`event event-${e.severity} ${atLab ? 'clickable' : ''}`}
            onClick={atLab ? () => focusUnit(e.unitId) : undefined}
            title={atLab ? 'Jump to unit' : undefined}
          >
            <span className="event-time">{new Date(e.t).toLocaleTimeString()}</span>
            {atLab ? (
              <span className="unit-chip">{unitLabel(e.unitId)}</span>
            ) : (
              <span className="event-chan">{e.channel}</span>
            )}
            <span className="event-msg">{e.msg}</span>
          </div>
        ))}
        {events.length === 0 && (
          <div className="muted">
            {atLab ? 'No detections — all units within tolerance.' : 'No events yet — run a scenario.'}
          </div>
        )}
      </div>
    </div>
  );
}
