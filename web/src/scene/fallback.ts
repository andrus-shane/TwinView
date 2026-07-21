import * as THREE from 'three';
import type { RigConfig } from '@twinview/shared';

/**
 * Procedural low-poly treadmill used until a converted CAD model is available
 * (and as a template for other unit types). Node names are stable so the
 * default rig bindings below always work.
 */

function beltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1c1f24';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#2e3339';
  for (let y = 0; y < 128; y += 16) g.fillRect(0, y, 128, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 10);
  return tex;
}

/** Fresh materials per instance — a lab floor has many copies, and shared
 * materials would bleed selection highlights and status tints across units. */
function makeMats() {
  return {
    frame: new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.6 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8, metalness: 0.1 }),
    deck: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.7, metalness: 0.3 }),
    roller: new THREE.MeshStandardMaterial({ color: 0x777d86, roughness: 0.35, metalness: 0.8 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xc02428, roughness: 0.5, metalness: 0.4 }),
    screen: new THREE.MeshBasicMaterial({ color: 0x0a0c10 }),
  };
}

function box(name: string, w: number, h: number, d: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.name = name;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function cyl(name: string, r: number, len: number, m: THREE.Material): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, len, 24);
  g.rotateZ(Math.PI / 2); // axis along X (across the belt)
  const mesh = new THREE.Mesh(g, m);
  mesh.name = name;
  mesh.castShadow = true;
  return mesh;
}

/** Front of the treadmill (console end) faces -Z. Deck pivots at the REAR so the front lifts. */
export function buildFallbackTreadmill(): THREE.Group {
  const mat = makeMats();
  const root = new THREE.Group();
  root.name = 'Treadmill_POC';

  const DECK_L = 1.6;
  const DECK_W = 0.72;

  // --- Deck assembly: pivot origin at rear-bottom so rotation lifts the front ---
  const deckAsm = new THREE.Group();
  deckAsm.name = 'Deck_Assembly';
  deckAsm.position.set(0, 0.12, DECK_L / 2); // rear end of the deck

  const deck = box('Deck', DECK_W, 0.06, DECK_L, mat.deck);
  deck.position.set(0, 0, -DECK_L / 2);
  deckAsm.add(deck);

  const beltTex = beltTexture();
  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(DECK_W * 0.78, 0.012, DECK_L * 0.92),
    new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.9 }),
  );
  belt.name = 'Belt';
  belt.position.set(0, 0.038, -DECK_L / 2);
  belt.userData.scrollTexture = beltTex;
  deckAsm.add(belt);

  const rollerRear = cyl('Roller_Rear', 0.035, DECK_W * 0.8, mat.roller);
  rollerRear.position.set(0, 0.01, -0.03);
  deckAsm.add(rollerRear);

  const rollerFront = cyl('Roller_Front', 0.035, DECK_W * 0.8, mat.roller);
  rollerFront.position.set(0, 0.01, -DECK_L + 0.03);
  deckAsm.add(rollerFront);

  const motor = box('Motor_Housing', DECK_W * 0.9, 0.16, 0.34, mat.plastic);
  motor.position.set(0, 0.06, -DECK_L - 0.16);
  deckAsm.add(motor);

  const motorCap = box('Motor_Cover', DECK_W * 0.92, 0.03, 0.38, mat.accent);
  motorCap.position.set(0, 0.155, -DECK_L - 0.16);
  deckAsm.add(motorCap);

  // side rails riding with the deck
  for (const side of [-1, 1]) {
    const rail = box(`Side_Rail_${side < 0 ? 'L' : 'R'}`, 0.07, 0.02, DECK_L, mat.plastic);
    rail.position.set(side * (DECK_W / 2 + 0.045), 0.045, -DECK_L / 2);
    deckAsm.add(rail);
  }
  root.add(deckAsm);

  // --- Static frame ---
  const frame = new THREE.Group();
  frame.name = 'Frame';
  const baseL = box('Base_L', 0.06, 0.08, 1.0, mat.frame);
  baseL.position.set(-(DECK_W / 2 + 0.1), 0.04, 0.35);
  const baseR = baseL.clone();
  baseR.name = 'Base_R';
  baseR.position.x *= -1;
  frame.add(baseL, baseR);
  root.add(frame);

  // --- Uprights and console ---
  for (const side of [-1, 1]) {
    const up = box(`Upright_${side < 0 ? 'L' : 'R'}`, 0.05, 1.15, 0.07, mat.frame);
    up.position.set(side * (DECK_W / 2 + 0.08), 0.62, -DECK_L / 2 - 0.62);
    up.rotation.x = 0.28;
    root.add(up);
  }

  for (const side of [-1, 1]) {
    const rail = box(`Handrail_${side < 0 ? 'L' : 'R'}`, 0.04, 0.04, 0.55, mat.plastic);
    rail.position.set(side * (DECK_W / 2 + 0.08), 1.12, -DECK_L / 2 - 0.55);
    root.add(rail);
  }

  const console_ = new THREE.Group();
  console_.name = 'Console';
  console_.position.set(0, 1.28, -DECK_L / 2 - 0.82);
  console_.rotation.x = -0.42;
  const consoleBody = box('Console_Body', 0.86, 0.5, 0.06, mat.plastic);
  console_.add(consoleBody);
  const bezel = box('Console_Bezel', 0.66, 0.4, 0.015, mat.frame);
  bezel.position.z = 0.033;
  console_.add(bezel);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.34), mat.screen.clone());
  screen.name = 'Console_Screen';
  screen.position.z = 0.045;
  console_.add(screen);
  root.add(console_);

  return root;
}

/** Bindings applied automatically when the fallback model loads and no rig exists yet. */
export const FALLBACK_RIG: RigConfig = {
  model: 'FALLBACK_POC',
  bindings: [
    { nodeName: 'Belt', role: 'belt', channels: ['belt_speed'], sensor: { kind: 'mock', note: 'belt tachometer' } },
    { nodeName: 'Deck_Assembly', role: 'deck', channels: ['incline'], sensor: { kind: 'mock', note: 'inclinometer' } },
    { nodeName: 'Motor_Housing', role: 'motor', channels: ['motor_current', 'vibration'], sensor: { kind: 'mock', note: 'current clamp + IMU' } },
    { nodeName: 'Roller_Front', role: 'roller', channels: [] },
    { nodeName: 'Roller_Rear', role: 'roller', channels: [] },
    { nodeName: 'Console_Screen', role: 'console_screen', channels: [] },
  ],
};

/**
 * Procedural low-poly rower (FMRW-class: front flywheel, rail, sliding seat).
 * Front (flywheel/console end) faces -Z like the treadmill proxy. The rig
 * animates the seat and handle through the stroke cycle, spins the spoked
 * flywheel at measured rpm, and stretches the drive strap to the handle.
 */
export function buildFallbackRower(): THREE.Group {
  const mat = makeMats();
  const root = new THREE.Group();
  root.name = 'Rower_POC';

  // --- Main rail on two legs, seat slides along it ---
  const rail = box('Rail', 0.14, 0.07, 1.9, mat.frame);
  rail.position.set(0, 0.36, 0.25);
  root.add(rail);

  const frontLeg = box('Front_Leg', 0.5, 0.08, 0.12, mat.frame);
  frontLeg.position.set(0, 0.04, -0.62);
  root.add(frontLeg);

  const rearLeg = box('Rear_Leg', 0.42, 0.05, 0.1, mat.frame);
  rearLeg.position.set(0, 0.025, 1.1);
  root.add(rearLeg);

  const rearPost = box('Rear_Post', 0.08, 0.28, 0.08, mat.frame);
  rearPost.position.set(0, 0.19, 1.1);
  root.add(rearPost);

  const frontPost = box('Front_Post', 0.1, 0.3, 0.1, mat.frame);
  frontPost.position.set(0, 0.18, -0.6);
  root.add(frontPost);

  // --- Flywheel: shroud on the left, exposed spoked wheel on the right ---
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.31, 0.31, 0.12, 28).rotateZ(Math.PI / 2),
    mat.plastic,
  );
  housing.name = 'Flywheel_Housing';
  housing.position.set(-0.08, 0.52, -0.62);
  housing.castShadow = housing.receiveShadow = true;
  root.add(housing);

  const flywheel = new THREE.Group();
  flywheel.name = 'Flywheel';
  flywheel.position.set(0.06, 0.52, -0.62);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.025, 12, 36).rotateY(Math.PI / 2), mat.accent);
  rim.castShadow = true;
  flywheel.add(rim);
  const hub = cyl('', 0.045, 0.06, mat.roller);
  hub.name = '';
  flywheel.add(hub);
  for (let i = 0; i < 4; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.44, 0.035), mat.roller);
    spoke.rotation.x = (i * Math.PI) / 4;
    spoke.castShadow = true;
    flywheel.add(spoke);
  }
  root.add(flywheel);

  // magnetic brake servo riding the housing — the resistance channel's home
  const servo = box('Resistance_Servo', 0.09, 0.07, 0.11, mat.accent);
  servo.position.set(-0.08, 0.78, -0.5);
  root.add(servo);

  // --- Footrests straddling the rail ahead of the seat ---
  for (const side of [-1, 1]) {
    const foot = box(`Footrest_${side < 0 ? 'L' : 'R'}`, 0.13, 0.26, 0.05, mat.plastic);
    foot.position.set(side * 0.2, 0.3, -0.18);
    foot.rotation.x = -0.55;
    root.add(foot);
  }

  // --- Seat (rig slides it through the stroke) ---
  const seat = box('Seat', 0.32, 0.05, 0.28, mat.deck);
  seat.position.set(0, 0.42, 0.18);
  root.add(seat);

  // --- Handle + drive strap back to the flywheel housing ---
  const handle = new THREE.Group();
  handle.name = 'Handle';
  handle.position.set(0, 0.56, -0.2);
  const bar = cyl('', 0.018, 0.44, mat.roller);
  bar.name = '';
  handle.add(bar);
  for (const side of [-1, 1]) {
    const grip = cyl('', 0.022, 0.12, mat.accent);
    grip.name = '';
    grip.position.x = side * 0.17;
    handle.add(grip);
  }
  root.add(handle);

  // unit-length in Z so the rig can stretch it from the housing to the handle
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 1), mat.plastic.clone());
  strap.name = 'Drive_Strap';
  strap.position.set(0, 0.56, 0.05);
  strap.castShadow = true;
  root.add(strap);

  // --- Console on a mast above the flywheel ---
  const mast = box('Console_Mast', 0.05, 0.42, 0.05, mat.frame);
  mast.position.set(0, 0.95, -0.68);
  mast.rotation.x = 0.25;
  root.add(mast);

  const console_ = new THREE.Group();
  console_.name = 'Console';
  console_.position.set(0, 1.18, -0.72);
  console_.rotation.x = -0.35;
  const consoleBody = box('Console_Body', 0.44, 0.3, 0.05, mat.plastic);
  console_.add(consoleBody);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.22), mat.screen.clone());
  screen.name = 'Console_Screen';
  screen.position.z = 0.028;
  console_.add(screen);
  root.add(console_);

  return root;
}

/** Rower proxy bindings — mirrors FALLBACK_RIG for the rower's sensor suite. */
export const FALLBACK_ROWER_RIG: RigConfig = {
  model: 'FALLBACK_ROWER_POC',
  bindings: [
    { nodeName: 'Flywheel', role: 'flywheel', channels: ['flywheel_speed'], sensor: { kind: 'mock', note: 'optical flywheel tach' } },
    { nodeName: 'Seat', role: 'seat', channels: ['stroke_rate'], sensor: { kind: 'mock', note: 'seat position encoder' } },
    { nodeName: 'Handle', role: 'handle', channels: ['drive_power'], sensor: { kind: 'mock', note: 'handle load cell' } },
    { nodeName: 'Resistance_Servo', channels: ['resistance'], sensor: { kind: 'mock', note: 'magnetic brake servo encoder' } },
    { nodeName: 'Console_Screen', role: 'console_screen', channels: [] },
  ],
};

/**
 * Procedural low-poly elliptical (NTEL-class: front drive, power ramp).
 * Front (drive housing/console end) faces -Z. The rig runs the pedals around
 * a stride ellipse, swings the arm poles opposite the pedals, and spins the
 * exposed flywheel with cadence.
 */
export function buildFallbackElliptical(): THREE.Group {
  const mat = makeMats();
  const root = new THREE.Group();
  root.name = 'Elliptical_POC';

  // --- Base frame: front stabilizer, center spine, rear stabilizer ---
  const spine = box('Base_Spine', 0.14, 0.09, 1.7, mat.frame);
  spine.position.set(0, 0.055, 0.15);
  root.add(spine);
  const frontStab = box('Front_Stabilizer', 0.62, 0.07, 0.1, mat.frame);
  frontStab.position.set(0, 0.035, -0.65);
  root.add(frontStab);
  const rearStab = box('Rear_Stabilizer', 0.58, 0.07, 0.1, mat.frame);
  rearStab.position.set(0, 0.035, 0.95);
  root.add(rearStab);

  // --- Front drive housing with an exposed flywheel on the right ---
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.18, 28).rotateZ(Math.PI / 2),
    mat.plastic,
  );
  housing.name = 'Drive_Housing';
  housing.position.set(-0.05, 0.35, -0.45);
  housing.castShadow = housing.receiveShadow = true;
  root.add(housing);

  const flywheel = new THREE.Group();
  flywheel.name = 'Flywheel';
  flywheel.position.set(0.13, 0.35, -0.45);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.022, 12, 36).rotateY(Math.PI / 2), mat.accent);
  rim.castShadow = true;
  flywheel.add(rim);
  const hub = cyl('', 0.04, 0.05, mat.roller);
  hub.name = '';
  flywheel.add(hub);
  for (let i = 0; i < 4; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.4, 0.03), mat.roller);
    spoke.rotation.x = (i * Math.PI) / 4;
    spoke.castShadow = true;
    flywheel.add(spoke);
  }
  root.add(flywheel);

  // ramp actuator block under the rails — the incline channel's home
  const ramp = box('Ramp_Actuator', 0.2, 0.1, 0.24, mat.accent);
  ramp.position.set(0, 0.12, 0.05);
  root.add(ramp);

  // --- Pedals: platforms riding the stride path (rig translates them) ---
  for (const side of [-1, 1] as const) {
    const pedal = box(`Pedal_${side < 0 ? 'L' : 'R'}`, 0.16, 0.045, 0.4, mat.deck);
    pedal.position.set(side * 0.19, 0.3, 0.35);
    root.add(pedal);
  }

  // --- Arm poles: pivot near the mast top (rig swings rotation.x) ---
  for (const side of [-1, 1] as const) {
    const arm = new THREE.Group();
    arm.name = `Arm_${side < 0 ? 'L' : 'R'}`;
    arm.position.set(side * 0.3, 1.35, -0.42); // pivot point up on the mast
    const pole = box('', 0.045, 1.05, 0.045, mat.frame);
    pole.name = '';
    pole.position.y = -0.48; // hangs from the pivot
    arm.add(pole);
    const grip = cyl('', 0.02, 0.16, mat.accent);
    grip.name = '';
    grip.rotation.z = Math.PI / 2; // vertical grip section
    grip.position.set(0, -0.1, 0);
    arm.add(grip);
    root.add(arm);
  }

  // --- Console mast + screen at the front, facing the rider (+z) ---
  const mast = box('Console_Mast', 0.07, 0.85, 0.07, mat.frame);
  mast.position.set(0, 0.85, -0.5);
  mast.rotation.x = 0.18;
  root.add(mast);

  const console_ = new THREE.Group();
  console_.name = 'Console';
  console_.position.set(0, 1.35, -0.55);
  console_.rotation.x = -0.3;
  const consoleBody = box('Console_Body', 0.5, 0.34, 0.05, mat.plastic);
  console_.add(consoleBody);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.26), mat.screen.clone());
  screen.name = 'Console_Screen';
  screen.position.z = 0.028;
  console_.add(screen);
  root.add(console_);

  return root;
}

/** Elliptical proxy bindings — the NTEL-class sensor suite. */
export const FALLBACK_ELLIPTICAL_RIG: RigConfig = {
  model: 'FALLBACK_ELLIPTICAL_POC',
  bindings: [
    { nodeName: 'Flywheel', role: 'flywheel', channels: ['drive_power'], sensor: { kind: 'mock', note: 'generator/brake load' } },
    { nodeName: 'Pedal_R', role: 'pedal', channels: ['stride_rate'], sensor: { kind: 'mock', note: 'crank cadence sensor' } },
    { nodeName: 'Pedal_L', role: 'pedal', channels: [] },
    { nodeName: 'Arm_L', role: 'arm', channels: [] },
    { nodeName: 'Arm_R', role: 'arm', channels: [] },
    { nodeName: 'Ramp_Actuator', channels: ['incline'], sensor: { kind: 'mock', note: 'ramp position sensor' } },
    { nodeName: 'Drive_Housing', channels: ['vibration'], sensor: { kind: 'mock', note: 'frame IMU' } },
    { nodeName: 'Console_Screen', role: 'console_screen', channels: [] },
  ],
};

/**
 * Procedural low-poly pilates reformer (NTPL-class: sliding carriage on rails,
 * magnetic spring resistance, footbar + console at the front). Front faces -Z.
 * The rig slides the carriage through the rep cycle at measured cadence and
 * stretches the spring pack between the footbar bay and the carriage.
 */
export function buildFallbackPilates(): THREE.Group {
  const mat = makeMats();
  const root = new THREE.Group();
  root.name = 'Reformer_POC';

  // --- Rails on corner legs ---
  for (const side of [-1, 1] as const) {
    const rail = box(`Rail_${side < 0 ? 'L' : 'R'}`, 0.06, 0.07, 2.2, mat.frame);
    rail.position.set(side * 0.27, 0.28, 0.05);
    root.add(rail);
  }
  for (const [sx, sz, n] of [[-1, -1, 'FL'], [1, -1, 'FR'], [-1, 1, 'RL'], [1, 1, 'RR']] as const) {
    const leg = box(`Leg_${n}`, 0.06, 0.25, 0.06, mat.frame);
    leg.position.set(sx * 0.27, 0.125, sz === -1 ? -0.98 : 1.05);
    root.add(leg);
  }
  const rearCap = box('Rear_Cap', 0.6, 0.1, 0.1, mat.plastic);
  rearCap.position.set(0, 0.3, 1.12);
  root.add(rearCap);

  // --- Foot end: standing platform, footbar, resistance unit under the bay ---
  const platform = box('Platform', 0.56, 0.035, 0.26, mat.deck);
  platform.position.set(0, 0.3, -0.97);
  root.add(platform);

  for (const side of [-1, 1] as const) {
    const post = box(`Footbar_Post_${side < 0 ? 'L' : 'R'}`, 0.04, 0.34, 0.05, mat.frame);
    post.position.set(side * 0.24, 0.46, -0.85);
    root.add(post);
  }
  const footbar = cyl('Footbar', 0.026, 0.54, mat.roller);
  footbar.position.set(0, 0.64, -0.85);
  root.add(footbar);

  const resUnit = box('Resistance_Unit', 0.2, 0.09, 0.13, mat.accent);
  resUnit.position.set(0, 0.2, -0.8);
  root.add(resUnit);

  // unit-length in Z so the rig can stretch it from the bay to the carriage
  const springs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 1), mat.accent.clone());
  springs.name = 'Springs';
  springs.position.set(0, 0.27, -0.8);
  springs.scale.z = 0.2;
  springs.castShadow = true;
  root.add(springs);

  // --- Carriage: padded platform with shoulder blocks + headrest ---
  const carriage = new THREE.Group();
  carriage.name = 'Carriage';
  carriage.position.set(0, 0.34, -0.25);
  const pad = box('', 0.56, 0.07, 0.9, mat.deck);
  pad.name = '';
  carriage.add(pad);
  for (const side of [-1, 1] as const) {
    const block = box('', 0.07, 0.12, 0.07, mat.plastic);
    block.name = '';
    block.position.set(side * 0.16, 0.09, 0.24);
    carriage.add(block);
  }
  const headrest = box('', 0.3, 0.045, 0.16, mat.plastic);
  headrest.name = '';
  headrest.position.set(0, 0.06, 0.4);
  carriage.add(headrest);
  root.add(carriage);

  // --- Console on a short mast beyond the footbar, facing the rider (+z) ---
  const mast = box('Console_Mast', 0.05, 0.5, 0.05, mat.frame);
  mast.position.set(0, 0.55, -1.12);
  root.add(mast);

  const console_ = new THREE.Group();
  console_.name = 'Console';
  console_.position.set(0, 0.92, -1.15);
  console_.rotation.x = -0.3;
  const consoleBody = box('Console_Body', 0.48, 0.32, 0.05, mat.plastic);
  console_.add(consoleBody);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.24), mat.screen.clone());
  screen.name = 'Console_Screen';
  screen.position.z = 0.028;
  console_.add(screen);
  root.add(console_);

  return root;
}

/** Reformer proxy bindings — the NTPL-class sensor suite. */
export const FALLBACK_PILATES_RIG: RigConfig = {
  model: 'FALLBACK_PILATES_POC',
  bindings: [
    { nodeName: 'Carriage', role: 'carriage', channels: ['rep_rate'], sensor: { kind: 'mock', note: 'carriage position encoder' } },
    { nodeName: 'Footbar', channels: ['drive_power'], sensor: { kind: 'mock', note: 'footbar load cell' } },
    { nodeName: 'Resistance_Unit', channels: ['resistance'], sensor: { kind: 'mock', note: 'magnetic tension servo' } },
    { nodeName: 'Rail_L', channels: ['carriage_travel'], sensor: { kind: 'mock', note: 'rail optical strip' } },
    { nodeName: 'Console_Screen', role: 'console_screen', channels: [] },
  ],
};

/** The proxy builder + built-in rig for each machine kind. */
export const FALLBACKS_BY_KIND = {
  treadmill: { build: buildFallbackTreadmill, rig: FALLBACK_RIG },
  rower: { build: buildFallbackRower, rig: FALLBACK_ROWER_RIG },
  elliptical: { build: buildFallbackElliptical, rig: FALLBACK_ELLIPTICAL_RIG },
  pilates: { build: buildFallbackPilates, rig: FALLBACK_PILATES_RIG },
} as const;
