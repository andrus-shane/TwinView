import { useState } from 'react';
import { FAULT_LABELS, FAULTS_BY_KIND, SETPOINT_META } from '@twinview/shared';
import { useStore } from '../state/store';

export function Controls() {
  const twin = useStore((s) => s.twin);
  const scenarios = useStore((s) => s.scenarios);
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const units = useStore((s) => s.units);
  const { startScenario, stopScenario, setSetpoints, toggleFault, setAuto } = useStore.getState();
  const [scenarioPick, setScenarioPick] = useState<string | null>(null);
  const [dragSpeed, setDragSpeed] = useState<number | null>(null);
  const [dragIncline, setDragIncline] = useState<number | null>(null);

  const unit = units.find((u) => u.id === focusedUnitId);
  const kind = unit?.kind ?? 'treadmill';
  const meta = SETPOINT_META[kind];
  // scenarios and faults are machine-kind specific — a rower can't run an incline sweep
  const kindScenarios = scenarios.filter((s) => s.kind === kind);
  const scenarioId = kindScenarios.some((s) => s.id === scenarioPick)
    ? scenarioPick!
    : kindScenarios[0]?.id ?? '';
  const running = twin?.running ?? false;
  const speed = dragSpeed ?? twin?.setpoints.speed ?? 0;
  const incline = dragIncline ?? twin?.setpoints.incline ?? 0;

  return (
    <div className="card">
      <div className="card-title row-between">
        <span>Test Control</span>
        {unit?.source !== 'serial' && (
          <label className="check auto-toggle" title="Unit cycles scenarios on its own; any manual action takes over">
            <input
              type="checkbox"
              checked={unit?.auto ?? false}
              onChange={(e) => void setAuto(e.target.checked)}
            />
            auto
          </label>
        )}
      </div>
      {unit?.auto && <div className="auto-note">Cycling scenarios automatically — manual actions take over.</div>}

      <div className="row">
        <select value={scenarioId} onChange={(e) => setScenarioPick(e.target.value)} disabled={running}>
          {kindScenarios.map((s) => (
            <option key={s.id} value={s.id} title={s.description}>
              {s.label}
            </option>
          ))}
        </select>
        {running ? (
          <button className="btn danger" onClick={() => stopScenario()}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => startScenario(scenarioId)} disabled={!scenarioId}>
            Run
          </button>
        )}
      </div>
      {running && twin && (
        <div className="scenario-progress">
          <div
            className="scenario-progress-fill"
            style={{
              width: `${Math.min(100, (twin.elapsed / (scenarios.find((s) => s.id === twin.scenario)?.durationS ?? 1)) * 100)}%`,
            }}
          />
        </div>
      )}

      <label className="slider-label">
        <span>
          {meta.speed.label} setpoint <b>{speed.toFixed(meta.speed.step < 1 ? 1 : 0)} {meta.speed.unit}</b>
        </span>
        <input
          type="range"
          min={meta.speed.min}
          max={meta.speed.max}
          step={meta.speed.step}
          value={speed}
          disabled={running}
          onChange={(e) => setDragSpeed(parseFloat(e.target.value))}
          onPointerUp={() => {
            if (dragSpeed !== null) void setSetpoints({ speed: dragSpeed });
            setDragSpeed(null);
          }}
        />
      </label>
      <label className="slider-label">
        <span>
          {meta.incline.label} setpoint <b>{incline.toFixed(meta.incline.step < 1 ? 1 : 0)} {meta.incline.unit}</b>
        </span>
        <input
          type="range"
          min={meta.incline.min}
          max={meta.incline.max}
          step={meta.incline.step}
          value={incline}
          disabled={running}
          onChange={(e) => setDragIncline(parseFloat(e.target.value))}
          onPointerUp={() => {
            if (dragIncline !== null) void setSetpoints({ incline: dragIncline });
            setDragIncline(null);
          }}
        />
      </label>

      <div className="card-title sub">Fault Injection (mock)</div>
      <div className="fault-grid">
        {FAULTS_BY_KIND[kind].map((f) => {
          const active = twin?.faults[f] ?? false;
          return (
            <button
              key={f}
              className={`btn fault ${active ? 'fault-active' : ''}`}
              onClick={() => void toggleFault(f, !active)}
            >
              {FAULT_LABELS[f]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
