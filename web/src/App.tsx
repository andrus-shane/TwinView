import { useEffect, useRef, useState } from 'react';
import { CHANNEL_IDS } from '@twinview/shared';
import { BindDialog } from './components/BindDialog';
import { Controls } from './components/Controls';
import { EventLog } from './components/EventLog';
import { GaugeCard } from './components/GaugeCard';
import { LayersPanel } from './components/LayersPanel';
import { PartsPanel } from './components/PartsPanel';
import { FALLBACK_RIG } from './scene/fallback';
import { MockConsole } from './scene/mockConsole';
import { Viewer } from './scene/viewer';
import { useStore } from './state/store';
import { connectWs } from './state/ws';

export function App() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const screenHost = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [modelLabel, setModelLabel] = useState('loading…');
  const connected = useStore((s) => s.connected);
  const hoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewer = new Viewer();
    viewerRef.current = viewer;
    const mockConsole = new MockConsole();
    viewer.setConsoleCanvas(mockConsole.canvas);
    viewer.mount(canvasHost.current!);
    screenHost.current?.appendChild(mockConsole.canvas);

    viewer.onSelect = (name) => useStore.getState().select(name);
    viewer.onHover = (name) => {
      const el = hoverRef.current;
      if (el) {
        el.textContent = name ?? '';
        el.style.opacity = name ? '1' : '0';
      }
    };

    const store = useStore.getState();
    void store
      .init()
      .then(async () => {
        const { modelInfo, rig } = useStore.getState();
        const glbUrl = modelInfo?.glbUrl ?? null;
        setModelLabel(glbUrl ? 'NTL99925 (CAD)' : 'placeholder model (CAD converting)');
        const names = await viewer.loadModel(glbUrl);
        store.setPartNames(names);
        // First run against the fallback model: apply its ready-made bindings
        if (!glbUrl && rig.bindings.length === 0) {
          for (const b of FALLBACK_RIG.bindings) await store.saveBinding(b);
        }
        // First run against the CAD model: seed visibility layers from materials
        if (glbUrl) await store.seedGroups(viewer.getGroupSeeds());
        viewer.applyRig(useStore.getState().rig);
      })
      .catch((e) => setModelLabel(`model load failed: ${e.message}`));

    connectWs();

    const unsub = useStore.subscribe((s, prev) => {
      if (s.twin && s.twin !== prev.twin) {
        viewer.applyState(s.twin);
        mockConsole.draw(s.twin);
      }
      if (s.rig !== prev.rig) viewer.applyRig(s.rig);
      if (s.selectedNode !== prev.selectedNode) viewer.setSelected(s.selectedNode);
    });

    return () => {
      unsub();
      viewer.dispose();
      mockConsole.canvas.remove();
    };
  }, []);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">◈</span> TwinView
          <span className="brand-sub">Digital Twin QA</span>
        </div>
        <div className="header-right">
          <span className="model-badge">{modelLabel}</span>
          <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? '● live' : '○ offline'}</span>
        </div>
      </header>

      <aside className="left">
        <LayersPanel />
        <PartsPanel onFocus={(n) => viewerRef.current?.focusOn(n)} />
      </aside>

      <main className="center">
        <div className="viewport" ref={canvasHost}>
          <div className="hover-tip" ref={hoverRef} />
          <BindDialog />
        </div>
        <EventLog />
      </main>

      <aside className="right">
        <Controls />
        <div className="card screen-card">
          <div className="card-title">Console Screen (mock · ADB later)</div>
          <div className="screen-host" ref={screenHost} />
        </div>
        {CHANNEL_IDS.map((id) => (
          <GaugeCard key={id} id={id} />
        ))}
      </aside>
    </div>
  );
}
