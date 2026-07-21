import { useStore } from '../state/store';

/** Drill-down trail over the viewport: Lab floor › Bay 03 · SN-A1003 › Motor_Housing */
export function Breadcrumb() {
  const units = useStore((s) => s.units);
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const selectedNode = useStore((s) => s.selectedNode);
  const { focusUnit, select } = useStore.getState();

  const unit = units.find((u) => u.id === focusedUnitId);

  return (
    <div className="breadcrumb">
      <button
        className={`crumb ${!unit ? 'current' : ''}`}
        onClick={() => focusUnit(null)}
        disabled={!unit}
      >
        ⌂ Lab floor
      </button>
      {unit && (
        <>
          <span className="crumb-sep">›</span>
          <button
            className={`crumb ${!selectedNode ? 'current' : ''}`}
            onClick={() => select(null)}
            disabled={!selectedNode}
          >
            {unit.label} · {unit.serial}
          </button>
        </>
      )}
      {unit && selectedNode && (
        <>
          <span className="crumb-sep">›</span>
          <span className="crumb current" title={selectedNode}>
            {selectedNode.length > 26 ? `${selectedNode.slice(0, 26)}…` : selectedNode}
          </span>
        </>
      )}
    </div>
  );
}
