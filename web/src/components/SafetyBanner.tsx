import { useStore } from '../state/store';

/**
 * Red overlay across the top of the 3D viewport while any unit reports
 * unattended motion (a real-hardware bay measurably moving with no automation
 * run or scenario in charge — see the server's TwinEngine.watchdogTick).
 * Level-triggered off TwinState.unattended rather than the event stream, so it
 * tracks the live condition and shows for clients that connect mid-incident.
 */
export function SafetyBanner() {
  // stable string selector so the 10 Hz state batches don't re-render the tree
  const unattendedIds = useStore((s) =>
    Object.entries(s.states)
      .filter(([, st]) => st.unattended)
      .map(([id]) => id)
      .sort()
      .join(','),
  );
  const units = useStore((s) => s.units);
  const { focusUnit } = useStore.getState();

  if (!unattendedIds) return null;
  const ids = unattendedIds.split(',');
  return (
    <div className="safety-banner" role="alert">
      <span className="safety-banner-title">⚠ UNATTENDED MOTION</span>
      {ids.map((id) => (
        <button key={id} className="safety-banner-unit" onClick={() => focusUnit(id)} title="Jump to unit">
          {units.find((u) => u.id === id)?.label ?? id}
        </button>
      ))}
      <span className="safety-banner-msg">moving with no active run or scenario</span>
    </div>
  );
}
