import { ROLE_LABELS } from '@twinview/shared';
import { effectiveRig, useStore } from '../state/store';
import { GaugeCard } from './GaugeCard';

/**
 * Component-level right panel: what this part is, its sensors, its live
 * channels (expected vs measured), and every detection it produced.
 */
export function ComponentInspector() {
  const selected = useStore((s) => s.selectedNode);
  const rig = useStore(effectiveRig);
  const serverRig = useStore((s) => s.rig);
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const labEvents = useStore((s) => s.labEvents);
  const isolateOn = useStore((s) => s.isolateOn);
  const { setBindDialogOpen, setIsolateOn, select } = useStore.getState();
  // editing writes to the server rig — built-in proxy rigs (other-model bays) are read-only
  const editable = rig === serverRig;

  if (!selected) return null;

  const binding = rig.bindings.find((b) => b.nodeName === selected);
  const group = rig.groups?.find((g) => g.parts.includes(selected))?.name;
  const partEvents = labEvents
    .filter(
      (e) =>
        e.unitId === focusedUnitId &&
        e.severity !== 'info' &&
        binding?.channels.includes(e.channel as (typeof binding.channels)[number]),
    )
    .slice(-40)
    .reverse();

  return (
    <>
      <div className="card">
        <div className="card-title row-between">
          <span>Component</span>
          <button className="btn small" onClick={() => select(null)} title="Back to unit view">
            ✕
          </button>
        </div>
        <div className="inspector-name" title={selected}>
          {selected}
        </div>
        <div className="inspector-meta">
          {binding?.role && <span className="meta-chip role">{ROLE_LABELS[binding.role].split(' (')[0]}</span>}
          {group && <span className="meta-chip">{group}</span>}
          {binding?.sensor?.note && <span className="meta-chip note">{binding.sensor.note}</span>}
        </div>

        <label className="check isolate-toggle">
          <input type="checkbox" checked={isolateOn} onChange={(e) => setIsolateOn(e.target.checked)} />
          X-ray isolate (see through the rest of the machine)
        </label>

        {editable && (
          <div className="row">
            <button className="btn" onClick={() => setBindDialogOpen(true)}>
              {binding ? 'Edit sensor binding…' : 'Bind sensors…'}
            </button>
          </div>
        )}
      </div>

      {binding && binding.channels.length > 0 ? (
        binding.channels.map((id) => <GaugeCard key={id} id={id} />)
      ) : (
        <div className="card muted">
          No sensor channels bound to this part — bind one to see expected vs measured here.
        </div>
      )}

      <div className="card detections-card">
        <div className="card-title">Part detections ({partEvents.length})</div>
        <div className="eventlog-list">
          {partEvents.map((e, i) => (
            <div key={`${e.t}-${i}`} className={`event event-${e.severity}`}>
              <span className="event-time">{new Date(e.t).toLocaleTimeString()}</span>
              <span className="event-msg">{e.msg}</span>
            </div>
          ))}
          {partEvents.length === 0 && <div className="muted">No deviations recorded on this part.</div>}
        </div>
      </div>
    </>
  );
}
