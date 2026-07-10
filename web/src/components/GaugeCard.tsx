import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { ChannelId } from '@twinview/shared';
import { chartHistory, useStore } from '../state/store';

const STATUS_LABEL: Record<string, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL', stale: 'NO DATA' };

export function GaugeCard({ id }: { id: ChannelId }) {
  const ch = useStore((s) => s.twin?.channels[id]);
  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const u = new uPlot(
      {
        width: el.clientWidth || 280,
        height: 64,
        cursor: { show: false },
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [{ show: false }, { show: false }],
        series: [
          {},
          { stroke: '#4ea1ff', width: 1.5, dash: [5, 4] }, // expected
          { stroke: '#37e0a0', width: 1.5 }, // measured
        ],
      },
      [[], [], []],
      el,
    );
    plotRef.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth || 280, height: 64 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, []);

  useEffect(() => {
    const h = chartHistory[id];
    plotRef.current?.setData([h.t, h.cmd, h.meas]);
  });

  const status = ch?.status ?? 'stale';
  const dev = ch ? ch.meas - ch.cmd : 0;
  return (
    <div className={`gauge status-border-${status}`}>
      <div className="gauge-head">
        <span className="gauge-title">{ch?.label ?? id}</span>
        <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <div className="gauge-values">
        <div>
          <div className="gauge-num expected">{ch ? ch.cmd.toFixed(2) : '—'}</div>
          <div className="gauge-sub">expected {ch?.unit ?? ''}</div>
        </div>
        <div>
          <div className="gauge-num measured">{ch ? ch.meas.toFixed(2) : '—'}</div>
          <div className="gauge-sub">measured {ch?.unit ?? ''}</div>
        </div>
        <div>
          <div className={`gauge-num dev-${status}`}>{ch ? `${dev >= 0 ? '+' : ''}${dev.toFixed(2)}` : '—'}</div>
          <div className="gauge-sub">Δ {ch ? `(warn ±${ch.warnTol})` : ''}</div>
        </div>
      </div>
      <div ref={chartRef} className="gauge-chart" />
    </div>
  );
}
