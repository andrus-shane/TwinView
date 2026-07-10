import { useState } from 'react';
import { FAULT_IDS, FAULT_LABELS } from '@twinview/shared';
import { useStore } from '../state/store';

export function Controls() {
  const twin = useStore((s) => s.twin);
  const scenarios = useStore((s) => s.scenarios);
  const { startScenario, stopScenario, setSetpoints, toggleFault } = useStore.getState();
  const [scenarioId, setScenarioId] = useState('quick_check');
  const [dragSpeed, setDragSpeed] = useState<number | null>(null);
  const [dragIncline, setDragIncline] = useState<number | null>(null);

  const running = twin?.running ?? false;
  const speed = dragSpeed ?? twin?.setpoints.speed ?? 0;
  const incline = dragIncline ?? twin?.setpoints.incline ?? 0;

  return (
    <div className="card">
      <div className="card-title">Test Control</div>

      <div className="row">
        <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} disabled={running}>
          {scenarios.map((s) => (
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
          <button className="btn primary" onClick={() => startScenario(scenarioId)}>
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
          Speed setpoint <b>{speed.toFixed(1)} mph</b>
        </span>
        <input
          type="range"
          min={0}
          max={12}
          step={0.5}
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
          Incline setpoint <b>{incline.toFixed(1)} %</b>
        </span>
        <input
          type="range"
          min={-3}
          max={15}
          step={0.5}
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
        {FAULT_IDS.map((f) => {
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
