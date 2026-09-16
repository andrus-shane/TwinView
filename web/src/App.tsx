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
import { LabEditor } from './components/LabEditor';
import { LayersPanel } from './components/LayersPanel';
import { PartsPanel } from './components/PartsPanel';
import { SafetyBanner } from './components/SafetyBanner';
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
  /** Hardware serial, present when `serial` is a network endpoint (Pi USB bridge) */
  hwSerial?: string;
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
  // Tap-through: clicks on the live console (3D screen or 2D card) become real
  // taps on the tablet. Explicit opt-in — it can press physical-machine controls.
  const [tapThrough, setTapThrough] = useState(false);
  const liveScreenRef = useRef<AdbScreen | null>(null);
  // mount-effect handlers can't close over state (same reason as useStore.getState())
  const tapRef = useRef({ armed: false, serial: 'mock' });
  // 2D card gesture in progress: pointerdown → pointerup becomes tap or swipe
  const cardDragRef = useRef<{ id: number; x: number; y: number; t: number; u: number; v: number } | null>(null);
  const connected = useStore((s) => s.connected);
  const units = useStore((s) => s.units);
  // stable string so the 10 Hz state ticks don't re-render the whole app
  const presentChannels = useStore((s) =>
    s.twin ? Object.keys(s.twin.channels).sort().join(',') : null,
  );
  const focusedUnitId = useStore((s) => s.focusedUnitId);
  const selectedNode = useStore((s) => s.selectedNode);
  const fullscreen = useStore((s) => s.fullscreen);
  const modelInfo = useStore((s) => s.modelInfo);
  const models = useStore((s) => s.models);
  const labEditing = useStore((s) => s.labEditing);
  const emptyBays = useStore((s) =>
    s.lab ? s.lab.rows.reduce((n, r) => n + r.bays.filter((b) => !b.machine).length, 0) : 0,
  );
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
    // an empty bay (or any bay while editing) opens the floor editor on that bay
    viewer.onSelectBay = (id) => {
      const st = useStore.getState();
      if (!st.labEditing) st.setLabEditing(true);
      st.selectBay(id);
    };
    viewer.onSelectPart = (name) => useStore.getState().select(name);
    viewer.onScreenTap = (u, v) => sendTapRef.current(u, v);
    viewer.onScreenSwipe = (u1, v1, u2, v2, durMs) => sendSwipeRef.current(u1, v1, u2, v2, durMs);
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
        const { models, rigs, units, lab } = useStore.getState();
        viewer.applyRigs(rigs);
        viewer.setModels(models);
        viewer.setLab(lab);
        viewer.setFleet(units);
      })
      .catch((e) => console.error('init failed:', e));

    connectWs();

    const unsub = useStore.subscribe((s, prev) => {
      if (s.lab !== prev.lab) viewer.setLab(s.lab);
      if (s.labEditing !== prev.labEditing || s.editBayId !== prev.editBayId) {
        viewer.setEditMode(s.labEditing, s.editBayId);
      }
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

    // Esc walks back up: full screen → component → unit → lab. `f` toggles full screen.
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.key.toLowerCase() === 'f' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        st.setFullscreen(!st.fullscreen);
        return;
      }
      if (e.key !== 'Escape') return;
      if (st.bindDialogOpen) st.setBindDialogOpen(false);
      else if (st.fullscreen) st.setFullscreen(false);
      else if (st.labEditing) st.setLabEditing(false);
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

  // Full screen: CSS hides the chrome; native fullscreen is best-effort on top
  // (fails silently in iframes without allowfullscreen). Browser-side exits
  // (Esc, F11) sync back through fullscreenchange.
  useEffect(() => {
    if (fullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!fullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [fullscreen]);
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) useStore.getState().setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

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
    liveScreenRef.current = live;
    live.connect();
    host?.replaceChildren(live.canvas);
    viewer.setConsoleCanvas(live.canvas);
    return () => {
      liveScreenRef.current = null;
      live.dispose();
    };
    // re-attach the canvas when the screen card remounts at a different level
  }, [consoleSource, level]);

  // safety: never keep tap mode armed across a source or unit switch
  useEffect(() => setTapThrough(false), [consoleSource, focusedUnitId]);

  // Arm/disarm tap-through on the viewer and keep the mount-wired handler's
  // view current. Gated to unit level — that's where the toggle lives.
  useEffect(() => {
    const armed = tapThrough && consoleSource !== 'mock' && level === 'unit';
    tapRef.current = { armed, serial: consoleSource };
    viewerRef.current?.setScreenInteract(armed);
    return () => viewerRef.current?.setScreenInteract(false);
  }, [tapThrough, consoleSource, level]);

  // Reads refs only, so the instance captured by the mount effect stays valid.
  const sendInput = (kind: 'tap' | 'swipe', body: Record<string, number>) => {
    const { armed, serial } = tapRef.current;
    const live = liveScreenRef.current;
    if (!armed || serial === 'mock' || !live?.hasVideo) return;
    void fetch(`/api/screens/${encodeURIComponent(serial)}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, w: live.canvas.width, h: live.canvas.height }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const err = (await r.json().catch(() => ({}))) as { error?: string };
          console.warn(`${kind} failed:`, err.error ?? `HTTP ${r.status}`);
        }
      })
      .catch((e) => console.warn(`${kind} failed:`, e));
  };
  const sendTap = (u: number, v: number) => sendInput('tap', { u, v });
  const sendSwipe = (u1: number, v1: number, u2: number, v2: number, durMs: number) =>
    sendInput('swipe', { u1, v1, u2, v2, durMs });
  const sendTapRef = useRef(sendTap);
  sendTapRef.current = sendTap;
  const sendSwipeRef = useRef(sendSwipe);
  sendSwipeRef.current = sendSwipe;

  // 2D card position → normalized screen space, clamped so a drag that runs
  // off the card still ends at the screen edge it left through.
  const cardUV = (cx: number, cy: number) => {
    const canvas = liveScreenRef.current?.canvas;
    if (!canvas || !canvas.isConnected) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      u: Math.min(Math.max((cx - rect.left) / rect.width, 0), 1),
      v: Math.min(Math.max((cy - rect.top) / rect.height, 0), 1),
    };
  };

  const modelName = modelInfo?.model ?? 'NTL99925';
  const hasCad = (model: string | undefined) => !!models.find((m) => m.model === model)?.glbUrl;
  // the floor can hold a mix of machines — badge shows each model's headcount
  const modelMix = [...units.reduce((m, u) => m.set(u.model, (m.get(u.model) ?? 0) + 1), new Map<string, number>())]
    .map(([model, n]) => `${n}× ${model}${hasCad(model) ? ' (CAD)' : ''}`)
    .join(' · ');
  const focusedHasCad = hasCad(focusedUnit?.model);
  const modelBadge =
    level === 'lab'
      ? `${units.length} units${emptyBays ? ` · ${emptyBays} empty bay${emptyBays > 1 ? 's' : ''}` : ''}${modelMix ? ` · ${modelMix}` : ` · ${modelName}`}`
      : `${focusedUnit?.label ?? ''} · ${focusedUnit?.serial ?? ''} · ${focusedUnit?.model ?? ''}${focusedHasCad ? ' · CAD' : ''}`;

  return (
    <div className={`app${fullscreen ? ' fullscreen' : ''}`}>
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
          labEditing ? <LabEditor /> : <FleetPanel />
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
          <SafetyBanner />
          <div className="hover-tip" ref={hoverRef} />
          <BindDialog />
          <button
            className="fs-toggle"
            onClick={() => useStore.getState().setFullscreen(!fullscreen)}
            title={fullscreen ? 'Exit full screen (Esc or f)' : 'Full screen (f)'}
          >
            ⛶
          </button>
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
                  {consoleSource !== 'mock' && (
                    <label
                      className="tap-toggle"
                      title="Send clicks and drags on the screen (3D or here) as real taps and swipes to the tablet — this presses actual machine controls"
                    >
                      <input
                        type="checkbox"
                        checked={tapThrough}
                        onChange={(e) => setTapThrough(e.target.checked)}
                      />
                      Touch
                    </label>
                  )}
                  <select value={consoleSource} onChange={(e) => setConsoleSource(e.target.value)}>
                    <option value="mock">Mock (twin)</option>
                    {screens.map((d) => (
                      <option key={d.serial} value={d.serial} title={d.hwSerial ? `${d.hwSerial} via ${d.serial}` : d.serial}>
                        {d.product || d.model || 'device'} · …{(d.hwSerial ?? d.serial).slice(-6)}
                        {d.hwSerial ? ' · Pi' : ''}
                      </option>
                    ))}
                  </select>
                  <button className="btn" onClick={refreshScreens} title="Rescan adb devices">
                    ↻
                  </button>
                </span>
              </div>
              <div
                className={`screen-host${tapThrough ? ' tap-armed' : ''}`}
                ref={screenHost}
                // 2D card tap/swipe-through: same endpoints as the 3D screen
                onPointerDown={(e) => {
                  const uv = cardUV(e.clientX, e.clientY);
                  if (!uv) return;
                  cardDragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), ...uv };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerUp={(e) => {
                  const drag = cardDragRef.current;
                  if (!drag || drag.id !== e.pointerId) return;
                  cardDragRef.current = null;
                  const uv = cardUV(e.clientX, e.clientY);
                  if (!uv) return;
                  const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
                  if (moved < 5) sendTap(drag.u, drag.v);
                  else sendSwipe(drag.u, drag.v, uv.u, uv.v, Math.round(performance.now() - drag.t));
                }}
                onPointerCancel={() => (cardDragRef.current = null)}
              />
            </div>
            {CHANNELS_BY_KIND[focusedUnit?.kind ?? 'treadmill']
              // real bays track only their instrumented channels — no ghost
              // cards for readings the twin never reports (state pending =
              // show all rather than flash an empty panel)
              .filter((id) => presentChannels === null || presentChannels.split(',').includes(id))
              .map((id) => (
                <GaugeCard key={id} id={id} />
              ))}
          </>
        )}
        {level === 'component' && <ComponentInspector />}
      </aside>
    </div>
  );
}
