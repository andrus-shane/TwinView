/** Records a narrated demo video of the TwinView lab against the running dev
 * servers (:5173/:8720) using Playwright's built-in video capture.
 *
 * Covers: lab-floor fleet overview (12 bays, mixed CAD, live tablet wall),
 * rower/elliptical/reformer CAD animations, the REAL bench hardware in bay 01
 * (Arduino Mega on COM11 — expected-vs-actual on live sensors), and the
 * classic treadmill beats (incline profile, faults, x-ray, ghost).
 *
 * Uses the system Edge browser via playwright-core (repo devDependency) —
 * `npx playwright-core install ffmpeg` once for video capture.
 * PREFLIGHT=1 runs the loads/waits and saves screenshots instead of recording.
 */
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PREFLIGHT = !!process.env.PREFLIGHT;
const OUT_DIR = join(process.cwd(), 'demo-video');
mkdirSync(OUT_DIR, { recursive: true });
// preflight compresses the narrative sleeps — it validates loading/rendering, not pacing
const S = PREFLIGHT ? 0.25 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * S));
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

let t0 = Date.now();
/** Phase marks (seconds since recording start) — feed these to make_demo_music.py */
const mark = (label) => console.log(`MARK ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}`);

const api = async (page, path, body) =>
  page.evaluate(
    ([p, b]) =>
      fetch('/api' + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      }).then((r) => r.status),
    [path, body],
  );

const setpoints = (page, unit, sp) => api(page, `/units/${unit}/setpoints`, sp);
const fault = (page, unit, f, active) => api(page, `/units/${unit}/faults`, { fault: f, active });
const scenario = (page, unit, id) => api(page, `/units/${unit}/scenario/start`, { id });

// NOTE: do NOT import('/src/state/store.ts') from evaluate — a long-running
// Vite dev server serves the app's copy under HMR-timestamped URLs, so the
// dynamic import creates a SECOND store instance and mutations go nowhere.
// Navigation goes through the viewer's app-owned closures (the click path);
// rig/group edits go through PUT /api/rig, which broadcasts back to the app.

/** Select a part (or null) exactly like clicking it in the 3D view. */
const selectPart = (page, name) =>
  page.evaluate((n) => window.__viewer.onSelectPart(n), name);

/** Set every group's display (except `except`, which stay solid) via the rig API. */
const setAllGroups = (page, display, except = []) =>
  page.evaluate(
    async ([d, ex]) => {
      const rig = await fetch('/api/rig').then((r) => r.json());
      // tripwire: a PUT without bindings would permanently strip the rig
      if (!rig.bindings?.length) throw new Error('setAllGroups: rig came back with no bindings — refusing to PUT');
      for (const g of rig.groups ?? []) g.display = ex.includes(g.name) ? 'solid' : d;
      await fetch('/api/rig', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rig),
      });
    },
    [display, except],
  );

const caption = async (page, text) =>
  page.evaluate((t) => {
    let el = document.getElementById('__demo_caption__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption__';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
        background: 'rgba(10,14,20,0.85)', color: '#dbe7f4', padding: '10px 22px',
        borderRadius: '10px', font: '600 17px system-ui', zIndex: 99999,
        border: '1px solid #2c3a52', transition: 'opacity .3s', pointerEvents: 'none',
        maxWidth: '72%', textAlign: 'center',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.opacity = t ? '1' : '0';
  }, text);

/** Slow orbit about the current controls target (works at lab and unit level). */
const startOrbit = (page, speed = 0.0032) =>
  page.evaluate((sp) => {
    const v = window.__viewer;
    clearInterval(window.__orbit);
    window.__orbit = setInterval(() => {
      const c = v.controls.target;
      const dx = v.camera.position.x - c.x;
      const dz = v.camera.position.z - c.z;
      const r = Math.hypot(dx, dz);
      const a = Math.atan2(dx, dz) + sp;
      v.camera.position.set(c.x + Math.sin(a) * r, v.camera.position.y, c.z + Math.cos(a) * r);
      v.controls.update();
    }, 33);
  }, speed);

const stopOrbit = (page) => page.evaluate(() => clearInterval(window.__orbit));

/** Focus a bay via the store (same path as clicking it) and wait for its CAD twin. */
const focusUnit = async (page, id, timeoutMs = 30000) => {
  await page.evaluate((unitId) => window.__viewer.onSelectUnit(unitId), id);
  if (!id) return true;
  try {
    await page.waitForFunction(
      () => {
        const v = window.__viewer;
        const c = v && v.focusedCad && v.focusedCad();
        return !!(c && c.entry.group && c.entry.group.visible);
      },
      null,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    log(`WARN: CAD for ${id} not confirmed in ${timeoutMs}ms — continuing on proxy`);
    return false;
  }
};

/** Fixed side profile of a bay, shot from OUTSIDE the floor (-x, col-0 bays only)
 * at deck height — the grid gives a horizon so grade angles read true. */
const sideView = (page, unitId) =>
  page.evaluate((id) => {
    const v = window.__viewer;
    const p = v.bays.get(id).root.position;
    v.controls.target.set(p.x, 0.55, p.z + 0.85);
    v.camera.position.set(p.x - 3.9, 0.75, p.z + 0.85);
    v.controls.update();
  }, unitId);

/** Hide every other bay for a clean single-machine composition (profile shots). */
const isolateBay = (page, id, on) =>
  page.evaluate(
    ([unitId, active]) => {
      const v = window.__viewer;
      for (const b of v.bayList) {
        if (b.unit.id !== unitId) b.root.visible = !active;
      }
    },
    [id, on],
  );

/** Push in on the focused unit's console screen — use geometry bounds,
 * NOT the node origin: CAD part origins are arbitrary. */
const consoleCloseup = (page, nodeName) =>
  page.evaluate((name) => {
    const v = window.__viewer;
    // scope to the FOCUSED bay — other bays' LODs carry nodes with the same names
    const screen = v.bays.get(v.focusedId).root.getObjectByName(name);
    let mesh = null;
    screen.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    const Box3 = mesh.geometry.boundingBox.constructor;
    const p = new (screen.position.constructor)();
    new Box3().setFromObject(screen).getCenter(p);
    v.controls.target.copy(p);
    v.camera.position.set(p.x + 0.25, p.y + 0.08, p.z + 0.85);
    v.controls.update();
  }, nodeName);

const reframeUnit = (page) => page.evaluate(() => window.__viewer.reframeUnit());

const shot = async (page, name) => {
  if (!PREFLIGHT) return;
  const path = join(OUT_DIR, `preflight-${name}.png`);
  await page.screenshot({ path });
  log(`shot: ${path}`);
};

const main = async () => {
  log(`launching Edge (${PREFLIGHT ? 'preflight' : 'recording'})...`);
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle'] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    colorScheme: 'dark',
    ...(PREFLIGHT ? {} : { recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 860 } } }),
  });
  const page = await ctx.newPage();
  t0 = Date.now();
  page.on('pageerror', (e) => log(`PAGEERROR: ${e.message}`));

  log('loading app...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForSelector('.conn.on', { timeout: 20000 });
  await page.waitForFunction(() => (window.__viewer?.modelRoot?.children?.length ?? 0) >= 12, null, { timeout: 30000 });

  // Stage preconditions so reruns are reproducible: bay 02 carries the seeded
  // detection the script clears on camera; the bays we command start clean.
  await fault(page, 'u02', 'drive_belt_slip', true);
  for (const f of ['belt_slip', 'incline_stuck', 'current_spike', 'vibration_burst'])
    await fault(page, 'u05', f, false);
  await api(page, '/units/u05/scenario/stop', {}); // manual bay: autorun profile would override our setpoints
  await setpoints(page, 'u05', { speed: 0, incline: 0 });
  await setpoints(page, 'u01', { speed: 0, incline: -0.5 });
  // earlier runs' takeovers stick — put the visited bays back on autopilot so the floor is alive
  for (const id of ['u02', 'u04', 'u07', 'u11']) await api(page, `/units/${id}/auto`, { active: true });
  await sleep(2500); // proxies up; CAD LODs + tablet wall keep popping in on camera (reads as boot-up)

  // ---------------------------------------------------------------- lab intro
  mark('P1 lab');
  await startOrbit(page);
  await caption(page, 'TwinView — digital-twin QA lab. Twelve bays, four machine types, every bay a live twin');
  await sleep(7000);
  await caption(page, 'Autopilot exercises the floor — and real iFit tablets stream onto every console, live over ADB');
  await sleep(7000);
  await caption(page, 'Deviations become detections: halos and badges flag faulted bays for review');
  await sleep(7000);
  await stopOrbit(page);
  await shot(page, 'lab');

  // ------------------------------------------------------------- rower bay 02
  mark('P2 rower');
  await focusUnit(page, 'u02');
  await sleep(1500);
  await scenario(page, 'u02', 'steady_row');
  await startOrbit(page);
  await caption(page, 'Bay 02 — rower twin on converted CAD: seat, handle and flywheel ride live stroke telemetry');
  await sleep(11000);
  await stopOrbit(page);
  await consoleCloseup(page, '453085_CMPL-1');
  await caption(page, 'Its console is a REAL iFit tablet mid-workout, streamed live over ADB onto the twin');
  await sleep(8000);
  await reframeUnit(page);
  await sleep(1200);
  await startOrbit(page);
  await caption(page, 'This bay carries a live detection: drive-belt slip, injected on its mock plant');
  await sleep(7000);
  await fault(page, 'u02', 'drive_belt_slip', false);
  await caption(page, 'Fault cleared — the twin confirms recovery to tolerance');
  await sleep(7000);
  await stopOrbit(page);
  await shot(page, 'rower');

  // -------------------------------------------------------- elliptical bay 07
  mark('P3 elliptical');
  await focusUnit(page, 'u07');
  await sleep(1500);
  await scenario(page, 'u07', 'steady_stride');
  await startOrbit(page);
  await caption(page, 'Elliptical twin — pin-driven joints: crank, pedal arms and ramp rollers stay connected through the stride');
  await sleep(11000);
  await caption(page, 'Stride rate, ramp, drive power — commanded vs measured on every channel');
  await sleep(7000);
  await stopOrbit(page);
  await shot(page, 'elliptical');

  // ---------------------------------------------------------- reformer bay 11
  mark('P4 pilates');
  await focusUnit(page, 'u11');
  await sleep(1500);
  await scenario(page, 'u11', 'steady_flow');
  await startOrbit(page);
  await caption(page, 'Reformer twin — the carriage glides, springs stretch and relax, ropes ride the hand-loops');
  await sleep(10000);
  await caption(page, 'Each machine kind gets its own channels, scenarios and fault models');
  await sleep(6000);
  await stopOrbit(page);
  await shot(page, 'pilates');

  // ------------------------------------------------- REAL hardware in bay 01
  mark('P5 real hardware');
  await focusUnit(page, 'u01');
  await sleep(2500); // full-quality tablet stream connects
  // align the reference with the bench pose so the segment starts green
  await setpoints(page, 'u01', { speed: 0, incline: -0.5 });
  await caption(page, 'Bay 01 is REAL hardware — an Arduino Mega on COM11: WT901 inclinometer + belt tach, streaming at 10 Hz');
  await sleep(9000);
  await caption(page, 'Two channels wired so far — live incline and belt speed; current + vibration land next');
  await sleep(7000);
  mark('P5b command real belt');
  await caption(page, 'Command 3 mph — the reference plant ramps… the REAL belt never moves');
  await setpoints(page, 'u01', { speed: 3, incline: -0.5 });
  await sleep(9000);
  await caption(page, 'FAIL flagged within seconds — expected vs actual, on live sensors');
  await sleep(8000);
  await setpoints(page, 'u01', { speed: 0, incline: -0.5 });
  await caption(page, 'Commanded back to zero — the twin confirms recovery');
  await sleep(7000);
  await shot(page, 'hardware');

  // -------------------------------------------- treadmill deep dive on bay 05
  mark('P6 treadmill');
  await focusUnit(page, 'u05');
  await sleep(1500);
  await startOrbit(page);
  await setpoints(page, 'u05', { speed: 5, incline: 10 });
  await caption(page, 'A mock bay under manual command: 5 mph — belt flow tracks measured speed in real time');
  await sleep(9000);
  await stopOrbit(page);
  await isolateBay(page, 'u05', true); // clean silhouette — the profile is unreadable through the bay behind
  await sideView(page, 'u05');
  await caption(page, 'Side profile: true-scale 10% grade — platform hinged at the rear, towers planted');
  await sleep(9000);
  await setpoints(page, 'u05', { speed: 5, incline: -3 });
  await caption(page, 'Commanding -3%: continuous travel down through level into a front-hinge decline');
  await sleep(15000);
  mark('P6b faults');
  await isolateBay(page, 'u05', false);
  await reframeUnit(page);
  await sleep(1200);
  await startOrbit(page);
  await fault(page, 'u05', 'belt_slip', true);
  await setpoints(page, 'u05', { speed: 5, incline: 0 });
  await caption(page, 'FAULT: belt slip — measured speed sags, the belt tints, a QA event logs');
  await sleep(10000);
  await fault(page, 'u05', 'belt_slip', false);
  await caption(page, 'Cleared — recovery confirmed');
  await sleep(5000);
  await page.click('.theme-menu > button');
  await page.click('.seg-btn:has-text("Light")');
  await page.click('.theme-menu > button'); // toggle closed — a stray viewport click would focus another bay
  await sleep(1000);
  await setAllGroups(page, 'xray', ['Drivetrain', 'Frame & structure']);
  await fault(page, 'u05', 'current_spike', true);
  await caption(page, 'Light theme + x-ray strip: the current-spike fault glows on the real motor');
  await sleep(9000);
  await fault(page, 'u05', 'current_spike', false);
  await fault(page, 'u05', 'incline_stuck', true);
  await setpoints(page, 'u05', { speed: 5, incline: 8 });
  await caption(page, 'FAULT: incline stuck — the blue ghost shows where the platform should be');
  await sleep(10000);
  await fault(page, 'u05', 'incline_stuck', false);
  await setpoints(page, 'u05', { speed: 0, incline: 0 });
  await page.click('.theme-menu > button');
  await page.click('.seg-btn:has-text("Dark")');
  await page.click('.theme-menu > button'); // toggle closed — a stray viewport click would focus another bay
  await setAllGroups(page, 'solid');
  await stopOrbit(page);
  await sleep(1500);
  await shot(page, 'treadmill');

  // ------------------------------------------------- component drill-down
  mark('P7 component');
  await focusUnit(page, 'u05'); // defensive: no-op when already focused
  await selectPart(page, '1000889-1'); // the motor — dives + isolates in x-ray
  await caption(page, 'Click any part to drill in — bindings, channels and QA history at component level');
  await sleep(9000);
  await selectPart(page, null);
  await sleep(1500);
  await shot(page, 'component');

  // ------------------------------------------------------------------ outro
  mark('P8 outro');
  await focusUnit(page, null);
  await sleep(1800);
  await startOrbit(page);
  await caption(page, 'One operator, a whole lab of twins — mock plants or real hardware in any bay');
  await sleep(8000);
  await caption(page, 'TwinView — digital-twin QA for iFit equipment');
  await sleep(6000);
  await caption(page, '');
  await sleep(1500);
  await stopOrbit(page);
  mark('end');

  if (PREFLIGHT) {
    await browser.close();
    log('preflight done');
    return;
  }

  log('closing (finalizes video)...');
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  await browser.close();

  const target = join(OUT_DIR, 'twinview-demo.webm');
  copyFileSync(path, target);
  const mb = (statSync(target).size / 1e6).toFixed(1);
  log(`DONE: ${target} (${mb} MB)`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
