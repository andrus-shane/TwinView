import { useEffect, useState } from 'react';
import { getPanelMap, panelSchema, pressKey, type PanelMap } from '../scene/pm210Lcd';

/** Preferred column order; sections come from the map itself (PM210: workout, no media; IF17/IF20: media, no workout) */
const ORDER = ['transport', 'speed', 'incline', 'media', 'workout'];
const rank = (sec: string): number => (ORDER.includes(sec) ? ORDER.indexOf(sec) : ORDER.length);

/**
 * Emulator membrane keys rendered straight from the panel map (labels included —
 * the quick-incline column has no "Incline 1", so never position-map). Press-only:
 * the server does down/150 ms/up, so a closed tab can never leave a key latched.
 */
export function ConsoleKeys({ unitId }: { unitId: string }) {
  const [pm, setPm] = useState<PanelMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPm(null);
    setError(null);
    getPanelMap(unitId).then(setPm).catch((e: Error) => setError(e.message));
  }, [unitId]);

  if (!pm) return error ? <div className="auto-note">{error}</div> : null;
  if (panelSchema(pm) === 'unsupported') return <div className="auto-note">console keys not supported (bike)</div>;
  const secs = [...new Set(pm.keys.map((k) => k.sec ?? 'keys'))].sort((a, b) => rank(a) - rank(b));
  return (
    <div className="console-keys" style={{ gridTemplateColumns: `repeat(${secs.length}, 1fr)` }}>
      {secs.map((sec) => (
        <div className="col" key={sec}>
          <h5>{sec}</h5>
          {pm.keys
            .filter((k) => (k.sec ?? 'keys') === sec)
            .map((k) => (
              <button
                className="btn"
                key={`${k.index}:${k.mask}`}
                onClick={() => pressKey(unitId, k.index, k.mask).catch((e: Error) => setError(e.message))}
              >
                {k.label}
              </button>
            ))}
        </div>
      ))}
      {error && <div className="auto-note">{error}</div>}
    </div>
  );
}
