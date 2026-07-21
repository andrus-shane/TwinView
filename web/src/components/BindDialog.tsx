import { useEffect, useState } from 'react';
import {
  CHANNELS_BY_KIND,
  RIG_ROLES,
  ROLE_LABELS,
  type ChannelId,
  type RigRole,
} from '@twinview/shared';
import { useStore } from '../state/store';

const CHANNEL_LABELS: Record<ChannelId, string> = {
  belt_speed: 'Belt speed (tachometer)',
  incline: 'Incline (inclinometer)',
  motor_current: 'Motor current (clamp)',
  vibration: 'Vibration (IMU)',
  stroke_rate: 'Stroke rate (position encoder)',
  flywheel_speed: 'Flywheel speed (optical tach)',
  drive_power: 'Drive power (load cell)',
  resistance: 'Resistance (servo encoder)',
  stride_rate: 'Stride rate (crank cadence)',
  rep_rate: 'Rep cadence (carriage encoder)',
  carriage_travel: 'Carriage travel (rail strip)',
};

/** Shown when a part is selected: attach a sensor channel and/or rig role. */
export function BindDialog() {
  const selected = useStore((s) => s.selectedNode);
  const open = useStore((s) => s.bindDialogOpen);
  const rig = useStore((s) => s.rig);
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const units = useStore((s) => s.units);
  const { saveBinding, removeBinding, setBindDialogOpen, setPartGroup } = useStore.getState();
  // only offer the focused machine kind's sensor channels
  const kind = units.find((u) => u.id === focusedUnitId)?.kind ?? 'treadmill';
  const partGroup = selected ? rig.groups?.find((g) => g.parts.includes(selected))?.name ?? '' : '';

  const existing = rig.bindings.find((b) => b.nodeName === selected);
  const [role, setRole] = useState<RigRole | ''>('');
  const [channels, setChannels] = useState<ChannelId[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    setRole(existing?.role ?? '');
    setChannels(existing?.channels ?? []);
    setNote(existing?.sensor?.note ?? '');
  }, [selected]);

  if (!selected || !open) return null;

  const toggleChannel = (c: ChannelId) =>
    setChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <div className="bind-dialog card">
      <div className="card-title row-between">
        <span title={selected}>{selected.length > 30 ? `${selected.slice(0, 30)}…` : selected}</span>
        <button className="btn small" onClick={() => setBindDialogOpen(false)}>
          ✕
        </button>
      </div>

      <label className="field">
        <span>Twin role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as RigRole | '')}>
          <option value="">— none —</option>
          {RIG_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, opacity: 0.65 }}>
          Role animates the part in 3D (belt scroll, deck tilt, screen feed). Channels only color it by status.
        </span>
      </label>

      <div className="field">
        <span>Sensor channels (mock — swap to USB serial later)</span>
        {CHANNELS_BY_KIND[kind].map((c) => (
          <label key={c} className="check">
            <input type="checkbox" checked={channels.includes(c)} onChange={() => toggleChannel(c)} />
            {CHANNEL_LABELS[c]}
          </label>
        ))}
      </div>

      <label className="field">
        <span>Sensor note</span>
        <input value={note} placeholder="e.g. hall sensor on front roller" onChange={(e) => setNote(e.target.value)} />
      </label>

      {(rig.groups?.length ?? 0) > 0 && (
        <label className="field">
          <span>Visibility layer</span>
          <select value={partGroup} onChange={(e) => void setPartGroup(selected, e.target.value || null)}>
            <option value="">— ungrouped —</option>
            {rig.groups!.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="row">
        <button
          className="btn primary"
          onClick={() => {
            void saveBinding({
              nodeName: selected,
              role: role || undefined,
              channels,
              sensor: { kind: 'mock', note: note || undefined },
              // attach lists are authored in the rig JSON — carry them through UI edits
              attach: existing?.attach,
            });
            setBindDialogOpen(false);
          }}
        >
          Save binding
        </button>
        {existing && (
          <button
            className="btn danger"
            onClick={() => {
              void removeBinding(selected);
              setBindDialogOpen(false);
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
