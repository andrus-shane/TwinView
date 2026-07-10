import { useMemo, useState } from 'react';
import type { ChannelStatus } from '@twinview/shared';
import { useStore } from '../state/store';

function bindingStatus(nodeName: string): ChannelStatus | null {
  const { rig, twin } = useStore.getState();
  const b = rig.bindings.find((x) => x.nodeName === nodeName);
  if (!b || !twin || b.channels.length === 0) return null;
  const rank = { ok: 0, stale: 1, warn: 2, fail: 3 };
  let worst: ChannelStatus = 'ok';
  for (const ch of b.channels) {
    const s = twin.channels[ch]?.status ?? 'ok';
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

export function PartsPanel({ onFocus }: { onFocus: (name: string) => void }) {
  const partNames = useStore((s) => s.partNames);
  const rig = useStore((s) => s.rig);
  const selected = useStore((s) => s.selectedNode);
  const select = useStore((s) => s.select);
  useStore((s) => s.twin?.t); // re-render for status dots
  const [q, setQ] = useState('');

  const bound = rig.bindings.map((b) => b.nodeName);
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return partNames.filter((n) => !needle || n.toLowerCase().includes(needle)).slice(0, 400);
  }, [partNames, q]);

  const pick = (name: string) => {
    select(name);
    onFocus(name);
  };

  return (
    <div className="parts-panel">
      <div className="card-title">Components ({partNames.length})</div>
      <input
        className="search"
        placeholder="Search parts…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {bound.length > 0 && (
        <>
          <div className="card-title sub">Instrumented</div>
          {rig.bindings.map((b) => {
            const st = bindingStatus(b.nodeName);
            const missing = partNames.length > 0 && !partNames.includes(b.nodeName);
            return (
              <div
                key={b.nodeName}
                className={`part-row bound ${selected === b.nodeName ? 'selected' : ''} ${missing ? 'missing' : ''}`}
                title={missing ? 'Part not present in the loaded model — re-bind or remove' : undefined}
                onClick={() => pick(b.nodeName)}
              >
                {st && !missing && <span className={`dot dot-${st}`} />}
                {(!st || missing) && <span className="dot dot-none" />}
                <span className="part-name">{b.nodeName}</span>
                <span className="part-meta">
                  {missing ? 'not in model' : `${b.role ?? ''}${b.channels.length > 0 ? ` · ${b.channels.length} ch` : ''}`}
                </span>
              </div>
            );
          })}
        </>
      )}

      <div className="card-title sub">All parts</div>
      <div className="part-list">
        {filtered.map((n) => (
          <div
            key={n}
            className={`part-row ${selected === n ? 'selected' : ''} ${bound.includes(n) ? 'is-bound' : ''}`}
            onClick={() => pick(n)}
          >
            <span className="part-name">{n}</span>
          </div>
        ))}
        {filtered.length === 0 && <div className="muted">No matches</div>}
      </div>
    </div>
  );
}
