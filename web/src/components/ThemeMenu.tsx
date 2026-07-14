import { useEffect, useRef, useState } from 'react';
import { VIEWPORT_PRESETS, viewportCss, type Theme } from '../theme';

interface Props {
  theme: Theme;
  viewport: string;
  onTheme: (t: Theme) => void;
  onViewport: (v: string) => void;
}

export function ThemeMenu({ theme, viewport, onTheme, onViewport }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const custom = viewport.startsWith('#');
  return (
    <div className="theme-menu" ref={rootRef}>
      <button className="btn small" onClick={() => setOpen(!open)} title="Theme & colors">
        {theme === 'dark' ? '☾' : '☀'}
        <span className="theme-chip" style={{ background: viewportCss(viewport, theme) }} />
      </button>
      {open && (
        <div className="theme-pop">
          <div className="card-title">Panels</div>
          <div className="seg">
            <button className={`seg-btn ${theme === 'light' ? 'active' : ''}`} onClick={() => onTheme('light')}>
              ☀ Light
            </button>
            <button className={`seg-btn ${theme === 'dark' ? 'active' : ''}`} onClick={() => onTheme('dark')}>
              ☾ Dark
            </button>
          </div>
          <div className="card-title sub">3D viewport</div>
          <div className="swatches">
            <button
              className={`swatch swatch-auto ${viewport === 'auto' ? 'active' : ''}`}
              title="Match panels"
              onClick={() => onViewport('auto')}
            />
            {VIEWPORT_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`swatch ${viewport === p.id ? 'active' : ''}`}
                style={{ background: p.css }}
                title={p.label}
                onClick={() => onViewport(p.id)}
              />
            ))}
            <label
              className={`swatch swatch-custom ${custom ? 'active' : ''}`}
              title="Custom color…"
              style={custom ? { background: viewport } : undefined}
            >
              <input type="color" value={custom ? viewport : '#3a4656'} onChange={(e) => onViewport(e.target.value)} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
