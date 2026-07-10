import { useStore } from '../state/store';

export function EventLog() {
  const twin = useStore((s) => s.twin);
  const events = twin?.events ?? [];
  return (
    <div className="card eventlog">
      <div className="card-title row-between">
        <span>QA Event Log</span>
        <a className="btn small" href="/api/export.csv" download>
          Export CSV
        </a>
      </div>
      <div className="eventlog-list">
        {[...events].reverse().map((e, i) => (
          <div key={`${e.t}-${i}`} className={`event event-${e.severity}`}>
            <span className="event-time">{new Date(e.t).toLocaleTimeString()}</span>
            <span className="event-chan">{e.channel}</span>
            <span className="event-msg">{e.msg}</span>
          </div>
        ))}
        {events.length === 0 && <div className="muted">No events yet — run a scenario.</div>}
      </div>
    </div>
  );
}
