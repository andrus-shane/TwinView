import { useEffect, useState } from 'react';
import {
  FAULT_LABELS,
  FAULTS_BY_KIND,
  KPH_PER_MPH,
  SETPOINT_META,
  SPEED_UNIT_LABEL,
  type ConsoleStatus,
  type UnitInfo,
} from '@twinview/shared';
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
  // An international treadmill displays km/h: the slider works in km/h for the operator while the
  // twin's setpoint (and everything the server does) stays in mph.
  const metric = kind === 'treadmill' && unit?.units === 'kph';
  const sf = metric ? KPH_PER_MPH : 1;
  const speedUnit = metric ? SPEED_UNIT_LABEL.kph : meta.speed.unit;
  const speedStep = metric ? 0.5 : meta.speed.step;

  return (
    <div className="card">
      <div className="card-title row-between">
        <span>Test Control</span>
        {unit?.source === 'mock' && (
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
          <button
            className="btn primary"
            onClick={() => {
              // an FP2-bound bay really commands the console — make the operator own that click
              if (
                unit?.console &&
                !window.confirm(
                  `Run ${scenarioId} on the FP2 console ${unit.console.link}?\nThe console receives WORKOUT_STATE and speed/incline targets.`,
                )
              )
                return;
              startScenario(scenarioId);
            }}
            disabled={!scenarioId}
          >
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
          {meta.speed.label} setpoint <b>{(speed * sf).toFixed(speedStep < 1 ? 1 : 0)} {speedUnit}</b>
        </span>
        <input
          type="range"
          min={meta.speed.min * sf}
          max={metric ? Math.round(meta.speed.max * sf) : meta.speed.max}
          step={speedStep}
          value={Math.round(speed * sf * 100) / 100}
          disabled={running}
          onChange={(e) => setDragSpeed(parseFloat(e.target.value) / sf)}
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

      {unit?.source === 'mock' && (
        <>
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
        </>
      )}

      {unit?.console && <ConsoleSection unit={unit} status={twin?.console} />}
      {unit && unit.source !== 'mock' && <AutomationSection unit={unit} />}
    </div>
  );
}

/** FP2 console status line — fed by TwinState.console at 10 Hz (Controls already re-renders per tick). */
function ConsoleSection({ unit, status }: { unit: UnitInfo; status: ConsoleStatus | undefined }) {
  // Pair = bond this PC with the BLE console through the gateway (once per host)
  const [pairing, setPairing] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  useEffect(() => {
    setPairing('idle');
    setPairMsg(null);
  }, [unit.id]);
  const pair = async () => {
    setPairing('busy');
    setPairMsg(
      `pairing with ${unit.console?.ble}… if the link is mid-connect this waits for that attempt to fail first (up to ~2 min), then ~30 s to bond`,
    );
    try {
      const r = await fetch(`/api/units/${unit.id}/console/pair`, { method: 'POST' });
      const body = (await r.json().catch(() => ({}))) as { error?: string; device?: string; address?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setPairing('ok');
      setPairMsg(`paired with ${body.device} (${body.address ?? '?'}) — link reconnects on its own`);
    } catch (e) {
      setPairing('fail');
      setPairMsg(`pairing failed: ${(e as Error).message}`);
    }
  };

  const ble = unit.console?.ble;
  const link =
    !status || status.link === 'connecting'
      ? 'connecting…'
      : status.link === 'up'
        ? `up (${status.transport ?? '?'})`
        : ble
          ? 'down — gateway running? console paired with this PC?'
          : 'down — is the FP2 gateway (:8102) running?';
  const parts = [
    link,
    `workout ${status?.workoutLabel ?? '—'}`,
    `console target ${
      status?.targetMph == null
        ? '—'
        : unit.units === 'kph'
          ? `${(status.targetMph * KPH_PER_MPH).toFixed(1)} km/h`
          : `${status.targetMph} mph`
    } / ${status?.targetGrade ?? '—'} %`,
    `last key ${status?.lastKey ?? '—'}`,
    `echo ${status?.lastEchoMs ?? '—'} ms`,
  ];
  return (
    <>
      <div className="card-title sub row-between">
        <span>Console · FP2 {unit.console!.link}</span>
        {ble && status?.link !== 'up' && (
          <button
            className="btn tiny"
            disabled={pairing === 'busy'}
            onClick={() => void pair()}
            title={`Bond this PC with ${ble} (Windows Just Works pairing). Needed once per PC before the console answers FP2 over BLE.`}
          >
            {pairing === 'busy' ? 'Pairing…' : 'Pair'}
          </button>
        )}
      </div>
      <div className="auto-note fp2-status">{parts.join(' · ')}</div>
      {unit.console?.desk && (
        <div className="auto-note" title="The model's emulator stands in for the real panel: its LCD renders on the unit and its keys drive this machine">
          desk console {unit.console.desk} · link {status?.deskLink ?? '—'} · keys on its panel drive this machine
        </div>
      )}
      {pairMsg && <div className="auto-note">{pairMsg}</div>}
    </>
  );
}

/**
 * Real bays run TabletAutoTest workflows (rail-tap setpoints + sensor-verified
 * tracking) on their assigned tablet console — the machine actually moves,
 * unlike the twin-only scenarios above.
 */
function AutomationSection({ unit }: { unit: UnitInfo }) {
  const workflows = useStore((s) => s.automationWorkflows);
  const available = useStore((s) => s.automationAvailable);
  const run = useStore((s) => s.automationRun);
  const { fetchAutomation, refreshAutomationRun, runAutomation } = useStore.getState();
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchAutomation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id]);

  const running = run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refreshAutomationRun(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, unit.id]);

  const list = workflows ?? [];
  const wfId = list.some((w) => w.id === pick) ? pick! : list[0]?.id ?? '';
  const wf = list.find((w) => w.id === wfId);

  // a tablet runs the UI-driven workflows; an FP2 console runs the device-less ones (test.ble_console_*)
  const consoleTarget = unit.console ? `FP2 console ${unit.console.link}` : null;
  const target = wfId.startsWith('test.ble_console_') && consoleTarget
    ? consoleTarget
    : unit.screenSerial
      ? `tablet ${unit.screenSerial}`
      : consoleTarget;
  // The belt/deck really moves, so the operator owns a second click. Inline rather than
  // window.confirm: a browser that has muted this page's dialogs would swallow that silently.
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [wfId, unit.id]);
  const launch = async () => {
    if (!wfId) return;
    if (!armed) {
      setArmed(true);
      setError(null);
      return;
    }
    setArmed(false);
    setError(await runAutomation(wfId));
  };

  return (
    <>
      <div className="card-title sub">Automation · TabletAutoTest</div>
      {available === false && (
        <div className="auto-note">TabletAutoTest repo not reachable from the server.</div>
      )}
      {available && !target && (
        <div className="auto-note">No tablet or FP2 console on this bay.</div>
      )}
      {available && target && (
        <>
          <div className="row">
            <select
              value={wfId}
              onChange={(e) => setPick(e.target.value)}
              disabled={running || !list.length}
              title={wf?.summary}
            >
              {!list.length && <option value="">{workflows ? 'no workflows found' : 'loading…'}</option>}
              {list.map((w) => (
                <option key={w.id} value={w.id} title={w.summary}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              className={`btn ${armed ? 'danger' : 'primary'}`}
              onClick={() => void launch()}
              disabled={running || !wfId}
              title={armed ? `Launches ${wfId} on ${target}. The machine will move.` : undefined}
            >
              {running ? 'Running…' : armed ? 'Confirm — machine will move' : 'Run'}
            </button>
            {armed && !running && (
              <button className="btn" onClick={() => setArmed(false)}>
                Cancel
              </button>
            )}
          </div>
          {run && (
            <div className="auto-note">
              {run.workflowId} on {run.serial}:{' '}
              {run.status === 'running'
                ? `running since ${new Date(run.startedAt).toLocaleTimeString()}`
                : `${run.status.toUpperCase()} (exit ${run.exitCode}) at ${new Date(run.endedAt ?? 0).toLocaleTimeString()}`}
            </div>
          )}
          {error && <div className="auto-note">{error}</div>}
        </>
      )}
    </>
  );
}
