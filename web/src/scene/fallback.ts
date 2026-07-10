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

const mat = {
  frame: new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.6 }),
  plastic: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8, metalness: 0.1 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.7, metalness: 0.3 }),
  roller: new THREE.MeshStandardMaterial({ color: 0x777d86, roughness: 0.35, metalness: 0.8 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xc02428, roughness: 0.5, metalness: 0.4 }),
  screen: new THREE.MeshBasicMaterial({ color: 0x0a0c10 }),
};

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
