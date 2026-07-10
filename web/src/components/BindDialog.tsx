import { useEffect, useState } from 'react';
import {
  CHANNEL_IDS,
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
};

/** Shown when a part is selected: attach a sensor channel and/or rig role. */
export function BindDialog() {
  const selected = useStore((s) => s.selectedNode);
  const rig = useStore((s) => s.rig);
  const { saveBinding, removeBinding, select } = useStore.getState();

  const existing = rig.bindings.find((b) => b.nodeName === selected);
  const [role, setRole] = useState<RigRole | ''>('');
  const [channels, setChannels] = useState<ChannelId[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    setRole(existing?.role ?? '');
    setChannels(existing?.channels ?? []);
    setNote(existing?.sensor?.note ?? '');
  }, [selected]);

  if (!selected) return null;

  const toggleChannel = (c: ChannelId) =>
    setChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <div className="bind-dialog card">
      <div className="card-title row-between">
        <span title={selected}>{selected.length > 30 ? `${selected.slice(0, 30)}…` : selected}</span>
        <button className="btn small" onClick={() => select(null)}>
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
      </label>

      <div className="field">
        <span>Sensor channels (mock — swap to USB serial later)</span>
        {CHANNEL_IDS.map((c) => (
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

      <div className="row">
        <button
          className="btn primary"
          onClick={() =>
            void saveBinding({
              nodeName: selected,
              role: role || undefined,
              channels,
              sensor: { kind: 'mock', note: note || undefined },
            })
          }
        >
          Save binding
        </button>
        {existing && (
          <button className="btn danger" onClick={() => void removeBinding(selected)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
