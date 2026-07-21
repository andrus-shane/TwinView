import { useEffect, useRef, useState } from 'react';
import { CHANNELS_BY_KIND } from '@twinview/shared';
import { BindDialog } from './components/BindDialog';
import { Breadcrumb } from './components/Breadcrumb';
import { ComponentInspector } from './components/ComponentInspector';
import { Controls } from './components/Controls';
import { EventLog } from './components/EventLog';
import { FleetPanel } from './components/FleetPanel';
import { GaugeCard } from './components/GaugeCard';
import { LabDashboard } from './components/LabDashboard';
import { LayersPanel } from './components/LayersPanel';
import { PartsPanel } from './components/PartsPanel';
import { ThemeMenu } from './components/ThemeMenu';
import { AdbScreen } from './scene/adbScreen';
import { FALLBACK_RIG } from './scene/fallback';
import { MockConsole } from './scene/mockConsole';
import { Viewer } from './scene/viewer';
import { useStore, viewLevel } from './state/store';
import { connectWs } from './state/ws';
import { applyTheme, initialTheme, initialViewport, saveViewport, viewportCss, type Theme } from './theme';

interface ScreenDevice {
  serial: string;
  product: string;
  model: string;
}

export function App() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const screenHost = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const mockRef = useRef<MockConsole | null>(null);
  // lab wall: one low-spec live stream per tablet-mapped bay, keyed by unit id
  const labScreensRef = useRef<Map<string, AdbScreen>>(new Map());
  const [screens, setScreens] = useState<ScreenDevice[]>([]);
  // ?screen=<serial> preselects a live console (kiosk/demo links)
  const [consoleSource, setConsoleSource] = useState(
    () => new URLSearchParams(location.search).get('screen') ?? 'mock',
  );
  const connected = useStore((s) => s.connected);
  const units = useStore((s) => s.units);
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const selectedNode = useStore((s) => s.selectedNode);
  const modelInfo = useStore((s) => s.modelInfo);
  const models = useStore((s) => s.models);
  const hoverRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [viewport, setViewport] = useState<string>(initialViewport);

  const level = viewLevel({ focusedUnitId, selectedNode });
  const focusedUnit = units.find((u) => u.id === focusedUnitId);

  useEffect(() => {
    const viewer = new Viewer();
    viewerRef.current = viewer;
    const mockConsole = new MockConsole();
    mockRef.current = mockConsole;
    viewer.setConsoleCanvas(mockConsole.canvas);
    viewer.mount(canvasHost.current!);

    viewer.onSelectUnit = (id) => useStore.getState().focusUnit(id);
    viewer.onSelectPart = (name) => useStore.getState().select(name);
    viewer.onHover = (text) => {
      const el = hoverRef.current;
      if (el) {
        el.textContent = text ?? '';
        el.style.opacity = text ? '1' : '0';
      }
    };
    viewer.onModelReady = (names, groupSeeds, isCad) => {
      const store = useStore.getState();
      store.setPartNames(names);
      const focused = store.units.find((u) => u.id === store.focusedUnitId);
      if (isCad && groupSeeds.length > 0 && focused) {
        void store.seedGroups(focused.model, groupSeeds);
      }
      // Fresh install without CAD: seed the proxy's ready-made bindings once.
      // Sequential — concurrent rig PUTs land out of order and drop bindings.
      // (Treadmill only: the rig store is model-scoped and rower/elliptical
      // proxies carry their own built-in rig.)
      if (!isCad && store.rig.bindings.length === 0 && (focused?.kind ?? 'treadmill') === 'treadmill') {
        void (async () => {
          for (const b of FALLBACK_RIG.bindings) await store.saveBinding(b);
        })();
      }
    };

    const store = useStore.getState();
    void store
      .init()
      .then(() => {
        const { models, rigs, units } = useStore.getState();
        viewer.applyRigs(rigs);
        viewer.setModels(models);
        viewer.setFleet(units);
      })
      .catch((e) => console.error('init failed:', e));

    connectWs();

    const unsub = useStore.subscribe((s, prev) => {
      if (s.units !== prev.units) {
        viewer.setFleet(s.units);
        // focused unit vanished from the roster → back to the lab overview
        if (s.focusedUnitId && !s.units.some((u) => u.id === s.focusedUnitId)) {
          s.focusUnit(null);
        }
      }
      if (s.states !== prev.states) viewer.applyStates(s.states);
      if (s.rigs !== prev.rigs) viewer.applyRigs(s.rigs);
      // order matters: focus change first — it clears selection/isolate itself
      if (s.focusedUnitId !== prev.focusedUnitId) viewer.focusUnit(s.focusedUnitId);
      if (s.selectedNode !== prev.selectedNode) {
        viewer.setSelected(s.selectedNode);
        if (s.selectedNode) {
          viewer.focusPart(s.selectedNode);
          viewer.setIsolate(s.isolateOn ? s.selectedNode : null);
        } else {
          viewer.setIsolate(null);
          if (s.focusedUnitId) viewer.reframeUnit();
        }
      } else if (s.isolateOn !== prev.isolateOn) {
        viewer.setIsolate(s.isolateOn && s.selectedNode ? s.selectedNode : null);
      }
      if (s.twin !== prev.twin && s.twin) {
        const kind = s.units.find((u) => u.id === s.focusedUnitId)?.kind ?? 'treadmill';
        mockConsole.draw(s.twin, kind);
      }
    });

    // Esc walks back up: component → unit → lab
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const st = useStore.getState();
      if (st.bindDialogOpen) st.setBindDialogOpen(false);
      else if (st.selectedNode) st.select(null);
      else if (st.focusedUnitId) st.focusUnit(null);
    };
    window.addEventListener('keydown', onKey);

    return () => {
      unsub();
      window.removeEventListener('keydown', onKey);
      // lab streams are wired to this viewer's bays — they die with it, and the
      // manager effect below rebuilds them from an empty map on remount
      for (const scr of labScreensRef.current.values()) scr.dispose();
      labScreensRef.current.clear();
      viewer.dispose();
      mockConsole.canvas.remove();
    };
  }, []);

  // Runs after the mount effect above, so the viewer exists on first pass.
  useEffect(() => {
    applyTheme(theme);
    saveViewport(viewport);
    viewerRef.current?.setBackground(viewportCss(viewport, theme));
  }, [theme, viewport]);

  const refreshScreens = () =>
    void fetch('/api/screens')
      .then((r) => r.json())
      .then(setScreens)
      .catch(() => setScreens([]));
  useEffect(refreshScreens, []);

  // Focusing a bay with a mapped tablet shows that tablet at full quality;
  // unmapped bays fall back to the mock twin console.
  useEffect(() => {
    if (!focusedUnitId) return;
    const unit = useStore.getState().units.find((u) => u.id === focusedUnitId);
    setConsoleSource(unit?.screenSerial ?? 'mock');
  }, [focusedUnitId]);

  // Lab wall: one low-spec stream per tablet-mapped bay. The focused unit is
  // excluded — its device runs the full-quality pipeline below instead.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const labScreens = labScreensRef.current;
    const want = new Map<string, string>();
    for (const u of units) {
      if (u.screenSerial && u.id !== focusedUnitId) want.set(u.id, u.screenSerial);
    }
    for (const [id, scr] of [...labScreens]) {
      if (want.get(id) !== scr.serial) {
        scr.dispose();
        labScreens.delete(id);
        viewer.setBayConsole(id, null);
      }
    }
    let delay = 0;
    for (const [id, serial] of want) {
      let scr = labScreens.get(id);
      if (!scr) {
        scr = new AdbScreen(serial, { profile: 'lab', reconnect: true });
        labScreens.set(id, scr);
        // stagger session starts — 20 simultaneous jar pushes would slam adb
        const s = scr;
        setTimeout(() => s.connect(), delay);
        delay += 250;
      }
      // idempotent: re-asserts wiring after bay roster rebuilds, no-op otherwise
      viewer.setBayConsole(id, scr.canvas);
    }
  }, [units, focusedUnitId]);

  // Console source: the sidebar card and the 3D screen texture share one canvas
  useEffect(() => {
    const viewer = viewerRef.current;
    const mock = mockRef.current;
    const host = screenHost.current;
    if (!viewer || !mock) return;
    // no live session at lab level — the bay's own low-spec stream covers it
    if (consoleSource === 'mock' || level === 'lab') {
      host?.replaceChildren(mock.canvas);
      viewer.setConsoleCanvas(mock.canvas);
      return;
    }
    const live = new AdbScreen(consoleSource);
    live.connect();
    host?.replaceChildren(live.canvas);
    viewer.setConsoleCanvas(live.canvas);
    return () => live.dispose();
    // re-attach the canvas when the screen card remounts at a different level
  }, [consoleSource, level]);

  const modelName = modelInfo?.model ?? 'NTL99925';
  const hasCad = (model: string | undefined) => !!models.find((m) => m.model === model)?.glbUrl;
  // the floor can hold a mix of machines — badge shows each model's headcount
  const modelMix = [...units.reduce((m, u) => m.set(u.model, (m.get(u.model) ?? 0) + 1), new Map<string, number>())]
    .map(([model, n]) => `${n}× ${model}${hasCad(model) ? ' (CAD)' : ''}`)
    .join(' · ');
  const focusedHasCad = hasCad(focusedUnit?.model);
  const modelBadge =
    level === 'lab'
      ? `${units.length} units${modelMix ? ` · ${modelMix}` : ` · ${modelName}`}`
      : `${focusedUnit?.label ?? ''} · ${focusedUnit?.serial ?? ''} · ${focusedUnit?.model ?? ''}${focusedHasCad ? ' · CAD' : ''}`;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">◈</span> TwinView
          <span className="brand-sub">Digital Twin QA Lab</span>
        </div>
        <div className="header-right">
          {models.length > 1 && (
            <select
              className="model-select"
              value={modelName}
              onChange={(e) => useStore.getState().selectModel(e.target.value)}
              title="Machine model — switching reloads the lab with that model's CAD and rig"
            >
              {!models.some((m) => m.model === modelName) && (
                <option value={modelName}>{modelName} (missing)</option>
              )}
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.model}
                  {m.glbUrl ? '' : ' (no CAD yet)'}
                </option>
              ))}
            </select>
          )}
          <span className="model-badge">{modelBadge}</span>
          <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? '● live' : '○ offline'}</span>
          <ThemeMenu theme={theme} viewport={viewport} onTheme={setTheme} onViewport={setViewport} />
        </div>
      </header>

      <aside className="left">
        {level === 'lab' ? (
          <FleetPanel />
        ) : (
          <>
            <LayersPanel />
            <PartsPanel onFocus={() => {}} />
          </>
        )}
      </aside>

      <main className="center">
        <div className="viewport" ref={canvasHost}>
          <Breadcrumb />
          <div className="hover-tip" ref={hoverRef} />
          <BindDialog />
        </div>
        <EventLog />
      </main>

      <aside className="right">
        {level === 'lab' && <LabDashboard />}
        {level === 'unit' && (
          <>
            <Controls />
            <div className="card screen-card">
              <div className="card-title screen-title">
                <span>Console Screen</span>
                <span className="screen-src">
                  <select value={consoleSource} onChange={(e) => setConsoleSource(e.target.value)}>
                    <option value="mock">Mock (twin)</option>
                    {screens.map((d) => (
                      <option key={d.serial} value={d.serial} title={d.serial}>
                        {d.product || d.model || 'device'} · …{d.serial.slice(-6)}
                      </option>
                    ))}
                  </select>
                  <button className="btn" onClick={refreshScreens} title="Rescan adb devices">
                    ↻
                  </button>
                </span>
              </div>
              <div className="screen-host" ref={screenHost} />
            </div>
            {CHANNELS_BY_KIND[focusedUnit?.kind ?? 'treadmill'].map((id) => (
              <GaugeCard key={id} id={id} />
            ))}
          </>
        )}
        {level === 'component' && <ComponentInspector />}
      </aside>
    </div>
  );
}
