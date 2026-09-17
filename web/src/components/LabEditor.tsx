import { useEffect, useState } from 'react';
import {
  BAY_SIZE_DEFAULT,
  BAY_SIZE_MAX,
  BAY_SIZE_MIN,
  DEVICE_CODE_RE,
  KIND_LABELS,
  MACHINE_KINDS,
  type LabBay,
  type LabLayout,
  type MachineKind,
} from '@twinview/shared';
import { useStore } from '../state/store';

// --- Pure layout edits (the server re-validates; ids mirror its numbering) ---

const clone = (l: LabLayout): LabLayout => structuredClone(l);

function nextBayId(l: LabLayout): string {
  const used = new Set(l.rows.flatMap((r) => r.bays.map((b) => b.id)));
  for (let n = 1; ; n++) {
    const id = `u${String(n).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
}

function nextRowId(l: LabLayout): string {
  const used = new Set(l.rows.map((r) => r.id));
  for (let n = 1; ; n++) {
    if (!used.has(`r${n}`)) return `r${n}`;
  }
}

function newBay(l: LabLayout): LabBay {
  const id = nextBayId(l);
  return { id, label: `Bay ${id.replace(/^u/, '')}`, ...BAY_SIZE_DEFAULT, machine: null };
}

function findBay(l: LabLayout, id: string): { row: number; idx: number } | null {
  for (let r = 0; r < l.rows.length; r++) {
    const i = l.rows[r].bays.findIndex((b) => b.id === id);
    if (i >= 0) return { row: r, idx: i };
  }
  return null;
}

const SIZE_PRESETS: { label: string; width: number; depth: number }[] = [
  { label: 'Compact', width: 1.6, depth: 2.8 },
  { label: 'Standard', width: BAY_SIZE_DEFAULT.width, depth: BAY_SIZE_DEFAULT.depth },
  { label: 'Wide', width: 2.6, depth: 4.0 },
  { label: 'XL', width: 3.2, depth: 5.0 },
];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

/**
 * Lab-level left panel while the floor is being edited: rows of bays as chips,
 * a detail card for the selected bay (label, machine, footprint, position),
 * and save/load of named floors. Every change PUTs the whole layout; the
 * server reconciles the fleet and everyone's floor re-renders from the result.
 */
export function LabEditor() {
  const lab = useStore((s) => s.lab);
  const labReal = useStore((s) => s.labReal);
  const editBayId = useStore((s) => s.editBayId);
  const models = useStore((s) => s.models);
  const units = useStore((s) => s.units);
  const savedLayouts = useStore((s) => s.savedLayouts);
  const labError = useStore((s) => s.labError);
  const {
    saveLab,
    selectBay,
    setLabEditing,
    focusUnit,
    fetchSavedLayouts,
    saveLayoutAs,
    loadLayout,
    deleteLayout,
    resetLab,
  } = useStore.getState();
  const [saveName, setSaveName] = useState('');
  const [loadPick, setLoadPick] = useState('');

  useEffect(() => {
    if (savedLayouts === null) void fetchSavedLayouts();
  }, [savedLayouts, fetchSavedLayouts]);

  if (!lab) {
    return (
      <div className="parts-panel lab-editor">
        <div className="card-title">Lab floor</div>
        <div className="muted">Loading the floor…</div>
      </div>
    );
  }

  const commit = (mutate: (l: LabLayout) => void) => {
    const next = clone(lab);
    mutate(next);
    void saveLab(next);
  };

  const addRow = () => commit((l) => l.rows.push({ id: nextRowId(l), bays: [newBay(l)] }));
  const addBay = (rowId: string) =>
    commit((l) => {
      const row = l.rows.find((r) => r.id === rowId);
      if (!row) return;
      const bay = newBay(l);
      row.bays.push(bay);
      selectBay(bay.id);
    });
  const removeRow = (rowId: string) => {
    const row = lab.rows.find((r) => r.id === rowId);
    if (!row) return;
    const occupied = row.bays.filter((b) => b.machine).length;
    if (occupied > 0 && !confirm(`Remove this row and its ${occupied} machine${occupied > 1 ? 's' : ''}?`)) return;
    commit((l) => {
      l.rows = l.rows.filter((r) => r.id !== rowId);
    });
  };
  const moveRow = (rowId: string, dir: -1 | 1) =>
    commit((l) => {
      const i = l.rows.findIndex((r) => r.id === rowId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= l.rows.length) return;
      [l.rows[i], l.rows[j]] = [l.rows[j], l.rows[i]];
    });
  const updateBay = (id: string, patch: Partial<LabBay>) =>
    commit((l) => {
      const at = findBay(l, id);
      if (at) Object.assign(l.rows[at.row].bays[at.idx], patch);
    });
  const removeBay = (id: string) =>
    commit((l) => {
      const at = findBay(l, id);
      if (!at) return;
      l.rows[at.row].bays.splice(at.idx, 1);
      if (editBayId === id) selectBay(null);
    });
  const moveBay = (id: string, dir: -1 | 1) =>
    commit((l) => {
      const at = findBay(l, id);
      if (!at) return;
      const bays = l.rows[at.row].bays;
      const j = at.idx + dir;
      if (j >= 0 && j < bays.length) {
        [bays[at.idx], bays[j]] = [bays[j], bays[at.idx]];
        return;
      }
      // past the row's end: hop to the neighboring row
      const r = at.row + dir;
      if (r < 0 || r >= l.rows.length) return;
      const [bay] = bays.splice(at.idx, 1);
      if (dir > 0) l.rows[r].bays.unshift(bay);
      else l.rows[r].bays.push(bay);
    });

  const selected = editBayId ? lab.rows.flatMap((r) => r.bays).find((b) => b.id === editBayId) ?? null : null;
  const bayCount = lab.rows.reduce((n, r) => n + r.bays.length, 0);
  const unitCount = lab.rows.reduce((n, r) => n + r.bays.filter((b) => b.machine).length, 0);

  return (
    <div className="parts-panel lab-editor">
      <div className="card-title row-between">
        <span>
          Lab floor · {bayCount} bay{bayCount === 1 ? '' : 's'} · {unitCount} machine{unitCount === 1 ? '' : 's'}
        </span>
        <button className="btn tiny primary" onClick={() => setLabEditing(false)} title="Back to the unit list (Esc)">
          Done
        </button>
      </div>

      <div className="lab-toolbar">
        <button className="btn small" onClick={addRow} title="Add a row with one empty bay">
          + Row
        </button>
        <select
          value={lab.align}
          onChange={(e) => commit((l) => (l.align = e.target.value as LabLayout['align']))}
          title="How rows of different widths line up"
        >
          <option value="center">Rows centered</option>
          <option value="left">Rows left-aligned</option>
        </select>
        <button
          className="btn small"
          onClick={() => {
            if (confirm('Replace the floor with the default grid from config.json?')) void resetLab();
          }}
          title="Back to the config.json fleet grid"
        >
          Reset
        </button>
      </div>

      <div className="lab-toolbar" title="Save this floor under a name, or bring a saved one back">
        <select value={loadPick} onChange={(e) => setLoadPick(e.target.value)}>
          <option value="">Saved floors…</option>
          {(savedLayouts ?? []).map((l) => (
            <option key={l.name} value={l.name}>
              {l.name} · {l.bays} bays / {l.units} machines
            </option>
          ))}
        </select>
        <button className="btn small" disabled={!loadPick} onClick={() => void loadLayout(loadPick)}>
          Load
        </button>
        <button
          className="btn small danger"
          disabled={!loadPick}
          onClick={() => {
            if (confirm(`Delete saved floor "${loadPick}"?`)) {
              void deleteLayout(loadPick);
              setLoadPick('');
            }
          }}
        >
          ✕
        </button>
      </div>
      <div className="lab-toolbar">
        <input
          type="text"
          placeholder="Name this floor…"
          value={saveName}
          maxLength={48}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && saveName.trim()) {
              void saveLayoutAs(saveName.trim());
              setSaveName('');
            }
          }}
        />
        <button
          className="btn small"
          disabled={!saveName.trim()}
          onClick={() => {
            void saveLayoutAs(saveName.trim());
            setSaveName('');
          }}
        >
          Save as
        </button>
      </div>

      {labError && <div className="lab-error">{labError}</div>}

      <div className="lab-rows">
        {lab.rows.map((row, r) => (
          <div key={row.id} className="lab-row">
            <div className="lab-row-head">
              <span>
                Row {r + 1} · {row.bays.length} bay{row.bays.length === 1 ? '' : 's'}
              </span>
              <span className="spacer" />
              <button className="btn tiny" disabled={r === 0} onClick={() => moveRow(row.id, -1)} title="Move row back">
                ▲
              </button>
              <button
                className="btn tiny"
                disabled={r === lab.rows.length - 1}
                onClick={() => moveRow(row.id, 1)}
                title="Move row forward"
              >
                ▼
              </button>
              <button className="btn tiny danger" onClick={() => removeRow(row.id)} title="Remove this row">
                ✕
              </button>
            </div>
            <div className="lab-bays">
              {row.bays.map((b) => {
                const real = labReal[b.id];
                const unit = units.find((u) => u.id === b.id);
                return (
                  <div
                    key={b.id}
                    className={`lab-bay-chip${b.id === editBayId ? ' selected' : ''}${b.machine ? '' : ' empty'}${real ? ' real' : ''}`}
                    onClick={() => selectBay(b.id === editBayId ? null : b.id)}
                    title={`${b.id} · ${fmt(b.width)} × ${fmt(b.depth)} m${real ? ` · real hardware (${real.source})` : ''}`}
                  >
                    <span className="chip-title">{b.label}</span>
                    <span className="chip-sub">{b.machine ? unit?.model ?? b.machine.model : 'empty'}</span>
                  </div>
                );
              })}
              <button className="lab-bay-add" onClick={() => addBay(row.id)} title="Add an empty bay to this row">
                +
              </button>
            </div>
          </div>
        ))}
        {lab.rows.length === 0 && <div className="muted">No rows yet — add one to start laying out the floor.</div>}
      </div>

      {selected ? (
        <BayDetail
          bay={selected}
          real={labReal[selected.id]}
          models={models}
          hasUnit={units.some((u) => u.id === selected.id)}
          onChange={(patch) => updateBay(selected.id, patch)}
          onMove={(dir) => moveBay(selected.id, dir)}
          onRemove={() => removeBay(selected.id)}
          onOpen={() => focusUnit(selected.id)}
        />
      ) : (
        <div className="lab-hint">
          Click a bay here or on the floor to edit it. Dashed outlines are empty bays; drop a machine in from the bay's
          Machine list.
        </div>
      )}
    </div>
  );
}

interface BayDetailProps {
  bay: LabBay;
  real?: { kind: MachineKind; source: 'serial' | 'net' | 'fp2' };
  models: { model: string; kind: MachineKind; glbUrl: string | null }[];
  hasUnit: boolean;
  onChange(patch: Partial<LabBay>): void;
  onMove(dir: -1 | 1): void;
  onRemove(): void;
  onOpen(): void;
}

function BayDetail({ bay, real, models, hasUnit, onChange, onMove, onRemove, onOpen }: BayDetailProps) {
  // drafts commit on blur/Enter so a PUT doesn't fire per keystroke
  const [label, setLabel] = useState(bay.label);
  const [width, setWidth] = useState(fmt(bay.width));
  const [depth, setDepth] = useState(fmt(bay.depth));
  useEffect(() => {
    setLabel(bay.label);
    setWidth(fmt(bay.width));
    setDepth(fmt(bay.depth));
  }, [bay.id, bay.label, bay.width, bay.depth]);

  // Console binding: the kind commits at once; a BLE console commits once its device code is typed
  const bayConsoleKind = bay.console?.kind ?? '';
  const bayCode = bay.console?.kind === 'ble' ? bay.console.code : '';
  const [consoleKind, setConsoleKind] = useState<'' | 'emulator' | 'ble'>(bayConsoleKind);
  const [code, setCode] = useState(bayCode);
  const [codeError, setCodeError] = useState<string | null>(null);
  useEffect(() => {
    setConsoleKind(bayConsoleKind);
    setCode(bayCode);
    setCodeError(null);
  }, [bay.id, bayConsoleKind, bayCode]);
  const commitCode = () => {
    const v = code.trim().toUpperCase();
    if (!v) return; // nothing typed yet: leave the field open
    if (!DEVICE_CODE_RE.test(v)) {
      setCodeError('A device code is 2–8 letters or digits, as printed on the console.');
      return;
    }
    setCodeError(null);
    if (v !== bayCode) onChange({ console: { kind: 'ble', code: v } });
  };

  const commitLabel = () => {
    const v = label.trim();
    if (v && v !== bay.label) onChange({ label: v });
    else setLabel(bay.label);
  };
  const commitSize = () => {
    const w = Number(width);
    const d = Number(depth);
    const patch: Partial<LabBay> = {};
    if (Number.isFinite(w) && w !== bay.width) patch.width = w;
    if (Number.isFinite(d) && d !== bay.depth) patch.depth = d;
    if (Object.keys(patch).length) onChange(patch);
    else {
      setWidth(fmt(bay.width));
      setDepth(fmt(bay.depth));
    }
  };
  const onEnter = (fn: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') fn();
  };

  // real-hardware bays run whatever is bolted to the rig — only that kind's models apply
  const kinds = real ? [real.kind] : MACHINE_KINDS;
  const byKind = (kind: MachineKind) => models.filter((m) => m.kind === kind);
  const machineValue = bay.machine ? bay.machine.model : '';
  const knownModel = models.some((m) => m.model === machineValue);

  return (
    <div className="lab-bay-detail">
      <div className="card-title row-between">
        <span>
          {bay.id}
          {real ? ` · real hardware (${real.source})` : ''}
          {bay.console ? ` · ${bay.console.kind === 'emulator' ? 'emulator console' : `BLE ${bay.console.code}`}` : ''}
        </span>
        {hasUnit && (
          <button className="btn tiny" onClick={onOpen} title="Fly into this unit">
            Open ▸
          </button>
        )}
      </div>

      <label className="field">
        <span>Label</span>
        <input
          type="text"
          value={label}
          maxLength={32}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={onEnter(() => setLabel(bay.label))}
        />
      </label>

      <label className="field">
        <span>Machine</span>
        <select
          value={machineValue}
          onChange={(e) => {
            const model = e.target.value;
            if (!model) {
              onChange({ machine: null });
              return;
            }
            const entry = models.find((m) => m.model === model);
            onChange({ machine: { kind: entry?.kind ?? real?.kind ?? 'treadmill', model } });
          }}
        >
          <option value="">— empty bay —</option>
          {machineValue && !knownModel && <option value={machineValue}>{machineValue} (no CAD)</option>}
          {kinds.map((kind) => {
            const list = byKind(kind);
            if (list.length === 0) return null;
            return (
              <optgroup key={kind} label={KIND_LABELS[kind]}>
                {list.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model}
                    {m.glbUrl ? '' : ' (proxy)'}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>

      {bay.machine && (
        <label
          className="check"
          title="International unit: its console or tablet displays km/h. Test runs launched from this bay work in that unit (matrices step in whole km/h). FP2 stays km/h on the wire either way."
        >
          <input
            type="checkbox"
            checked={bay.units === 'kph'}
            onChange={(e) => onChange({ units: e.target.checked ? 'kph' : undefined })}
          />
          Displays km/h (international unit)
        </label>
      )}

      {(!bay.machine || bay.machine.kind === 'treadmill') && (
        <div className="field">
          <span>Console</span>
          <select
            value={consoleKind}
            onChange={(e) => {
              const kind = e.target.value as '' | 'emulator' | 'ble';
              setConsoleKind(kind);
              setCodeError(null);
              if (kind === 'emulator') onChange({ console: { kind: 'emulator' } });
              else if (kind === '' && bay.console) onChange({ console: null });
              // 'ble' commits once a device code is entered
            }}
            title="FP2 console this bay commands through the TabletAutoTest FP2 gateway (:8102)"
          >
            <option value="">— none —</option>
            <option value="emulator">Emulator (Renode PM210)</option>
            <option value="ble">BLE console (by device code)</option>
          </select>
          {consoleKind === 'ble' && (
            <label className="field">
              <span>Device code (shown on the console)</span>
              <input
                type="text"
                value={code}
                placeholder="e.g. 1CSF"
                maxLength={8}
                autoFocus={!bayCode}
                spellCheck={false}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onBlur={commitCode}
                onKeyDown={onEnter(() => {
                  setCode(bayCode);
                  setCodeError(null);
                })}
              />
              {codeError && <div className="lab-error">{codeError}</div>}
            </label>
          )}
          <div className="lab-hint">
            {consoleKind === 'ble'
              ? `Pairs over BLE to the console advertising code ${code || '…'}. Needs the FP2 gateway running; link status shows in the unit's Console card.`
              : consoleKind === 'emulator'
                ? 'Needs the FP2 gateway and Renode running; the PM210 LCD renders in the unit view.'
                : 'Bind the Renode emulator or a real console so scenarios drive it over FP2.'}
          </div>
        </div>
      )}

      <div className="field">
        <span>Footprint (m)</span>
        <div className="size-presets">
          {SIZE_PRESETS.map((p) => (
            <button
              key={p.label}
              className={`btn tiny${p.width === bay.width && p.depth === bay.depth ? ' primary' : ''}`}
              onClick={() => onChange({ width: p.width, depth: p.depth })}
              title={`${p.width} × ${p.depth} m`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="size-row">
          <label className="field">
            <span>Width (across the row)</span>
            <input
              type="number"
              step={0.1}
              min={BAY_SIZE_MIN.width}
              max={BAY_SIZE_MAX.width}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              onBlur={commitSize}
              onKeyDown={onEnter(() => setWidth(fmt(bay.width)))}
            />
          </label>
          <label className="field">
            <span>Depth (front to back)</span>
            <input
              type="number"
              step={0.1}
              min={BAY_SIZE_MIN.depth}
              max={BAY_SIZE_MAX.depth}
              value={depth}
              onChange={(e) => setDepth(e.target.value)}
              onBlur={commitSize}
              onKeyDown={onEnter(() => setDepth(fmt(bay.depth)))}
            />
          </label>
        </div>
      </div>

      <div className="detail-actions">
        <button className="btn tiny" onClick={() => onMove(-1)} title="Move one bay back (wraps into the previous row)">
          ◀
        </button>
        <button className="btn tiny" onClick={() => onMove(1)} title="Move one bay forward (wraps into the next row)">
          ▶
        </button>
        <span className="spacer" />
        {bay.machine && (
          <button className="btn tiny" onClick={() => onChange({ machine: null })} title="Leave the bay empty">
            Clear machine
          </button>
        )}
        <button className="btn tiny danger" onClick={onRemove} title="Remove this bay from the floor">
          Remove bay
        </button>
      </div>
    </div>
  );
}
