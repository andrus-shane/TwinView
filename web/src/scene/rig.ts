import * as THREE from 'three';
import type { ChannelStatus, RigBinding, RigConfig, TwinState } from '@twinview/shared';
import { canvasFrame } from './canvasFrames';

/** Elliptical stride ellipse semi-axes (m): pedal vertical rise and fore-aft reach */
const STRIDE_Y = 0.07;
const STRIDE_Z = 0.24;

const STATUS_TINT: Record<ChannelStatus, THREE.Color | null> = {
  ok: null,
  warn: new THREE.Color(0xd97706),
  fail: new THREE.Color(0xdc2626),
  stale: new THREE.Color(0x475569),
};

function worstStatus(binding: RigBinding, state: TwinState): ChannelStatus {
  let worst: ChannelStatus = 'ok';
  const rank = { ok: 0, stale: 1, warn: 2, fail: 3 };
  for (const ch of binding.channels) {
    const s = state.channels[ch]?.status ?? 'ok';
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 128);
  g.strokeStyle = '#37e0a0';
  g.lineWidth = 10;
  g.lineCap = 'round';
  // Apex toward canvas-bottom = texture -v = belt travel direction (rearward),
  // so the arrows point the way the belt actually moves.
  g.beginPath();
  g.moveTo(10, 16);
  g.lineTo(32, 40);
  g.lineTo(54, 16);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

interface BoundPart {
  binding: RigBinding;
  object: THREE.Object3D;
  meshes: THREE.Mesh[];
  basePos: THREE.Vector3;
}

/**
 * Seat/handle travel through one stroke cycle: 0 at the catch, 1 at the
 * finish. The drive (pull) takes ~42% of the cycle, the recovery glides back
 * over the remaining 58% — the asymmetry is what makes it read as rowing.
 */
function strokeCurve(phase: number): number {
  const drive = 0.42;
  const t = phase < drive ? phase / drive : 1 - (phase - drive) / (1 - drive);
  return t * t * (3 - 2 * t);
}

/**
 * World-space test for "this part belongs to the static console towers, not
 * the tilting platform". Tower parts live entirely outboard of the deck (the
 * column shells straddle the walkpad at |x| beyond ~80% of the machine's
 * half-width) or reach above the platform zone (~30% of machine height clears
 * the hood/light bar but not the columns, overhead beams, or console).
 * Shared by the platform pivot split and the lab-floor LOD merge so both
 * carve the machine identically.
 */
export function towerTest(machineBox: THREE.Box3): (partBox: THREE.Box3) => boolean {
  const cx = (machineBox.min.x + machineBox.max.x) / 2;
  const outboard = 0.8 * ((machineBox.max.x - machineBox.min.x) / 2);
  const lowTopY = machineBox.min.y + 0.3 * (machineBox.max.y - machineBox.min.y);
  return (b) => b.min.x - cx >= outboard || b.max.x - cx <= -outboard || b.max.y >= lowTopY;
}

/**
 * Applies twin state to the 3D model each frame: deck tilts to measured
 * incline (ghost frame shows commanded), belt flow moves at measured speed,
 * bound parts tint by deviation status, vibration shakes the part.
 */
export class RigAnimator {
  private parts: BoundPart[] = [];
  private deckPivot: THREE.Object3D | null = null; // fallback model's pre-pivoted deck
  private platformRearPivot: THREE.Object3D | null = null; // CAD: + grades hinge here
  private platformFrontPivot: THREE.Object3D | null = null; // CAD: - grades hinge here
  private platformParts: THREE.Object3D[] = [];
  private platformParent: THREE.Object3D | null = null;
  private ghostRearPivot: THREE.Object3D | null = null;
  private ghostFrontPivot: THREE.Object3D | null = null;
  private ghost: THREE.LineSegments | null = null;
  private beltTexture: THREE.Texture | null = null;
  private beltOverlayTex: THREE.Texture | null = null;
  private rollers: THREE.Object3D[] = [];
  // Spinning parts: the proxy names its flywheel with the origin on the axle;
  // CAD flywheels get wrapped in a bbox-centered pivot so they can spin too.
  private spinners: { object: THREE.Object3D; axis: THREE.Vector3 }[] = [];
  /** Rower stroke movers: position = base + dir · travel · (p − anchor) */
  private strokeSlides: {
    object: THREE.Object3D;
    base: THREE.Vector3;
    /** unit vector pointing away from the flywheel, in the object's parent space */
    dir: THREE.Vector3;
    travel: number;
    /** stroke phase p at which the object sits exactly at `base` */
    anchor: number;
  }[] = [];
  private strap: THREE.Mesh | null = null;
  private strapFollow: THREE.Object3D | null = null;
  private strapAnchorZ = 0;
  private strapBase: { scaleZ: number; posZ: number } | null = null;
  private strokePhase = 0;
  // Elliptical stride rig. CAD pedal-arm groups with a crank present are
  // pin-driven two-body movers: the group translates on the crank pin's exact
  // orbit and pitches about the pin so the roller end stays on its ramp.
  // Proxy pedals (no crank) fall back to the shared stride ellipse.
  private pedals: (
    | { mode: 'ellipse'; pivot: THREE.Object3D; corr: THREE.Vector3; phase: number }
    | { mode: 'pin'; pivot: THREE.Object3D; home: THREE.Vector3; v0y: number; v0z: number; lever: number }
  )[] = [];
  /** Arms either swing a fixed arc (proxy) or track the same-side crank pin's
   * fore-aft motion through their lower link (CAD). */
  private arms: (
    | { mode: 'swing'; object: THREE.Object3D; phase: number }
    | { mode: 'link'; object: THREE.Object3D; v0y: number; v0z: number; lever: number }
  )[] = [];
  private directArms: THREE.Object3D[] = []; // proxy arm groups whose rotation we reset on teardown
  /** Crank spider/arms: absolute angle is phase-locked to the pedal orbit */
  private cranks: { pivot: THREE.Object3D; axis: THREE.Vector3 }[] = [];
  /** Crank axle center (modelRoot-local) — anchors the pin-driven pedal math */
  private crankCenter: THREE.Vector3 | null = null;
  /** Per-side pedal phases so fallback arms can swing exactly opposite their pedal */
  private pedalPhaseBySide: { pos?: number; neg?: number } = {};
  /** Per-side crank-pin rest vectors for the link-driven arms */
  private pedalPinBySide: { pos?: { v0y: number; v0z: number }; neg?: { v0y: number; v0z: number } } = {};
  private stridePhase = 0;
  // Pilates rep rig: carriage slides out-and-back, spring pack stretches to it
  private carriages: { object: THREE.Object3D; base: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  private springs: { mesh: THREE.Mesh; anchorZ: number; base: { scaleZ: number; posZ: number } } | null = null;
  /** CAD coil springs: scaled along z about their fixed-end pivot as the carriage slides */
  private springStretches: { pivot: THREE.Object3D; baseLen: number }[] = [];
  /** carriage whose front edge the spring pack chases (+offset from its origin) */
  private springsFollow: { object: THREE.Object3D; offset: number } | null = null;
  private repPhase = 0;
  /** CAD parts we moved under animation pivots — teardown puts them back */
  private reparents: {
    pivot: THREE.Object3D;
    parts: THREE.Object3D[];
    parent: THREE.Object3D;
    home: THREE.Vector3;
  }[] = [];
  private consoleTex: THREE.CanvasTexture | null = null;
  private consoleTexSize = { w: 0, h: 0 };
  private consoleFrame = -1; // last canvas frame uploaded to the GPU
  private disposables: { dispose(): void }[] = [];
  private overlays: THREE.Object3D[] = [];
  private time = 0;

  constructor(private modelRoot: THREE.Object3D) {}

  setConsoleCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) {
      // detach (unit lost focus) — next setRig leaves the screen dark
      this.consoleTex?.dispose();
      this.consoleTex = null;
      this.consoleTexSize = { w: 0, h: 0 };
      return;
    }
    if (this.consoleTex) {
      // swap in place so materials created in setupConsoleScreen keep their map
      this.consoleTex.image = canvas;
      this.consoleTex.needsUpdate = true;
    } else {
      this.consoleTex = new THREE.CanvasTexture(canvas);
      this.consoleTex.colorSpace = THREE.SRGBColorSpace;
    }
    this.consoleFrame = -1;
  }

  hasConsole(): boolean {
    return this.consoleTex !== null;
  }

  /** True when this exact canvas is already the console source (idempotent wiring). */
  consoleIs(canvas: HTMLCanvasElement): boolean {
    return this.consoleTex?.image === canvas;
  }

  setRig(rig: RigConfig): void {
    this.teardown();
    // Overlay/pivot positions are computed from world-space bboxes and stored
    // in modelRoot-local space — the root sits at a lab bay offset, so the
    // whole subtree needs current matrices. Descendants included: setRig often
    // runs in the same task that created or reparented the model (LOD instance
    // into a bay, cadGroup hopping bays), before any render has composed them.
    this.modelRoot.updateWorldMatrix(true, true);
    // CAD stroke parts (rower) need the flywheel's position to know which way
    // the drive goes — collect during the loop, wire up in the post-pass.
    let cadSeat: { object: THREE.Object3D; attached: THREE.Object3D[] } | null = null;
    let cadHandle: { object: THREE.Object3D; attached: THREE.Object3D[] } | null = null;
    let flywheelCenter: THREE.Vector3 | null = null;
    const pedalParts: { object: THREE.Object3D; attached: THREE.Object3D[] }[] = [];
    const armParts: { object: THREE.Object3D; attached: THREE.Object3D[] }[] = [];
    const springParts: THREE.Object3D[] = [];

    for (const binding of rig.bindings) {
      const object = this.modelRoot.getObjectByName(binding.nodeName);
      if (!object) continue;
      const attached = this.resolveAttach(binding, object);

      const meshes: THREE.Mesh[] = [];
      object.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
      // clone materials so status tinting can't bleed into shared CAD materials
      for (const m of meshes) {
        if (Array.isArray(m.material)) m.material = m.material.map((x) => x.clone());
        else m.material = m.material.clone();
      }
      this.parts.push({ binding, object, meshes, basePos: object.position.clone() });

      switch (binding.role) {
        case 'deck':
          this.setupDeck(object);
          break;
        case 'belt':
          this.setupBelt(object, meshes);
          break;
        case 'roller':
          // Spinning rotates around the node's local origin, which only the
          // fallback model guarantees is the cylinder axis — CAD part origins
          // are arbitrary, so a "spin" would orbit the part out of the machine.
          // CAD rollers are hidden under covers anyway; keep them tint-only.
          if (object.name.startsWith('Roller_')) this.rollers.push(object);
          break;
        case 'console_screen':
          this.setupConsoleScreen(object, meshes);
          break;
        case 'flywheel':
          flywheelCenter = this.setupFlywheel(object, attached);
          break;
        case 'crank':
          this.setupCrank(object, attached);
          break;
        case 'seat':
          if (object.name === 'Seat') {
            // proxy: origin on the rail, machine front at -z → drive is +z
            this.strokeSlides.push({
              object,
              base: object.position.clone(),
              dir: new THREE.Vector3(0, 0, 1),
              travel: 0.5,
              anchor: 0,
            });
          } else {
            cadSeat = { object, attached };
          }
          break;
        case 'handle':
          if (object.name === 'Handle') {
            this.strokeSlides.push({
              object,
              base: object.position.clone(),
              dir: new THREE.Vector3(0, 0, 1),
              travel: 0.85,
              anchor: 0,
            });
            this.strapFollow = object;
            const strap = this.modelRoot.getObjectByName('Drive_Strap') as THREE.Mesh | undefined;
            if (strap) {
              this.strap = strap;
              this.strapBase = { scaleZ: strap.scale.z, posZ: strap.position.z };
              // strap geometry is unit-length in Z; its fixed end sits at the housing exit
              this.strapAnchorZ = strap.position.z - strap.scale.z / 2;
            }
          } else {
            cadHandle = { object, attached };
          }
          break;
        case 'pedal':
          pedalParts.push({ object, attached });
          break;
        case 'arm':
          armParts.push({ object, attached });
          break;
        case 'carriage':
          this.setupCarriage(object, attached);
          break;
        case 'spring':
          springParts.push(object, ...attached);
          break;
      }
    }
    this.setupCadStroke(cadSeat, cadHandle, flywheelCenter);
    this.setupPedals(pedalParts);
    this.setupArms(armParts);
    this.setupSpringStretch(springParts);
    this.attachOverlaysToDeck();
    // Reparenting under the platform pivots rewrites local positions, so the
    // vibration rest poses must be captured after the pivots are built.
    for (const p of this.parts) p.basePos.copy(p.object.position);
  }

  /** Wrap a CAD part in a pivot parented to modelRoot at `at` (modelRoot-local),
   * so it can rotate/translate cleanly regardless of its own origin. */
  private wrapInPivot(object: THREE.Object3D, at: THREE.Vector3, name: string): THREE.Object3D {
    return this.wrapGroupInPivot([object], at, name);
  }

  /** Wrap several CAD parts in one pivot so they move as a rigid group. */
  private wrapGroupInPivot(objects: THREE.Object3D[], at: THREE.Vector3, name: string): THREE.Object3D {
    const parent = objects[0].parent ?? this.modelRoot;
    const pivot = new THREE.Object3D();
    pivot.name = name;
    pivot.position.copy(at);
    this.modelRoot.add(pivot);
    pivot.updateWorldMatrix(true, false);
    for (const o of objects) pivot.attach(o);
    this.reparents.push({ pivot, parts: [...objects], parent, home: at.clone() });
    return pivot;
  }

  /** Resolve a binding's attach list to live scene nodes (deduped, sans the bound part). */
  private resolveAttach(binding: RigBinding, bound: THREE.Object3D): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const name of binding.attach ?? []) {
      const o = this.modelRoot.getObjectByName(name);
      if (o && o !== bound && !out.includes(o)) out.push(o);
    }
    return out;
  }

  /** The bound wheel's bbox center and thinnest axis = the axle. Attached parts
   * ride the same pivot, so their bboxes must not skew the axle estimate. */
  private wheelPivotFrame(object: THREE.Object3D): { center: THREE.Vector3; axis: THREE.Vector3 } {
    const bbox = new THREE.Box3().setFromObject(object);
    const center = this.modelRoot.worldToLocal(bbox.getCenter(new THREE.Vector3()));
    const size = bbox.getSize(new THREE.Vector3());
    const axis =
      size.x <= size.y && size.x <= size.z
        ? new THREE.Vector3(1, 0, 0)
        : size.y <= size.z
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
    return { center, axis };
  }

  /** Proxy flywheels spin in place; CAD flywheels spin via a bbox-centered pivot
   * around their thinnest axis. Returns the wheel center (modelRoot-local). */
  private setupFlywheel(object: THREE.Object3D, attached: THREE.Object3D[]): THREE.Vector3 {
    if (object.name === 'Flywheel') {
      const bbox = new THREE.Box3().setFromObject(object);
      const center = this.modelRoot.worldToLocal(bbox.getCenter(new THREE.Vector3()));
      this.spinners.push({ object, axis: new THREE.Vector3(1, 0, 0) });
      return center;
    }
    const { center, axis } = this.wheelPivotFrame(object);
    const pivot = this.wrapGroupInPivot([object, ...attached], center, '__flywheel_pivot__');
    this.spinners.push({ object: pivot, axis });
    return center;
  }

  /** Crank spider/arms: one rigid group spinning about the axle, phase-locked to
   * the stride so the crank pins track the orbiting pedal groups. */
  private setupCrank(object: THREE.Object3D, attached: THREE.Object3D[]): void {
    const { center, axis } = this.wheelPivotFrame(object);
    const pivot = this.wrapGroupInPivot([object, ...attached], center, '__crank_pivot__');
    this.cranks.push({ pivot, axis });
    this.crankCenter ??= center.clone();
  }

  /**
   * CAD rower stroke: the seat is one flat part in a sled of ~40 small carriage
   * pieces (wheels, tubes, bearings) — gather everything clustered around it
   * into one carriage pivot and slide that. The handle slides alone (its rest
   * cradle sits right under it and must stay). Drive direction is away from
   * the flywheel; without a flywheel binding the parts stay tint-only.
   */
  private setupCadStroke(
    seat: { object: THREE.Object3D; attached: THREE.Object3D[] } | null,
    handle: { object: THREE.Object3D; attached: THREE.Object3D[] } | null,
    flywheelCenter: THREE.Vector3 | null,
  ): void {
    if (!flywheelCenter || (!seat && !handle)) return;

    if (seat) {
      // An authored attach list defines the sled exactly; the capture-box
      // heuristic is the fallback for rigs that haven't been annotated yet.
      let pivot: THREE.Object3D;
      let centerZ: number;
      if (seat.attached.length > 0) {
        pivot = this.wrapGroupInPivot([seat.object, ...seat.attached], new THREE.Vector3(), '__sled__');
        const box = new THREE.Box3().setFromObject(seat.object);
        centerZ = this.modelRoot.worldToLocal(box.getCenter(new THREE.Vector3())).z;
      } else {
        ({ pivot, centerZ } = this.captureSled(seat.object, 0.2, 0.15, 0.15, 0.06, handle?.object ?? null));
      }
      const away = Math.sign(centerZ - flywheelCenter.z) || 1;
      // Which end of the stroke is the CAD pose? A seat posed in the front
      // half of the machine (near the flywheel) is parked at the catch and
      // slides aft from there; one posed aft is at the finish and the catch
      // pulls it toward the flywheel.
      const mb = new THREE.Box3().setFromObject(this.modelRoot);
      const anchor =
        Math.abs(centerZ - flywheelCenter.z) < mb.getSize(new THREE.Vector3()).z / 2 ? 0 : 1;
      this.strokeSlides.push({
        object: pivot,
        base: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, away),
        travel: 0.5,
        anchor,
      });
    }

    if (handle) {
      const hBox = new THREE.Box3().setFromObject(handle.object);
      const hCenter = this.modelRoot.worldToLocal(hBox.getCenter(new THREE.Vector3()));
      const away = Math.sign(hCenter.z - flywheelCenter.z) || 1;
      const pivot = this.wrapGroupInPivot(
        [handle.object, ...handle.attached],
        new THREE.Vector3(),
        '__handle_slide__',
      );
      // rest cradle pose is roughly mid-pull
      this.strokeSlides.push({
        object: pivot,
        base: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, away),
        travel: 0.8,
        anchor: 0.5,
      });
    }
  }

  /**
   * Gather the CAD parts clustered around a bound sliding part (a rower seat's
   * wheels/tubes or a reformer carriage's foam/blocks) into one pivot so the
   * whole sled moves together. Parts much longer along the travel axis than
   * the bound part are the rails/covers the sled rides on — those stay put.
   * Returns the pivot (home at origin) and the sled's modelRoot-local center z.
   */
  private captureSled(
    bound: THREE.Object3D,
    expandX: number,
    expandUp: number,
    expandDown: number,
    expandZ: number,
    exclude: THREE.Object3D | null = null,
  ): { pivot: THREE.Object3D; centerZ: number } {
    const asm = bound.parent ?? this.modelRoot;
    const boundBox = new THREE.Box3().setFromObject(bound);
    const boundSizeZ = boundBox.getSize(new THREE.Vector3()).z;
    const capture = boundBox.clone();
    capture.min.x -= expandX;
    capture.max.x += expandX;
    capture.min.y -= expandDown;
    capture.max.y += expandUp;
    capture.min.z -= expandZ;
    capture.max.z += expandZ;

    const sled: THREE.Object3D[] = [bound];
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const part of [...asm.children]) {
      if (!part.name || part.name.startsWith('__') || part === bound || part === exclude) continue;
      box.setFromObject(part);
      if (box.isEmpty()) continue;
      if (box.getSize(v).z > boundSizeZ * 1.1 + 0.05) continue; // rail-length parts stay
      if (capture.containsPoint(box.getCenter(v))) sled.push(part);
    }
    const pivot = new THREE.Object3D();
    pivot.name = '__sled__';
    this.modelRoot.add(pivot);
    pivot.updateWorldMatrix(true, false);
    for (const part of sled) pivot.attach(part);
    this.reparents.push({ pivot, parts: sled, parent: asm, home: new THREE.Vector3() });
    return {
      pivot,
      centerZ: this.modelRoot.worldToLocal(boundBox.getCenter(new THREE.Vector3())).z,
    };
  }

  /**
   * Reformer carriage: slides out-and-back along the rails each rep. The proxy
   * carriage slides in place (rearward, away from the -z footbar) and drags
   * the spring pack; a CAD carriage gathers its clustered sled parts (foam,
   * shoulder blocks, wheel mounts) and slides away from the machine's console
   * end toward the open rail.
   */
  private setupCarriage(object: THREE.Object3D, attached: THREE.Object3D[] = []): void {
    if (object.name === 'Carriage') {
      this.carriages.push({
        object,
        base: object.position.clone(),
        dir: new THREE.Vector3(0, 0, 1),
      });
      const springs = this.modelRoot.getObjectByName('Springs') as THREE.Mesh | undefined;
      if (springs) {
        const bbox = new THREE.Box3().setFromObject(object);
        const c = bbox.getCenter(new THREE.Vector3());
        // carriage front edge (toward the -z footbar), in modelRoot space
        const frontZ = this.modelRoot.worldToLocal(new THREE.Vector3(c.x, c.y, bbox.min.z)).z;
        this.springs = {
          mesh: springs,
          anchorZ: springs.position.z - springs.scale.z / 2,
          base: { scaleZ: springs.scale.z, posZ: springs.position.z },
        };
        this.springsFollow = { object, offset: frontZ - object.position.z };
      }
      return;
    }
    // CAD: authored attach list wins; otherwise sled capture (shoulder blocks
    // sit well above the platform — expand up; belly covers under the rail
    // must stay — tight downward)
    const asm = object.parent ?? this.modelRoot;
    const machineBox = new THREE.Box3().setFromObject(asm);
    const machineZ = this.modelRoot.worldToLocal(machineBox.getCenter(new THREE.Vector3())).z;
    let pivot: THREE.Object3D;
    let centerZ: number;
    if (attached.length > 0) {
      pivot = this.wrapGroupInPivot([object, ...attached], new THREE.Vector3(), '__sled__');
      const box = new THREE.Box3().setFromObject(object);
      centerZ = this.modelRoot.worldToLocal(box.getCenter(new THREE.Vector3())).z;
    } else {
      ({ pivot, centerZ } = this.captureSled(object, 0.15, 0.28, 0.1, 0.07));
    }
    const away = Math.sign(machineZ - centerZ) || 1;
    this.carriages.push({ object: pivot, base: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, away) });
  }

  /**
   * CAD coil springs run from the spring housing (fixed) to the carriage
   * underside. Each spring gets a pivot at its fixed end — the face opposite
   * the carriage's travel direction — and stretches by scaling z, tracking the
   * same rep displacement the carriage rides.
   */
  private setupSpringStretch(parts: THREE.Object3D[]): void {
    if (parts.length === 0) return;
    const dir = this.carriages[0]?.dir;
    if (!dir) return;
    for (const part of parts) {
      const bbox = new THREE.Box3().setFromObject(part);
      if (bbox.isEmpty()) continue;
      const anchor = bbox.getCenter(new THREE.Vector3());
      anchor.z = dir.z < 0 ? bbox.max.z : bbox.min.z;
      const at = this.modelRoot.worldToLocal(anchor);
      const pivot = this.wrapGroupInPivot([part], at, '__spring_stretch__');
      const len = bbox.getSize(new THREE.Vector3()).z;
      this.springStretches.push({ pivot, baseLen: Math.max(0.05, len) });
    }
  }

  /**
   * CAD pedals with a crank rig ride the crank pin exactly: the pin joint is
   * the group cluster nearest the crank axle, the CAD pose is its rest angle,
   * and each frame the group translates by the pin's orbit offset (so it can
   * never shear off the crank arm) and pitches about the pin so the far
   * (roller) end stays on the ramp instead of orbiting through the air.
   * Without a crank, pedals orbit the legacy shared stride ellipse: a
   * correction vector pulls both onto the midpoint path and each pedal's
   * phase is solved from its rest offset so the pose never snaps at focus.
   */
  private setupPedals(pedalParts: { object: THREE.Object3D; attached: THREE.Object3D[] }[]): void {
    if (pedalParts.length === 0) return;
    const C = this.crankCenter;
    const isCad = !pedalParts.some((p) => p.object.name.startsWith('Pedal_'));

    if (C && isCad) {
      for (const part of pedalParts) {
        const group = [part.object, ...part.attached];
        const centers: THREE.Vector3[] = [];
        for (const o of group) {
          const b = new THREE.Box3().setFromObject(o);
          if (!b.isEmpty()) centers.push(this.modelRoot.worldToLocal(b.getCenter(new THREE.Vector3())));
        }
        if (centers.length === 0) continue;
        let pin = centers[0];
        for (const c of centers) {
          if (Math.hypot(c.y - C.y, c.z - C.z) < Math.hypot(pin.y - C.y, pin.z - C.z)) pin = c;
        }
        // signed z-distance to the group's far end: the lever that converts
        // pin lift into the pitch keeping the roller end at ramp height
        let lever = 0;
        for (const c of centers) if (Math.abs(c.z - pin.z) > Math.abs(lever)) lever = c.z - pin.z;
        const pivot = this.wrapGroupInPivot(group, pin, '__pedal_pivot__');
        const v0y = pin.y - C.y;
        const v0z = pin.z - C.z;
        this.pedals.push({ mode: 'pin', pivot, home: pin.clone(), v0y, v0z, lever });
        const bc = this.modelRoot.worldToLocal(
          new THREE.Box3().setFromObject(part.object).getCenter(new THREE.Vector3()),
        );
        this.pedalPinBySide[bc.x >= 0 ? 'pos' : 'neg'] = { v0y, v0z };
      }
      return;
    }

    const centers = pedalParts.map((p) =>
      this.modelRoot.worldToLocal(new THREE.Box3().setFromObject(p.object).getCenter(new THREE.Vector3())),
    );
    const mid = centers
      .reduce((acc, c) => acc.add(c), new THREE.Vector3())
      .divideScalar(centers.length);
    pedalParts.forEach((part, i) => {
      const pivot = this.wrapGroupInPivot(
        [part.object, ...part.attached],
        new THREE.Vector3(),
        '__pedal_pivot__',
      );
      const corr = new THREE.Vector3(0, mid.y - centers[i].y, mid.z - centers[i].z);
      // rest offset in ellipse units; degenerate (proxy pedals share one pose)
      // falls back to a fixed quarter-phase so the sides stay half a cycle apart
      const dy = (centers[i].y - mid.y) / STRIDE_Y;
      const dz = (centers[i].z - mid.z) / STRIDE_Z;
      const phase =
        Math.hypot(dy, dz) > 0.5
          ? Math.atan2(dy, dz)
          : centers[i].x >= 0
            ? Math.PI / 2
            : Math.PI * 1.5;
      this.pedalPhaseBySide[centers[i].x >= 0 ? 'pos' : 'neg'] = phase;
      this.pedals.push({ mode: 'ellipse', pivot, corr, phase });
    });
  }

  /** Arm poles swing about their physical hinge. When the same side has a
   * crank pin (CAD elliptical), the swing angle is solved so the lower link's
   * bottom tracks the pedal arm's fore-aft motion exactly; otherwise the arm
   * swings a fixed arc opposite its side's pedal (proxy fallback). */
  private setupArms(armParts: { object: THREE.Object3D; attached: THREE.Object3D[] }[]): void {
    for (const part of armParts) {
      const bbox = new THREE.Box3().setFromObject(part.object);
      const centerWorld = bbox.getCenter(new THREE.Vector3());
      const center = this.modelRoot.worldToLocal(centerWorld.clone());
      const side = center.x >= 0 ? ('pos' as const) : ('neg' as const);
      if (part.object.name.startsWith('Arm_')) {
        const pedalPhase = this.pedalPhaseBySide[side] ?? (center.x >= 0 ? Math.PI / 2 : Math.PI * 1.5);
        this.directArms.push(part.object);
        this.arms.push({ mode: 'swing', object: part.object, phase: pedalPhase + Math.PI });
        continue;
      }
      const at = this.armHinge(bbox, centerWorld, part.attached);
      const pivot = this.wrapGroupInPivot([part.object, ...part.attached], at, '__arm_pivot__');
      const pin = this.pedalPinBySide[side];
      if (pin) {
        // lever = hinge to the lowest cluster in the group (the link bottom
        // that rides the pedal arm)
        let bottomY = at.y;
        for (const o of [part.object, ...part.attached]) {
          const b = new THREE.Box3().setFromObject(o);
          if (b.isEmpty()) continue;
          const c = this.modelRoot.worldToLocal(b.getCenter(new THREE.Vector3()));
          if (c.y < bottomY) bottomY = c.y;
        }
        this.arms.push({ mode: 'link', object: pivot, v0y: pin.v0y, v0z: pin.v0z, lever: Math.max(0.2, at.y - bottomY) });
      } else {
        const pedalPhase = this.pedalPhaseBySide[side] ?? (center.x >= 0 ? Math.PI / 2 : Math.PI * 1.5);
        this.arms.push({ mode: 'swing', object: pivot, phase: pedalPhase + Math.PI });
      }
    }
  }

  /**
   * Where a CAD arm pole physically hinges. Pendulum arms hang from a mast
   * mount at the pole top. Bell-crank arms (pole up, connecting link down to
   * the pedal arm) pivot at the pole BOTTOM instead — swinging those from the
   * top would sweep the hub hardware off its shaft on a huge arc. The hinge
   * hardware in the attach list (joint clamshells, sleeves, bearings) wraps
   * the pole's bottom end, so its union box centers the pivot; without such
   * parts, fall back to the mast-mount pivot just under the pole top.
   */
  private armHinge(
    poleBox: THREE.Box3,
    poleCenterWorld: THREE.Vector3,
    attached: THREE.Object3D[],
  ): THREE.Vector3 {
    const wrap = new THREE.Box3();
    const b = new THREE.Box3();
    for (const o of attached) {
      b.setFromObject(o);
      if (b.isEmpty()) continue;
      if (b.min.y <= poleBox.min.y && b.max.y >= poleBox.min.y) wrap.union(b);
    }
    const at = wrap.isEmpty()
      ? new THREE.Vector3(poleCenterWorld.x, poleBox.max.y - 0.03, poleCenterWorld.z)
      : wrap.getCenter(new THREE.Vector3());
    return this.modelRoot.worldToLocal(at);
  }

  /** The belt-flow overlay plane hovers over the belt, so it must ride the
   * platform pivots. The console screen overlay stays on the static towers. */
  private attachOverlaysToDeck(): void {
    if (!this.platformRearPivot) return;
    const o = this.modelRoot.getObjectByName('__belt_flow__');
    if (o && o.parent !== this.platformRearPivot) this.platformRearPivot.attach(o);
  }

  private setupDeck(object: THREE.Object3D): void {
    // Fallback model's Deck_Assembly is already pivoted at the rear. For CAD,
    // match the physical NTL99925: the console towers stay planted while the
    // platform assembly (deck, belt, motor tray, hood, side rails) tilts —
    // positive grades hinge on the REAR ground contact (front lifts on its
    // incline legs), negative grades hinge on the FRONT contact (the rear of
    // the walkpad rides up on its casters).
    // a second deck binding would re-wrap the already-pivoted assembly
    if (this.deckPivot || this.platformRearPivot) return;

    // All positions below are modelRoot-LOCAL: the root sits at a lab bay
    // offset, so raw world coordinates would double-apply that offset.
    let frontPos: THREE.Vector3;
    let rearPos: THREE.Vector3;
    if (object.name === 'Deck_Assembly') {
      this.deckPivot = object;
      rearPos = this.modelRoot.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
      frontPos = rearPos.clone();
    } else {
      ({ frontPos, rearPos } = this.setupPlatformPivots(object));
    }

    // Ghost wireframe at the COMMANDED angle — sized to the deck part so it
    // reads as "where the platform should be", not a machine-sized box.
    const bbox = new THREE.Box3().setFromObject(object);
    const size = bbox.getSize(new THREE.Vector3());
    const center = this.modelRoot.worldToLocal(bbox.getCenter(new THREE.Vector3()));
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    // depthTest off + high renderOrder: the "where it should be" outline must
    // read THROUGH the machine shell, or it's invisible inside the covers.
    const mat = new THREE.LineBasicMaterial({
      color: 0x4ea1ff,
      transparent: true,
      opacity: 0.0,
      depthTest: false,
    });
    this.ghost = new THREE.LineSegments(geo, mat);
    this.ghost.renderOrder = 999;
    // Line raycasting uses a fat world-space threshold — an invisible ghost box
    // would swallow every click on the model. Never pickable.
    this.ghost.raycast = () => undefined;
    this.ghost.name = '__deck_ghost__';
    this.disposables.push(geo, mat);

    this.ghostFrontPivot = new THREE.Object3D();
    this.ghostFrontPivot.position.copy(frontPos);
    this.ghostRearPivot = new THREE.Object3D();
    this.ghostRearPivot.position.copy(rearPos).sub(frontPos);
    this.ghost.position.copy(center).sub(rearPos);
    this.ghostRearPivot.add(this.ghost);
    this.ghostFrontPivot.add(this.ghostRearPivot);
    this.modelRoot.add(this.ghostFrontPivot);
    this.overlays.push(this.ghostFrontPivot);
  }

  /**
   * Split the flat CAD assembly into the tilting platform and the static
   * towers, and hinge the platform on ground-contact pivots at both ends.
   * Tower parts are the ones that live entirely outboard of the deck (the
   * column shells and their cladding straddle the walkpad at |x| beyond ~80%
   * of the machine's half-width) or reach above the platform zone (~30% of
   * machine height clears the hood/light bar but not the columns, overhead
   * beams, or console). Everything else — deck, belt, rollers, motor tray,
   * hood, side rails, end caps — tilts. Validated against the NTL99925 GLB:
   * the split puts all 770 low inboard parts on the platform and all 588
   * column/console parts on the towers.
   */
  private setupPlatformPivots(deckPart: THREE.Object3D): {
    frontPos: THREE.Vector3;
    rearPos: THREE.Vector3;
  } {
    const asm = deckPart.parent ?? this.modelRoot;
    const mb = new THREE.Box3().setFromObject(asm);
    const isTower = towerTest(mb);

    const box = new THREE.Box3();
    const platBox = new THREE.Box3();
    const platform: THREE.Object3D[] = [];
    for (const part of [...asm.children]) {
      if (!part.name || part.name.startsWith('__')) continue;
      box.setFromObject(part);
      if (box.isEmpty()) continue;
      if (!isTower(box)) {
        platform.push(part);
        platBox.union(box);
      }
    }
    if (platform.length === 0) {
      // pathological model — tilt at least the bound deck part
      platform.push(deckPart);
      platBox.setFromObject(deckPart);
    }

    const py = Math.max(mb.min.y, 0);
    const cx = (mb.min.x + mb.max.x) / 2;
    const frontPivot = new THREE.Object3D();
    frontPivot.name = '__platform_pivot_front__';
    // world-space hinge point → modelRoot-local (the pivot's parent space)
    frontPivot.position.copy(this.modelRoot.worldToLocal(new THREE.Vector3(cx, py, platBox.min.z)));
    const rearPivot = new THREE.Object3D();
    rearPivot.name = '__platform_pivot_rear__';
    rearPivot.position.set(0, 0, platBox.max.z - platBox.min.z);
    frontPivot.add(rearPivot);
    this.modelRoot.add(frontPivot);
    for (const part of platform) rearPivot.attach(part);

    this.platformFrontPivot = frontPivot;
    this.platformRearPivot = rearPivot;
    this.platformParts = platform;
    this.platformParent = asm;
    this.overlays.push(frontPivot); // teardown reattaches parts, then removes

    return {
      frontPos: frontPivot.position.clone(),
      rearPos: frontPivot.position.clone().add(rearPivot.position),
    };
  }

  private setupBelt(object: THREE.Object3D, meshes: THREE.Mesh[]): void {
    const texHost = meshes.find((m) => m.userData.scrollTexture);
    if (texHost) {
      // fallback model: scroll the actual belt texture
      this.beltTexture = texHost.userData.scrollTexture as THREE.Texture;
      // re-cloned material above lost the shared map reference — restore it
      for (const m of meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.map) {
          mat.map = this.beltTexture;
        }
      }
      return;
    }
    // CAD model: animated chevron flow overlay floating above the belt surface
    const bbox = new THREE.Box3().setFromObject(object);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const tex = chevronTexture();
    tex.repeat.set(1, Math.max(2, Math.round(size.z / 0.2)));
    this.beltOverlayTex = tex;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(size.x, size.z) * 0.4, Math.max(size.x, size.z)),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    if (size.x > size.z) plane.rotation.z = Math.PI / 2;
    plane.position.copy(this.modelRoot.worldToLocal(new THREE.Vector3(center.x, bbox.max.y + 0.01, center.z)));
    plane.name = '__belt_flow__';
    plane.raycast = () => undefined; // not selectable
    this.modelRoot.add(plane);
    this.overlays.push(plane);
    this.disposables.push(plane.geometry, plane.material as THREE.Material, tex);
  }

  private setupConsoleScreen(object: THREE.Object3D, meshes: THREE.Mesh[]): void {
    if (!this.consoleTex) return;
    const hasUVs = meshes.some((m) => m.geometry.getAttribute('uv'));
    if (hasUVs) {
      for (const m of meshes) {
        // stash the dark screen material so teardown can put it back on blur
        if (!m.userData.__screenMat) m.userData.__screenMat = m.material;
        const mat = new THREE.MeshBasicMaterial({ map: this.consoleTex, toneMapped: false });
        this.disposables.push(mat);
        m.material = mat;
      }
      return;
    }
    // CAD tessellation has no UVs, so a mapped material renders nothing.
    // Project a screen-sized overlay plane onto the panel's front face instead.
    const bbox = new THREE.Box3().setFromObject(object);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const mat = new THREE.MeshBasicMaterial({ map: this.consoleTex, toneMapped: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size.x * 0.94, size.y * 0.9), mat);
    // the user stands on the deck at +z, so the screen faces +z
    plane.position.copy(this.modelRoot.worldToLocal(new THREE.Vector3(center.x, center.y, bbox.max.z + 0.004)));
    plane.name = '__console_screen__';
    plane.raycast = () => undefined;
    this.modelRoot.add(plane);
    this.overlays.push(plane);
    this.disposables.push(plane.geometry, mat);
  }

  update(dt: number, state: TwinState | null): void {
    if (!state) return;
    this.time += dt;

    // channels are kind-partial: a rower state has no belt/incline and vice versa
    const measSpeed = state.channels.belt_speed?.meas ?? 0;
    const measIncline = state.channels.incline?.meas ?? 0;
    const cmdIncline = state.channels.incline?.cmd ?? 0;

    // belt flow at measured speed (mph → texture units; direction: toward the rear)
    const scroll = measSpeed * dt * 0.9;
    if (this.beltTexture) this.beltTexture.offset.y -= scroll;
    if (this.beltOverlayTex) this.beltOverlayTex.offset.y += scroll;

    for (const r of this.rollers) r.rotation.x -= measSpeed * dt * 4;

    // deck tilt: measured on the model, commanded on the ghost. The fallback
    // tilts only its stylized deck sub-assembly, so it exaggerates 2x to read;
    // the CAD platform tilts at true scale, which already reads clearly.
    // Positive grades hinge on the rear pivot (front lifts), negative on the
    // front pivot (rear lifts) — matching the physical machine.
    const gain = this.deckPivot ? 2 : 1;
    const measAngle = Math.atan(measIncline / 100) * gain;
    const cmdAngle = Math.atan(cmdIncline / 100) * gain;
    if (this.deckPivot) this.deckPivot.rotation.x = measAngle;
    if (this.platformRearPivot && this.platformFrontPivot) {
      this.platformRearPivot.rotation.x = Math.max(0, measAngle);
      this.platformFrontPivot.rotation.x = Math.min(0, measAngle);
    }
    if (this.ghostRearPivot && this.ghostFrontPivot && this.ghost) {
      if (this.deckPivot) {
        this.ghostRearPivot.rotation.x = cmdAngle; // fallback: single rear hinge
      } else {
        this.ghostRearPivot.rotation.x = Math.max(0, cmdAngle);
        this.ghostFrontPivot.rotation.x = Math.min(0, cmdAngle);
      }
      const gap = Math.abs(measIncline - cmdIncline);
      const mat = this.ghost.material as THREE.LineBasicMaterial;
      const active = state.running || state.setpoints.speed > 0 || gap > 0.2;
      mat.opacity =
        !active ? 0 : gap > (state.channels.incline?.warnTol ?? 0.5) ? 0.75 + 0.25 * Math.sin(this.time * 6) : 0.3;
    }

    // --- Flywheels: measured rpm (rower) or geared cadence (elliptical) ---
    const strideRate = state.channels.stride_rate?.meas ?? 0;
    const flyRpm = state.channels.flywheel_speed?.meas ?? strideRate * 6;
    for (const f of this.spinners) f.object.rotateOnAxis(f.axis, -flyRpm * dt * ((Math.PI * 2) / 60));

    // --- Rower stroke cycle: seat + handle ride the phase ---
    if (this.strokeSlides.length > 0) {
      const strokeRate = state.channels.stroke_rate?.meas ?? 0;
      if (strokeRate > 2) {
        this.strokePhase = (this.strokePhase + (strokeRate / 60) * dt) % 1;
      } else if (this.strokePhase > 0) {
        // rate hit zero mid-stroke: glide the rest of the way back to the catch
        const next = this.strokePhase + (8 / 60) * dt;
        this.strokePhase = next >= 1 ? 0 : next;
      }
      const p = strokeCurve(this.strokePhase);
      for (const s of this.strokeSlides) {
        s.object.position.copy(s.base).addScaledVector(s.dir, s.travel * (p - s.anchor));
      }
      if (this.strap && this.strapFollow) {
        const len = Math.max(0.05, this.strapFollow.position.z - this.strapAnchorZ);
        this.strap.scale.z = len;
        this.strap.position.z = this.strapAnchorZ + len / 2;
      }
    }

    // --- Reformer rep cycle: carriage glides out and back, springs stretch ---
    if (this.carriages.length > 0) {
      const repRate = state.channels.rep_rate?.meas ?? 0;
      if (repRate > 1.5) {
        this.repPhase = (this.repPhase + (repRate / 60) * dt) % 1;
      } else if (this.repPhase > 0) {
        const next = this.repPhase + (6 / 60) * dt;
        this.repPhase = next >= 1 ? 0 : next;
      }
      // measured travel drives the visible stroke — a dragging carriage reads short
      const travelM = Math.min(0.8, Math.max(0.15, (state.channels.carriage_travel?.meas ?? 60) / 100));
      const q = 0.5 * (1 - Math.cos(this.repPhase * Math.PI * 2));
      for (const c of this.carriages) {
        c.object.position.copy(c.base).addScaledVector(c.dir, travelM * q);
      }
      if (this.springs && this.springsFollow) {
        const front = this.springsFollow.object.position.z + this.springsFollow.offset;
        const len = Math.max(0.05, front - this.springs.anchorZ);
        this.springs.mesh.scale.z = len;
        this.springs.mesh.position.z = this.springs.anchorZ + len / 2;
      }
      // CAD coil springs: fixed end stays at the housing, the coil stretches
      // by the same displacement the carriage rode away
      for (const s of this.springStretches) {
        s.pivot.scale.z = 1 + (travelM * q) / s.baseLen;
      }
    }

    // --- Elliptical stride cycle: pedals orbit, arm poles swing opposite,
    //     crank turns phase-locked so its pins track the pedal orbits ---
    if (this.pedals.length > 0 || this.arms.length > 0 || this.cranks.length > 0) {
      if (strideRate > 2) {
        this.stridePhase = (this.stridePhase + (strideRate / 60) * dt) % 1;
      } else if (this.stridePhase > 0) {
        const next = this.stridePhase + (10 / 60) * dt;
        this.stridePhase = next >= 1 ? 0 : next;
      }
      const theta = this.stridePhase * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      for (const ped of this.pedals) {
        if (ped.mode === 'pin') {
          // pin offset = R_x(−θ)·v0 − v0: the exact orbit of the crank pin the
          // arm is bolted to, so the joint can never shear open
          const dy = ped.v0y * cosT + ped.v0z * sinT - ped.v0y;
          const dz = -ped.v0y * sinT + ped.v0z * cosT - ped.v0z;
          ped.pivot.position.set(ped.home.x, ped.home.y + dy, ped.home.z + dz);
          ped.pivot.rotation.x = ped.lever ? dy / ped.lever : 0;
        } else {
          ped.pivot.position.set(
            ped.corr.x,
            ped.corr.y + STRIDE_Y * Math.sin(theta + ped.phase),
            ped.corr.z + STRIDE_Z * Math.cos(theta + ped.phase),
          );
        }
      }
      for (const a of this.arms) {
        if (a.mode === 'link') {
          // the link bottom (lever below the hinge) tracks the same-side pin's
          // fore-aft travel: bottom dz ≈ −lever·angle → angle = −dz/lever
          const dz = -a.v0y * sinT + a.v0z * cosT - a.v0z;
          a.object.rotation.x = -dz / a.lever;
        } else {
          a.object.rotation.x = 0.22 * Math.cos(theta + a.phase);
        }
      }
      // Absolute angle (not incremental) keeps the crank pins in step with the
      // pedal groups riding them.
      for (const c of this.cranks) c.pivot.quaternion.setFromAxisAngle(c.axis, -theta);
    }

    // status tint + vibration jitter per bound part
    for (const part of this.parts) {
      const status = worstStatus(part.binding, state);
      const tint = STATUS_TINT[status];
      for (const mesh of part.meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const sm = m as THREE.MeshStandardMaterial;
          if (!sm.emissive) continue;
          if (tint) {
            const pulse = status === 'fail' ? 0.55 + 0.35 * Math.sin(this.time * 8) : 0.45;
            sm.emissive.copy(tint);
            sm.emissiveIntensity = pulse;
          } else if (!mesh.userData.__selected) {
            sm.emissive.setRGB(0, 0, 0);
            sm.emissiveIntensity = 1;
          }
        }
      }

      const vib = state.channels.vibration;
      if (part.binding.channels.includes('vibration') && vib) {
        const excess = Math.max(0, vib.meas - vib.cmd - vib.warnTol * 0.5);
        if (excess > 0) {
          part.object.position
            .copy(part.basePos)
            .add(new THREE.Vector3((Math.random() - 0.5) * excess * 0.02, (Math.random() - 0.5) * excess * 0.02, 0));
        } else {
          part.object.position.copy(part.basePos);
        }
      }
    }

    if (this.consoleTex) {
      // GL storage is immutable at the first upload's size — when the canvas
      // resizes (live stream arriving, source switch) dispose so it re-allocs,
      // else texSubImage2D fails silently and the screen freezes.
      const img = this.consoleTex.image as HTMLCanvasElement;
      if (img.width !== this.consoleTexSize.w || img.height !== this.consoleTexSize.h) {
        this.consoleTex.dispose();
        this.consoleTexSize = { w: img.width, h: img.height };
        this.consoleFrame = -1;
      }
      // re-upload only when the source actually painted — a floor of live
      // consoles at 1-2 fps must not re-upload every canvas every render tick
      const frame = canvasFrame(img);
      if (frame === undefined) {
        this.consoleTex.needsUpdate = true; // untracked canvas: legacy behavior
      } else if (frame !== this.consoleFrame) {
        this.consoleFrame = frame;
        this.consoleTex.needsUpdate = true;
      }
    }
  }

  private teardown(): void {
    // Return jittered parts to their rest pose first, or the reattach below
    // (and the next setRig's basePos capture) bakes live vibration offsets
    // into the part's permanent position.
    for (const p of this.parts) p.object.position.copy(p.basePos);
    // Screens that had the console texture mapped get their dark glass back.
    for (const p of this.parts) {
      for (const m of p.meshes) {
        if (m.userData.__screenMat) {
          m.material = m.userData.__screenMat;
          delete m.userData.__screenMat;
        }
      }
    }
    // Give platform parts back to the assembly before the pivots go, or a GUI
    // rebind would silently delete the deck/belt/rollers from the scene.
    if (this.platformFrontPivot && this.platformRearPivot && this.platformParent) {
      this.platformFrontPivot.rotation.set(0, 0, 0);
      this.platformRearPivot.rotation.set(0, 0, 0);
      this.platformFrontPivot.updateMatrixWorld(true);
      for (const part of this.platformParts) this.platformParent.attach(part);
    }
    if (this.deckPivot) this.deckPivot.rotation.set(0, 0, 0);
    // strap/spring scale/position aren't part of BoundPart basePos — restore explicitly
    if (this.strap && this.strapBase) {
      this.strap.scale.z = this.strapBase.scaleZ;
      this.strap.position.z = this.strapBase.posZ;
    }
    if (this.springs) {
      this.springs.mesh.scale.z = this.springs.base.scaleZ;
      this.springs.mesh.position.z = this.springs.base.posZ;
    }
    // CAD animation pivots: settle each pivot back to its home pose so the
    // attach below returns the parts to their original CAD placement.
    for (const r of this.reparents) {
      r.pivot.position.copy(r.home);
      r.pivot.rotation.set(0, 0, 0);
      r.pivot.scale.set(1, 1, 1); // spring stretch pivots scale z
      r.pivot.updateMatrixWorld(true);
      for (const part of r.parts) r.parent.attach(part);
      r.pivot.parent?.remove(r.pivot);
    }
    for (const arm of this.directArms) arm.rotation.x = 0;
    for (const o of this.overlays) o.parent?.remove(o);
    for (const d of this.disposables) d.dispose();
    this.overlays = [];
    this.disposables = [];
    this.parts = [];
    this.rollers = [];
    this.spinners = [];
    this.strokeSlides = [];
    this.pedals = [];
    this.arms = [];
    this.directArms = [];
    this.pedalPhaseBySide = {};
    this.pedalPinBySide = {};
    this.crankCenter = null;
    this.reparents = [];
    this.strap = null;
    this.strapFollow = null;
    this.strapBase = null;
    this.carriages = [];
    this.springs = null;
    this.springsFollow = null;
    this.springStretches = [];
    this.cranks = [];
    this.strokePhase = 0;
    this.stridePhase = 0;
    this.repPhase = 0;
    this.deckPivot = null;
    this.platformRearPivot = null;
    this.platformFrontPivot = null;
    this.platformParts = [];
    this.platformParent = null;
    this.ghostRearPivot = null;
    this.ghostFrontPivot = null;
    this.ghost = null;
    this.beltTexture = null;
    this.beltOverlayTex = null;
  }
}
