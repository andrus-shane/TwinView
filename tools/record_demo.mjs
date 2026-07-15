/** Records a narrated demo video of the TwinView POC against the running dev
 * servers (:5173/:8720) using Playwright's built-in video capture. */
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(process.cwd(), 'demo-video');
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

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

const store = async (page, fn) =>
  page.evaluate(async (src) => {
    const { useStore } = await import('/src/state/store.ts');
    // eslint-disable-next-line no-new-func
    return new Function('store', `return (${src})(store)`)(useStore.getState());
  }, fn.toString());

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
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.opacity = t ? '1' : '0';
  }, text);

const startOrbit = (page) =>
  page.evaluate(() => {
    const v = window.__viewer;
    let a = Math.atan2(v.camera.position.x, v.camera.position.z);
    const r = Math.hypot(v.camera.position.x, v.camera.position.z);
    const y = v.camera.position.y;
    clearInterval(window.__orbit);
    window.__orbit = setInterval(() => {
      a += 0.0032;
      v.camera.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
      v.controls.update();
    }, 33);
  });

const stopOrbit = (page) => page.evaluate(() => clearInterval(window.__orbit));

/** Fixed side profile at deck height — grid gives a horizon so grade angles read. */
const sideView = (page) =>
  page.evaluate(() => {
    const v = window.__viewer;
    v.controls.target.set(0, 0.55, 0.85);
    v.camera.position.set(3.9, 0.75, 0.85);
    v.controls.update();
  });

const main = async () => {
  log('launching chromium...');
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle'] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 860 } },
  });
  const page = await ctx.newPage();

  log('loading app...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForSelector('.conn.on', { timeout: 20000 });
  await page.waitForFunction(() => (window.__viewer?.modelRoot?.children?.length ?? 0) > 0, null, { timeout: 30000 });
  await sleep(2500);

  // clean slate
  for (const f of ['belt_slip', 'incline_stuck', 'current_spike', 'vibration_burst'])
    await api(page, '/faults', { fault: f, active: false });
  await api(page, '/setpoints', { speed: 0, incline: 0 });
  await store(page, (s) => s.setAllGroups('solid'));

  // The whole demo runs with the REAL tablet console (it's mid-workout) —
  // fall back to the mock only if no device is attached.
  const opts0 = await page.$$eval('.screen-src select option', (os) => os.map((o) => o.value));
  const liveSerial = opts0.find((v) => v !== 'mock');
  if (liveSerial) {
    await page.selectOption('.screen-src select', liveSerial);
    await sleep(2500); // let the stream come up before recording the intro
  }
  await startOrbit(page);

  log('phase 1: intro');
  await caption(
    page,
    liveSerial
      ? 'TwinView — digital twin QA POC. Console = REAL iFit tablet, live over ADB, mid-workout'
      : 'TwinView — digital twin QA proof of concept (NTL99925, real CAD)',
  );
  await sleep(6000);

  log('phase 2: run (incline pre-rolls in the background)');
  await caption(page, 'Commanding 5 mph — belt flow tracks measured speed in real time');
  await api(page, '/setpoints', { speed: 5, incline: 10 });
  await sleep(9000);

  log('phase 3: incline, fixed side profile');
  await stopOrbit(page);
  await sideView(page);
  await caption(page, 'Side profile: true-scale 10% grade — platform hinged at the rear, towers planted');
  await sleep(9000);

  log('phase 4: continuous descent through level into decline');
  await caption(page, 'Commanding -3%: watch the platform pivot down through level to a front-hinge decline');
  await api(page, '/setpoints', { speed: 5, incline: -3 });
  await sleep(21000); // 13% travel at 0.6%/s — one continuous readable move
  await startOrbit(page);

  log('phase 5: console close-up (live workout)');
  if (liveSerial) {
    await caption(page, 'Close-up: the tablet is running a real workout — streamed live onto the twin');
    await stopOrbit(page);
    // push in on the 3D console screen — use geometry bounds, NOT the node
    // origin: CAD part origins are arbitrary (this one sits at floor level)
    await page.evaluate(() => {
      const v = window.__viewer;
      const screen = v.modelRoot.getObjectByName('456481-3');
      let mesh = null;
      screen.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      const Box3 = mesh.geometry.boundingBox.constructor;
      const p = new (screen.position.constructor)();
      new Box3().setFromObject(screen).getCenter(p);
      v.controls.target.copy(p);
      v.camera.position.set(p.x + 0.25, p.y + 0.08, p.z + 0.85);
      v.controls.update();
    });
    await sleep(9000);
    await page.evaluate(() => window.__viewer['fitCamera']());
    await startOrbit(page);
  }

  log('phase 6: belt slip fault');
  await caption(page, 'FAULT: belt slip — measured speed sags, belt tints, QA event logged');
  await api(page, '/setpoints', { speed: 5, incline: 0 });
  await api(page, '/faults', { fault: 'belt_slip', active: true });
  await sleep(11000);
  await caption(page, 'Fault cleared — twin confirms recovery to tolerance');
  await api(page, '/faults', { fault: 'belt_slip', active: false });
  await sleep(6000);

  log('phase 7: light theme + strip view + current spike');
  await caption(page, 'Light theme + strip view: x-ray the plastics, fault glows on the real motor');
  await page.click('.theme-menu > button');
  await page.click('.seg-btn:has-text("Light")');
  await page.mouse.click(700, 400); // dismiss menu
  await sleep(1500);
  await store(page, (s) => s.setAllGroups('xray', ['Drivetrain', 'Frame & structure']));
  await sleep(1500);
  await api(page, '/faults', { fault: 'current_spike', active: true });
  await sleep(9000);

  log('phase 8: incline stuck');
  await caption(page, 'FAULT: incline stuck — blue ghost shows where the platform should be');
  await api(page, '/faults', { fault: 'current_spike', active: false });
  await api(page, '/faults', { fault: 'incline_stuck', active: true });
  await api(page, '/setpoints', { speed: 5, incline: 8 });
  await sleep(11000);

  log('phase 9: outro');
  await api(page, '/faults', { fault: 'incline_stuck', active: false });
  await api(page, '/setpoints', { speed: 0, incline: 0 });
  await page.click('.theme-menu > button');
  await page.click('.seg-btn:has-text("Dark")');
  await page.mouse.click(700, 400);
  await store(page, (s) => s.setAllGroups('solid'));
  await caption(page, 'Click any part to bind sensors — USB/serial hardware drops into the same rig');
  await sleep(7000);
  await caption(page, '');
  await sleep(1500);

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
