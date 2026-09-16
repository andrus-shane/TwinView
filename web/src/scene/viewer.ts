import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ChannelStatus, LabBay, LabLayout, MachineKind, RigConfig, TwinState, UnitInfo } from '@twinview/shared';
import { FALLBACKS_BY_KIND } from './fallback';
import { buildCadLod, type CadLod } from './lod';
import { applyCadMaterials, seedGroups, type PartKind } from './materials';
import { RigAnimator } from './rig';

const EMPTY_RIG: RigConfig = { model: '', bindings: [] };

/** Per-model yaw fix applied at load: CAD exports don't agree on which way is
 * "front", and the lab floor expects the console/drive end toward -Z. */
const MODEL_YAW: Record<string, number> = { 'FMRW0826-1D30': Math.PI, 'NTPL99926-6FW0': Math.PI };

const XRAY_MAT = new THREE.MeshBasicMaterial({
  color: 0x6ea8d8,
  transparent: true,
  opacity: 0.09,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Fallback footprint for a row with no bays (m); real sizes come from the layout */
const BAY_X = 2.0;
const BAY_Z = 3.4;

/** Floor markings: bay outlines (edit mode / empty bays) and the edit selection tint */
const SLOT_LINE = 0x64748b;
const SLOT_LINE_EMPTY = 0x7c8798;
const SLOT_SELECT = 0x4ea1ff;

const HALO_COLORS: Record<ChannelStatus | 'idle', number> = {
  idle: 0x64748b,
  ok: 0x16a34a,
  stale: 0x64748b,
  warn: 0xd97706,
  fail: 0xdc2626,
};

/** Where the detection badge floats (above the console) and where the status
 * halo centers, per machine silhouette. */
const BADGE_POS: Record<MachineKind, [number, number, number]> = {
  treadmill: [0, 1.95, -1.55],
  rower: [0, 1.55, -0.7],
  elliptical: [0, 1.9, -0.5],
  pilates: [0, 1.3, -1.1],
};
const HALO_Z: Record<MachineKind, number> = { treadmill: -0.45, rower: 0.2, elliptical: 0.15, pilates: 0.05 };

function partNameFor(obj: THREE.Object3D, root: THREE.Object3D): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur && cur !== root) {
    if (cur.name && !cur.name.startsWith('__')) return cur.name;
    cur = cur.parent;
  }
  return null;
}

function worstStatus(state: TwinState | null): ChannelStatus {
  if (!state) return 'stale';
  const rank = { ok: 0, stale: 1, warn: 2, fail: 3 };
  const readings = Object.values(state.channels);
  if (readings.length === 0) return 'stale';
  let worst: ChannelStatus = 'ok';
  for (const c of readings) {
    if (c && rank[c.status] > rank[worst]) worst = c.status;
  }
  return worst;
}

function issueCount(state: TwinState | null): number {
  if (!state) return 0;
  let n = 0;
  for (const c of Object.values(state.channels)) {
    if (c && (c.status === 'warn' || c.status === 'fail')) n++;
  }
  return n;
}

function bayLabelTexture(title: string, sub: string, dim = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.textAlign = 'center';
  g.font = '700 72px system-ui';
  g.fillStyle = dim ? 'rgba(148, 163, 184, 0.5)' : 'rgba(148, 163, 184, 0.85)';
  g.fillText(title.toUpperCase(), 256, 78);
  g.font = '500 44px system-ui';
  g.fillStyle = dim ? 'rgba(148, 163, 184, 0.4)' : 'rgba(148, 163, 184, 0.55)';
  g.fillText(sub, 256, 138);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Floor marking for one bay footprint: outline (+ tint while selected in the editor). */
function buildSlotMarks(bay: LabBay, empty: boolean): { outline: THREE.LineSegments; fill: THREE.Mesh } {
  const w = Math.max(0.3, bay.width - 0.08);
  const d = Math.max(0.3, bay.depth - 0.08);
  const plane = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
  const edges = new THREE.EdgesGeometry(plane);
  const mat = empty
    ? new THREE.LineDashedMaterial({ color: SLOT_LINE_EMPTY, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.7 })
    : new THREE.LineBasicMaterial({ color: SLOT_LINE, transparent: true, opacity: 0.45 });
  const outline = new THREE.LineSegments(edges, mat);
  outline.computeLineDistances();
  outline.position.y = 0.003;
  outline.name = '__slot_outline__';
  outline.raycast = () => undefined;
  const fill = new THREE.Mesh(
    plane,
    new THREE.MeshBasicMaterial({ color: SLOT_SELECT, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }),
  );
  fill.position.y = 0.002;
  fill.name = '__slot_fill__';
  fill.raycast = () => undefined;
  fill.visible = false;
  return { outline, fill };
}

/** One converted CAD model (GLB) and everything derived from it. The full
 * part-level group hops between focused bays; the merged LOD instances onto
 * every lab bay holding this model. */
interface CadEntry {
  model: string;
  url: string;
  group: THREE.Group | null;
  assemblyRoot: THREE.Object3D | null;
  animator: RigAnimator | null;
  partKinds: Map<string, PartKind>;
  names: string[];
  load: Promise<boolean> | null;
  lod: CadLod | null;
}

/** One floor slot from the lab layout — occupied (holds a Bay) or empty. */
interface Slot {
  bay: LabBay;
  root: THREE.Group;
  outline: THREE.LineSegments;
  fill: THREE.Mesh;
  /** Flat invisible pick target — only empty slots carry one (machines have their hull) */
  hull: THREE.Mesh | null;
  labelTex: THREE.CanvasTexture;
  machine: Bay | null;
  hovered: boolean;
}

interface Bay {
  unit: UnitInfo;
  root: THREE.Group;
  proxy: THREE.Group;
  /** Merged-CAD stand-in shown at lab level once the GLB is processed */
  lod: THREE.Group | null;
  /** Invisible pick target — unit selection never raycasts the dense meshes */
  hull: THREE.Mesh;
  animator: RigAnimator;
  halo: THREE.Mesh;
  haloMat: THREE.MeshBasicMaterial;
  badge: THREE.Sprite;
  badgeCanvas: HTMLCanvasElement;
  badgeTex: THREE.CanvasTexture;
  badgeKey: string;
  state: TwinState | null;
  hovered: boolean;
  pulsePhase: number;
}

interface CamAnim {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTgt: THREE.Vector3;
  toTgt: THREE.Vector3;
  start: number;
  dur: number;
}

/**
 * The lab floor scene: a bay grid of live machines (one per unit under test),
 * each animated by its own RigAnimator, with status halos and detection
 * badges. Every converted CAD model in the catalog loads side by side — a bay
 * shows its own model's merged LOD at lab level (proxy until then), and
 * focusing a unit flies the camera in and hot-swaps in that model's full
 * part-level CAD twin. Selecting a part within the focused unit drives the
 * component drill-down (fly-in + x-ray isolate). Picking resolves units at
 * lab level and parts at unit level.
 */
export class Viewer {
  onSelectUnit: (unitId: string) => void = () => {};
  /** A bay was clicked as a floor slot: an empty bay, or any bay while the floor editor is open. */
  onSelectBay: (bayId: string) => void = () => {};
  onSelectPart: (name: string | null) => void = () => {};
  /** Tap-through: a click landed on the live console screen at this normalized
   * position (origin top-left, matching device screen space). */
  onScreenTap: (u: number, v: number) => void = () => {};
  /** Swipe-through: a drag across the live console screen, start→end in the
   * same normalized space, plus the gesture's real duration in ms. */
  onScreenSwipe: (u1: number, v1: number, u2: number, v2: number, durMs: number) => void = () => {};
  onHover: (text: string | null) => void = () => {};
  /** Fired when the focused unit's model (CAD or proxy) is ready for the parts panel */
  onModelReady: (
    names: string[],
    groupSeeds: { name: string; parts: string[]; display: 'solid' }[],
    isCad: boolean,
  ) => void = () => {};

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private modelRoot = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();
  private container!: HTMLElement;
  private downAt: { x: number; y: number } | null = null;
  /** Active swipe-through gesture: a drag that began on the console screen.
   * Orbit stays frozen until it ends; last* hold the newest on-screen uv so a
   * drag that runs off the screen still ends at the edge it left through. */
  private screenDrag: { id: number; x: number; y: number; t: number; u: number; v: number; lastU: number; lastV: number } | null = null;
  private disposed = false;
  private bgCss = '#0b0e13';
  private grid: THREE.GridHelper | null = null;
  private ground!: THREE.Mesh;
  private groundMat!: THREE.ShadowMaterial;
  private dirLight!: THREE.DirectionalLight;
  private time = 0;

  private bays = new Map<string, Bay>();
  private bayList: Bay[] = [];
  private slots = new Map<string, Slot>();
  private slotList: Slot[] = [];
  private layout: LabLayout | null = null;
  private unitList: UnitInfo[] = [];
  /** Structural fingerprint of the built floor; a change rebuilds it */
  private floorKey = '';
  private editMode = false;
  private editSelected: string | null = null;
  private floorExtent = 8;
  private focusedId: string | null = null;
  private selectedName: string | null = null;

  /** Loaded CAD models by model id; every catalog model with a GLB gets one. */
  private cads = new Map<string, CadEntry>();
  /** Latest rig per model id (mirrors the store's model-scoped rig files). */
  private rigs = new Map<string, RigConfig>();
  /** Last-applied rig object per model — skips redundant re-rigging. */
  private appliedRigs = new Map<string, RigConfig>();
  private bayRigKeys = new Map<string, string>();
  private consoleCanvas: HTMLCanvasElement | null = null;
  private consoleWiredTo: RigAnimator | null = null;
  private screenTapOn = false;
  private isolated: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[]; raycast: THREE.Mesh['raycast'] }[] | null = null;
  private camAnim: CamAnim | null = null;

  mount(container: HTMLElement): void {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 200);
    this.camera.position.set(4, 6, 9);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.5, 0);

    const env = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.dirLight.position.set(6, 10, 4);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.dirLight);
    this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x223, 0.5));

    this.groundMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(10, 64).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.applyBackground();

    this.scene.add(this.modelRoot);
    (window as any).__viewer = this;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
      // swipe-through: a drag that starts on the live console screen belongs
      // to the device, not the camera — freeze orbit until the pointer lifts.
      // (OrbitControls' own pointerdown already ran — registered first — but
      // its pointermove checks `enabled` per event, so no rotation happens.)
      if (this.screenTapOn && !this.screenDrag) {
        const uv = this.screenUV(e);
        if (uv) {
          this.screenDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), ...uv, lastU: uv.u, lastV: uv.v };
          this.controls.enabled = false;
          el.setPointerCapture(e.pointerId); // keep move/up even off-canvas
        }
      }
    });
    el.addEventListener('pointerup', (e) => {
      const drag = this.screenDrag;
      if (drag && e.pointerId === drag.id) {
        this.endScreenDrag();
        this.downAt = null;
        const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
        // same threshold as unit/part picking: under it a drag is just a click
        if (moved < 5) this.onScreenTap(drag.u, drag.v);
        else this.onScreenSwipe(drag.u, drag.v, drag.lastU, drag.lastV, Math.round(performance.now() - drag.t));
        return;
      }
      if (!this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved < 5) this.pick(e, true);
    });
    el.addEventListener('pointermove', (e) => {
      const drag = this.screenDrag;
      if (drag) {
        if (e.pointerId !== drag.id) return;
        const uv = this.screenUV(e);
        if (uv) {
          drag.lastU = uv.u;
          drag.lastV = uv.v;
        }
        return; // no hover picking mid-gesture
      }
      this.pick(e, false);
    });
    el.addEventListener('pointercancel', (e) => {
      if (this.screenDrag?.id === e.pointerId) this.endScreenDrag();
      this.downAt = null;
    });
    el.addEventListener('pointerleave', () => {
      for (const b of this.bayList) b.hovered = false;
      for (const sl of this.slotList) sl.hovered = false;
      el.style.cursor = 'default';
      this.onHover(null);
    });

    this.loop();
  }

  /** Register the model catalog. Every model with a GLB loads eagerly — the
   * lab floor shows each bay's real machine via its model's merged LOD. */
  setModels(models: { model: string; glbUrl: string | null }[]): void {
    for (const m of models) {
      if (!m.glbUrl || this.cads.has(m.model)) continue;
      const entry: CadEntry = {
        model: m.model,
        url: m.glbUrl,
        group: null,
        assemblyRoot: null,
        animator: null,
        partKinds: new Map(),
        names: [],
        load: null,
        lod: null,
      };
      this.cads.set(m.model, entry);
      void this.ensureCad(entry).then((ok) => {
        if (ok) void this.buildLod(entry);
      });
    }
  }

  private rigFor(model: string): RigConfig {
    return this.rigs.get(model) ?? EMPTY_RIG;
  }

  /** Build one model's shared merged-CAD LOD and upgrade its bays from proxies. */
  private async buildLod(entry: CadEntry): Promise<void> {
    if (this.disposed || !entry.group || !entry.assemblyRoot) return;
    // The rig's animation pivots reparent parts OUT of the assembly root —
    // merging from that gutted tree would produce partial machines. Tear the
    // CAD rig down first (teardown reattaches everything), re-rig after.
    const cadShowing = entry.group.visible && entry.group.parent !== null;
    entry.animator?.setRig(EMPTY_RIG);
    try {
      const keep = new Set(this.rigFor(entry.model).bindings.map((b) => b.nodeName));
      entry.lod = await buildCadLod(entry.group, entry.assemblyRoot, entry.partKinds, keep);
      if (this.disposed) return;
    } catch (e) {
      console.error(`lab LOD build failed (${entry.model}), staying on proxies:`, e);
      entry.lod = null;
    }
    if (cadShowing && entry.animator) {
      const rig = this.rigFor(entry.model);
      entry.animator.setRig(rig);
      this.applyGroups(entry, rig.groups ?? []);
    }
    if (!entry.lod) {
      // failed (or nothing mergeable): make sure no bay is left invisible
      for (const bay of this.bayList) {
        if (bay.unit.model !== entry.model) continue;
        if (!bay.lod && !bay.proxy.visible) {
          bay.proxy.visible = true;
          bay.animator.setRig(this.bayRig(bay));
        }
      }
      return;
    }
    console.info(`lab LOD ${entry.model}: ${Math.round(entry.lod.triangles / 1000)}k tris per unit`);
    for (const bay of this.bayList) this.applyLodToBay(bay);
  }

  private applyLodToBay(bay: Bay): void {
    const entry = this.cads.get(bay.unit.model);
    if (!entry?.lod || bay.lod) return;
    bay.lod = entry.lod.instance();
    bay.root.add(bay.lod);
    bay.proxy.visible = false;
    this.sizeHull(bay.hull, entry.lod.machineBox);
    const showingCad = entry.group?.visible && entry.group.parent === bay.root;
    if (showingCad) {
      bay.lod.visible = false; // full model already swapped in for this bay
    } else if (this.focusedId === bay.unit.id) {
      this.wireConsole(); // re-rigs with the console attached
    } else {
      bay.animator.setRig(this.bayRig(bay));
    }
  }

  /** The rig a bay-level animator should run: the model's rig on CAD LOD,
   * else the machine kind's built-in proxy rig. */
  private bayRig(bay: Bay): RigConfig {
    if (bay.lod) return this.rigFor(bay.unit.model);
    if (bay.unit.kind === 'treadmill') {
      // proxy focused with no CAD anywhere: prefer the server rig if it targets proxy nodes
      const r = this.rigs.get(bay.unit.model);
      if (r && !this.cads.has(bay.unit.model) && r.bindings.length > 0) return r;
    }
    return FALLBACKS_BY_KIND[bay.unit.kind].rig;
  }

  private sizeHull(hull: THREE.Mesh, box: THREE.Box3): void {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    hull.scale.set(size.x + 0.15, size.y + 0.1, size.z + 0.15);
    hull.position.copy(center);
  }

  setConsoleCanvas(canvas: HTMLCanvasElement): void {
    this.consoleCanvas = canvas;
    // already wired to the focused unit (console source switch): swap in place
    if (this.consoleWiredTo?.hasConsole()) {
      this.consoleWiredTo.setConsoleCanvas(canvas);
    } else if (this.focusedId) {
      this.wireConsole();
    }
  }

  /** Lab wall: wire a bay's 3D console to its own (low-spec) tablet stream.
   * Idempotent — re-asserting the same canvas is a no-op. */
  setBayConsole(unitId: string, canvas: HTMLCanvasElement | null): void {
    const bay = this.bays.get(unitId);
    if (!bay) return;
    if (canvas && bay.animator.consoleIs(canvas)) return;
    bay.animator.setConsoleCanvas(canvas);
    // re-rig so the console screen picks up (or drops) the live texture
    const visible = bay.lod ? bay.lod.visible : bay.proxy.visible;
    if (visible) bay.animator.setRig(this.bayRig(bay));
  }

  /** Roster update. Rebuilds the floor only when its structure changed; otherwise refreshes unit info in place. */
  setFleet(units: UnitInfo[]): void {
    this.unitList = units;
    this.rebuildFloor();
  }

  /** The lab layout (rows of bays). Bays without a unit yet render as empty slots. */
  setLab(layout: LabLayout | null): void {
    this.layout = layout;
    this.rebuildFloor();
  }

  /** Floor editor: show every bay's footprint and tint the bay being edited. */
  setEditMode(on: boolean, selectedBayId: string | null): void {
    this.editMode = on;
    this.editSelected = on ? selectedBayId : null;
    for (const slot of this.slotList) {
      slot.outline.visible = on || !slot.machine;
      slot.fill.visible = on && slot.bay.id === this.editSelected;
    }
  }

  /** What the floor is built from: layout structure + which slots have a live unit (and of what). */
  private computeFloorKey(): string {
    if (!this.layout) return '';
    const byId = new Map(this.unitList.map((u) => [u.id, u]));
    const rows = this.layout.rows.map((r) =>
      r.bays
        .map((b) => {
          const u = byId.get(b.id);
          return `${b.id}:${b.width}x${b.depth}:${b.label}:${u ? `${u.kind}/${u.model}/${u.serial}` : b.machine ? 'pending' : '-'}`;
        })
        .join('|'),
    );
    return `${this.layout.align};${rows.join('#')}`;
  }

  private rebuildFloor(): void {
    const key = this.computeFloorKey();
    if (key === this.floorKey) {
      for (const u of this.unitList) {
        const bay = this.bays.get(u.id);
        if (bay) bay.unit = u;
      }
      return;
    }
    this.floorKey = key;
    const layout = this.layout;

    // Release the focused unit before tearing its bay down — the CAD twin,
    // console wiring, and hull raycast state must not ride a removed root.
    const prevFocus = this.focusedId;
    if (prevFocus) this.focusUnit(null, false);

    for (const bay of this.bayList) {
      bay.animator.setRig(EMPTY_RIG);
      bay.badgeTex.dispose();
      bay.hull.geometry.dispose();
      (bay.hull.material as THREE.Material).dispose();
    }
    for (const slot of this.slotList) {
      this.modelRoot.remove(slot.root);
      slot.outline.geometry.dispose();
      (slot.outline.material as THREE.Material).dispose();
      slot.fill.geometry.dispose();
      (slot.fill.material as THREE.Material).dispose();
      slot.labelTex.dispose();
      if (slot.hull) {
        slot.hull.geometry.dispose();
        (slot.hull.material as THREE.Material).dispose();
      }
    }
    this.bays.clear();
    this.bayList = [];
    this.slots.clear();
    this.slotList = [];
    if (!layout) return;

    // Rows stack front-to-back along z (first row farthest from the default
    // camera); each row is as deep as its deepest bay. Bays sit side by side
    // along x at their own widths; rows of unequal width center (or left-align).
    const byId = new Map(this.unitList.map((u) => [u.id, u]));
    const rowDepth = layout.rows.map((r) => (r.bays.length ? Math.max(...r.bays.map((b) => b.depth)) : BAY_Z));
    const rowWidth = layout.rows.map((r) => (r.bays.length ? r.bays.reduce((n, b) => n + b.width, 0) : BAY_X));
    const totalDepth = rowDepth.reduce((n, d) => n + d, 0);
    const maxWidth = Math.max(BAY_X, ...rowWidth);
    let z = -totalDepth / 2;
    let i = 0;
    layout.rows.forEach((row, r) => {
      const zc = z + rowDepth[r] / 2;
      let x = layout.align === 'left' ? -maxWidth / 2 : -rowWidth[r] / 2;
      for (const bay of row.bays) {
        const xc = x + bay.width / 2;
        x += bay.width;
        const unit = byId.get(bay.id) ?? null;
        this.buildSlot(bay, unit, xc, zc, i++);
      }
      z += rowDepth[r];
    });

    // size the floor, grid, and shadow frustum to the fleet
    this.floorExtent = Math.max(8, maxWidth / 2 + 3, totalDepth / 2 + 3);
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.CircleGeometry(this.floorExtent + 3, 64).rotateX(-Math.PI / 2);
    const sc = this.dirLight.shadow.camera;
    sc.left = -this.floorExtent - 2;
    sc.right = this.floorExtent + 2;
    sc.top = this.floorExtent + 2;
    sc.bottom = -this.floorExtent - 2;
    sc.updateProjectionMatrix();
    this.applyBackground();
    this.setEditMode(this.editMode, this.editSelected);

    // resume the drill-down if the focused unit survived the roster change
    if (prevFocus && this.bays.has(prevFocus)) this.focusUnit(prevFocus, false);
    else this.frameLab(false);
  }

  /** One floor slot at (x, z): footprint marks + label, and the machine when the bay has a live unit. */
  private buildSlot(bay: LabBay, unit: UnitInfo | null, x: number, z: number, index: number): void {
    const root = new THREE.Group();
    root.name = `__slot_${bay.id}__`;
    root.userData.bayId = bay.id;
    root.position.set(x, 0, z);
    const { outline, fill } = buildSlotMarks(bay, !unit);
    root.add(outline, fill);

    // painted bay label at the front edge of the slot
    const labelTex = unit
      ? bayLabelTexture(bay.label, unit.serial)
      : bayLabelTexture(bay.label, bay.machine ? 'loading…' : 'empty', true);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.36).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false }),
    );
    label.position.set(0, 0.004, bay.depth / 2 - 0.35);
    label.name = '__bay_label__';
    label.raycast = () => undefined;
    root.add(label);

    let hull: THREE.Mesh | null = null;
    if (!unit) {
      // empty slot: a flat invisible slab is the pick target
      const hullMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
      hullMat.colorWrite = false;
      hull = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.3, bay.width - 0.1), 0.06, Math.max(0.3, bay.depth - 0.1)), hullMat);
      hull.name = '__slot_hull__';
      hull.position.y = 0.03;
      root.add(hull);
    }

    const slot: Slot = { bay, root, outline, fill, hull, labelTex, machine: null, hovered: false };
    this.modelRoot.add(root);
    this.slots.set(bay.id, slot);
    this.slotList.push(slot);
    if (unit) slot.machine = this.buildMachine(unit, root, index);
  }

  /** The live machine for an occupied slot: proxy/LOD, pick hull, halo, badge, animator. */
  private buildMachine(unit: UnitInfo, slotRoot: THREE.Group, index: number): Bay {
    const root = new THREE.Group();
    root.name = `__bay_${unit.id}__`;
    root.userData.unitId = unit.id;

    const proxy = FALLBACKS_BY_KIND[unit.kind].build();
    proxy.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    // machine bounds while the proxy is still unparented (local space)
    const proxyBox = new THREE.Box3().setFromObject(proxy);
    root.add(proxy);

    // invisible box around the machine: unit picking raycasts this instead
    // of the dense meshes (a merged LOD has no per-part culling to lean on)
    const hullMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    hullMat.colorWrite = false;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hullMat);
    hull.name = '__hull__';
    this.sizeHull(hull, proxyBox);
    root.add(hull);

    // status halo: ellipse painted on the floor around the machine
    const haloMat = new THREE.MeshBasicMaterial({
      color: HALO_COLORS.idle,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.93, 1.05, 56).rotateX(-Math.PI / 2), haloMat);
    halo.scale.set(0.8, 1, 1.55);
    // center the ellipse under the machine: mass sits differently per kind
    halo.position.set(0, 0.006, HALO_Z[unit.kind]);
    halo.name = '__halo__';
    halo.raycast = () => undefined;
    root.add(halo);

    // floating detection badge above the console; hidden while healthy
    const badgeCanvas = document.createElement('canvas');
    badgeCanvas.width = 192;
    badgeCanvas.height = 96;
    const badgeTex = new THREE.CanvasTexture(badgeCanvas);
    badgeTex.colorSpace = THREE.SRGBColorSpace;
    const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTex, depthTest: false }));
    badge.scale.set(0.6, 0.3, 1);
    badge.position.set(...BADGE_POS[unit.kind]);
    badge.visible = false;
    badge.renderOrder = 998;
    badge.raycast = () => undefined;
    root.add(badge);

    const animator = new RigAnimator(root);
    animator.setRig(FALLBACKS_BY_KIND[unit.kind].rig);

    const bay: Bay = {
      unit,
      root,
      proxy,
      lod: null,
      hull,
      animator,
      halo,
      haloMat,
      badge,
      badgeCanvas,
      badgeTex,
      badgeKey: '',
      state: null,
      hovered: false,
      pulsePhase: (index * Math.PI) / 3,
    };
    slotRoot.add(root);
    this.bays.set(unit.id, bay);
    this.bayList.push(bay);
    this.applyLodToBay(bay);
    return bay;
  }

  applyStates(states: Record<string, TwinState>): void {
    for (const bay of this.bayList) {
      bay.state = states[bay.unit.id] ?? null;
    }
  }

  /** Apply the store's model-scoped rigs. Only models whose rig object
   * actually changed do any work. */
  applyRigs(rigs: Record<string, RigConfig>): void {
    for (const [model, rig] of Object.entries(rigs)) {
      if (this.appliedRigs.get(model) === rig) continue;
      this.appliedRigs.set(model, rig);
      this.rigs.set(model, rig);
      const entry = this.cads.get(model);

      const keepKey = rig.bindings.map((b) => b.nodeName).sort().join(',');
      const bindingsKey = JSON.stringify(rig.bindings);
      if (entry?.lod && entry.lod.keepKey !== keepKey) {
        // the LOD's kept-separate parts are stale — remerge with the new set
        const old = entry.lod;
        for (const bay of this.bayList) {
          if (bay.unit.model !== model || !bay.lod) continue;
          bay.animator.setRig(EMPTY_RIG);
          bay.root.remove(bay.lod);
          bay.lod = null;
          // proxies cover the gap; buildLod re-hides them when the LOD lands.
          // (Not in the focused bay — the full CAD twin is showing there.)
          if (!(entry.group?.visible && entry.group.parent === bay.root)) {
            bay.proxy.visible = true;
            bay.animator.setRig(this.bayRig(bay));
          }
        }
        entry.lod = null;
        old.dispose();
        this.bayRigKeys.set(model, bindingsKey);
        if (entry.group?.visible) this.setIsolate(null);
        void this.buildLod(entry); // re-rigs the visible CAD twin itself when done
        continue;
      }

      if (this.bayRigKeys.get(model) !== bindingsKey) {
        // bindings changed (channels/roles): re-rig this model's visible lab
        // machines — skipped on group/layer-only edits so a toggle stays cheap
        this.bayRigKeys.set(model, bindingsKey);
        for (const bay of this.bayList) {
          if (bay.unit.model !== model) continue;
          const visible = bay.lod ? bay.lod.visible : bay.proxy.visible;
          if (visible) bay.animator.setRig(this.bayRig(bay));
        }
      }

      if (entry?.animator && entry.group?.visible) {
        this.setIsolate(null);
        entry.animator.setRig(rig);
        this.applyGroups(entry, rig.groups ?? []);
      }
    }
  }

  /**
   * Drill level navigation. null = lab overview; an id = fly into that bay and
   * (when its model's CAD exists) swap the proxy for the full CAD twin.
   */
  focusUnit(id: string | null, animate = true): void {
    if (id === this.focusedId) return;
    this.setIsolate(null);
    this.setSelected(null);

    // release the previous unit: detach console, restore its lab-level model
    const prev = this.focusedId ? this.bays.get(this.focusedId) : null;
    if (prev) {
      if (this.consoleWiredTo) {
        this.consoleWiredTo.setScreenInteract(false);
        this.consoleWiredTo.setConsoleCanvas(null);
        this.consoleWiredTo = null;
      }
      const prevEntry = this.cads.get(prev.unit.model);
      if (prevEntry?.group && prevEntry.group.parent === prev.root) {
        prevEntry.group.visible = false;
        prev.root.remove(prevEntry.group);
        // teardown reattaches animated parts to the assembly root — the LOD
        // rebuild merges from that tree and must never see it gutted
        prevEntry.animator?.setRig(EMPTY_RIG);
      }
      if (prev.lod) prev.lod.visible = true;
      else prev.proxy.visible = true;
      prev.animator.setRig(this.bayRig(prev));
      prev.hull.raycast = THREE.Mesh.prototype.raycast; // lab picking again
    }

    this.focusedId = id;
    if (!id) {
      this.frameLab(animate);
      return;
    }

    const bay = this.bays.get(id);
    if (!bay) return;
    // part clicks must win inside the focused bay, so its hull steps aside
    bay.hull.raycast = () => undefined;

    this.frameBay(bay, animate);

    const entry = this.cads.get(bay.unit.model);
    if (entry) {
      void this.ensureCad(entry).then((ok) => {
        if (this.focusedId !== id) return;
        const b = this.bays.get(id);
        if (!b) return;
        if (!ok) {
          this.wireProxyFocus(b); // CAD unavailable — inspect the proxy instead
          return;
        }
        // swap the bay's LOD/proxy for the full part-level model
        const selected = this.selectedName;
        const isolated = this.isolated ? selected : null;
        this.setIsolate(null);
        b.animator.setRig(EMPTY_RIG); // teardown ghost/overlay/console attachments
        if (b.lod) b.lod.visible = false;
        b.proxy.visible = false;
        b.root.add(entry.group!);
        entry.group!.visible = true;
        const rig = this.rigFor(bay.unit.model);
        entry.animator!.setRig(rig);
        this.applyGroups(entry, rig.groups ?? []);
        this.wireConsole();
        // a part picked during the load window re-applies here — unless it was
        // a proxy-only node name that doesn't exist on the CAD model
        if (selected) {
          this.selectedName = null;
          if (entry.group!.getObjectByName(selected)) {
            this.setSelected(selected);
            if (isolated) this.setIsolate(isolated);
          } else {
            this.onSelectPart(null); // resets the store's component drill-down
          }
        }
        this.onModelReady(entry.names, seedGroups(entry.partKinds), true);
        this.frameBay(b, true); // CAD footprint differs slightly from the LOD
      });
    } else {
      this.wireProxyFocus(bay);
    }
  }

  /** Focus fallback when the bay's model has no CAD (or it failed to load). */
  private wireProxyFocus(bay: Bay): void {
    this.wireConsole();
    const names: string[] = [];
    bay.proxy.traverse((o) => {
      if (o.name && !o.name.startsWith('__')) names.push(o.name);
    });
    this.onModelReady(names.sort((a, b) => a.localeCompare(b)), [], false);
  }

  /** Load + prep a CAD model once; its group then hops between its bays on focus. */
  private ensureCad(entry: CadEntry): Promise<boolean> {
    if (entry.load) return entry.load;
    entry.load = (async () => {
      try {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(entry.url);
        const model = gltf.scene;
        const yaw = MODEL_YAW[entry.model] ?? 0;
        if (yaw) model.rotation.y = yaw;
        this.normalize(model);
        const assemblyRoot = model.children.length === 1 ? model.children[0] : model;
        entry.assemblyRoot = assemblyRoot;
        entry.partKinds = applyCadMaterials(assemblyRoot);
        model.traverse((o) => {
          o.castShadow = true;
          o.receiveShadow = true;
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
          // Meshopt re-encode drops accessor min/max — recompute or meshes get frustum-culled
          mesh.geometry.computeBoundingSphere();
          mesh.geometry.computeBoundingBox();
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            (m as THREE.Material).side = THREE.DoubleSide;
          }
        });
        const names = new Set<string>();
        model.traverse((o) => {
          if (o.name && !o.name.startsWith('__')) names.add(o.name);
        });
        entry.names = [...names].sort((a, b) => a.localeCompare(b));
        entry.group = new THREE.Group();
        entry.group.name = `__cad_${entry.model}__`;
        entry.group.visible = false; // shown only while parked in a focused bay
        entry.group.add(model);
        entry.animator = new RigAnimator(entry.group);
        return true;
      } catch (e) {
        console.error(`CAD load failed (${entry.model}), staying on proxy:`, e);
        return false;
      }
    })();
    return entry.load;
  }

  /** Scale/center CAD exports (often mm units, arbitrary origin) to a ~2m human scale at origin. */
  private normalize(model: THREE.Object3D): void {
    const bbox = new THREE.Box3().setFromObject(model);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 50) model.scale.multiplyScalar(0.001); // mm → m
    else if (maxDim > 5) model.scale.multiplyScalar(0.0254); // in → m (heuristic)
    const after = new THREE.Box3().setFromObject(model);
    const center = after.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= after.min.y; // ground the model on y=0
  }

  /** The focused bay's CAD entry, if its full model is currently swapped in. */
  private focusedCad(): { bay: Bay; entry: CadEntry } | null {
    if (!this.focusedId) return null;
    const bay = this.bays.get(this.focusedId);
    if (!bay) return null;
    const entry = this.cads.get(bay.unit.model);
    if (entry?.group?.visible && entry.group.parent === bay.root) return { bay, entry };
    return null;
  }

  /** The active drill-down model for the focused unit: full CAD when swapped in, else LOD/proxy. */
  private activeRoot(): THREE.Object3D | null {
    if (!this.focusedId) return null;
    const cad = this.focusedCad();
    if (cad) return cad.entry.group;
    const bay = this.bays.get(this.focusedId);
    if (!bay) return null;
    return bay.lod?.visible ? bay.lod : bay.proxy;
  }

  private activeAnimator(): RigAnimator | null {
    if (!this.focusedId) return null;
    const cad = this.focusedCad();
    if (cad) return cad.entry.animator;
    return this.bays.get(this.focusedId)?.animator ?? null;
  }

  private wireConsole(): void {
    const animator = this.activeAnimator();
    const bay = this.focusedId ? this.bays.get(this.focusedId) : null;
    if (!animator || !this.consoleCanvas || !bay) return;
    if (this.consoleWiredTo && this.consoleWiredTo !== animator) {
      this.consoleWiredTo.setScreenInteract(false);
      this.consoleWiredTo.setConsoleCanvas(null);
    }
    animator.setConsoleCanvas(this.consoleCanvas);
    // interact mode is animator-persistent; re-assert before setRig rebuilds
    // the overlay so the fresh plane picks the right raycast behavior
    animator.setScreenInteract(this.screenTapOn);
    const cad = this.focusedCad();
    animator.setRig(cad && animator === cad.entry.animator ? this.rigFor(bay.unit.model) : this.bayRig(bay));
    this.consoleWiredTo = animator;
  }

  /** Tap-through mode: clicks on the focused unit's console screen become
   * device taps (onScreenTap) instead of part selection. */
  setScreenInteract(on: boolean): void {
    this.screenTapOn = on;
    // disarmed mid-gesture (source/unit switch): don't leave orbit frozen
    if (!on && this.screenDrag) this.endScreenDrag();
    this.consoleWiredTo?.setScreenInteract(on);
  }

  /** Set the viewport background from a '#rrggbb' color; grid and shadow adapt to it. */
  setBackground(css: string): void {
    this.bgCss = css;
    if (this.container) this.applyBackground();
  }

  /** Grid line colors are baked into vertex colors at construction, so swap the helper out. */
  private applyBackground(): void {
    const n = parseInt(this.bgCss.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.45;
    // grid lines nudge toward the opposite pole so they read on any background
    const mix = (t: number) => {
      const to = light ? 0 : 255;
      const ch = (c: number) => Math.round(c + (to - c) * t);
      return (ch(r) << 16) | (ch(g) << 8) | ch(b);
    };
    this.scene.background = new THREE.Color(this.bgCss);
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const gridSize = Math.ceil((this.floorExtent + 3) * 2);
    this.grid = new THREE.GridHelper(gridSize, gridSize * 4, mix(light ? 0.24 : 0.17), mix(light ? 0.12 : 0.08));
    this.scene.add(this.grid);
    this.groundMat.opacity = light ? 0.22 : 0.35;
  }

  // --- Camera framing / flights ---

  private flyTo(pos: THREE.Vector3, tgt: THREE.Vector3, animate: boolean, dur = 0.85): void {
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.camAnim = null;
      return;
    }
    this.camAnim = {
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTgt: this.controls.target.clone(),
      toTgt: tgt,
      start: this.time,
      dur,
    };
  }

  private frameLab(animate: boolean): void {
    const bbox = new THREE.Box3().setFromObject(this.modelRoot);
    if (bbox.isEmpty()) return;
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    center.y = 0.4;
    const radius = 0.5 * Math.hypot(size.x, size.z);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 0.78;
    const dir = new THREE.Vector3(0.32, 0.72, 1).normalize();
    this.flyTo(center.clone().add(dir.multiplyScalar(dist)), center, animate, 1.0);
    this.camera.near = 0.05;
    this.camera.far = Math.max(200, dist * 8);
    this.camera.updateProjectionMatrix();
  }

  private frameBay(bay: Bay, animate: boolean): void {
    const cad = this.focusedCad();
    const target =
      cad && cad.bay === bay ? cad.entry.group! : bay.lod?.visible ? bay.lod : bay.proxy;
    const bbox = new THREE.Box3().setFromObject(target);
    if (bbox.isEmpty()) return;
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 0.72;
    // three-quarter view from front-right, slightly above (reads well for a machine)
    const dir = new THREE.Vector3(0.85, 0.5, 1).normalize();
    this.flyTo(center.clone().add(dir.multiplyScalar(dist)), center, animate);
    this.camera.near = Math.max(0.001, radius / 100);
    this.camera.far = Math.max(100, radius * 40);
    this.camera.updateProjectionMatrix();
  }

  /** Component level: dive the camera toward the part along the current view direction. */
  focusPart(name: string): void {
    const root = this.activeRoot();
    if (!root) return;
    const obj = root.getObjectByName(name);
    if (!obj) return;
    const bbox = new THREE.Box3().setFromObject(obj);
    if (bbox.isEmpty()) return;
    const center = bbox.getCenter(new THREE.Vector3());
    const radius = Math.max(0.12, 0.5 * bbox.getSize(new THREE.Vector3()).length());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = Math.max(0.3, (radius / Math.sin(fov / 2)) * 1.1);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.001) dir.set(0.85, 0.5, 1).normalize();
    this.flyTo(center.clone().add(dir.multiplyScalar(dist)), center, true, 0.7);
  }

  /** Fly back out to frame the whole focused unit (leaving component level). */
  reframeUnit(): void {
    const bay = this.focusedId ? this.bays.get(this.focusedId) : null;
    if (bay) this.frameBay(bay, true);
  }

  // --- Selection / isolate ---

  setSelected(name: string | null): void {
    const root = this.activeRoot();
    if (this.selectedName && root) {
      const prev = root.getObjectByName(this.selectedName);
      prev?.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        delete mesh.userData.__selected;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const sm = m as THREE.MeshStandardMaterial;
          if (sm.emissive && sm.userData.__selEmissive) {
            sm.emissive.setRGB(0, 0, 0);
            delete sm.userData.__selEmissive;
          }
        }
      });
    }
    this.selectedName = name;
    if (!name || !root) return;
    const obj = root.getObjectByName(name);
    obj?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.userData.__selected = true;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial;
        if (sm.emissive && sm.emissive.getHex() === 0) {
          sm.emissive.setHex(0x0e7490);
          sm.userData.__selEmissive = true;
        }
      }
    });
  }

  /**
   * Transient x-ray of everything except `name` — the component-level "look
   * through the shell" mode. Unlike layer groups this is never persisted.
   */
  setIsolate(name: string | null): void {
    if (this.isolated) {
      for (const it of this.isolated) {
        it.mesh.material = it.material;
        it.mesh.raycast = it.raycast;
      }
      this.isolated = null;
    }
    if (!name) return;
    const root = this.activeRoot();
    if (!root) return;
    const keep = root.getObjectByName(name);
    if (!keep) return;
    const keepSet = new Set<THREE.Object3D>();
    keep.traverse((o) => keepSet.add(o));

    this.isolated = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || keepSet.has(mesh) || !mesh.visible) return;
      if (mesh.name.startsWith('__')) return; // overlays (ghost, belt flow, screen)
      this.isolated!.push({ mesh, material: mesh.material, raycast: mesh.raycast });
      mesh.material = XRAY_MAT;
      mesh.raycast = () => undefined;
    });
  }

  // --- Picking ---

  private bayFor(obj: THREE.Object3D): Bay | null {
    let cur: THREE.Object3D | null = obj;
    while (cur && cur !== this.modelRoot) {
      if (cur.userData.unitId) return this.bays.get(cur.userData.unitId) ?? null;
      cur = cur.parent;
    }
    return null;
  }

  /** The floor slot an object belongs to (slot roots are direct children of modelRoot). */
  private slotFor(obj: THREE.Object3D): Slot | null {
    let cur: THREE.Object3D | null = obj;
    while (cur && cur !== this.modelRoot) {
      if (cur.userData.bayId) return this.slots.get(cur.userData.bayId) ?? null;
      cur = cur.parent;
    }
    return null;
  }

  private hoverText(bay: Bay): string {
    const st = bay.state;
    const status = worstStatus(st);
    const activity = st?.running
      ? `running ${st.scenario ?? 'manual'}`
      : (st?.setpoints.speed ?? 0) > 0
        ? 'manual run'
        : 'idle';
    const issues = issueCount(st);
    const tail = issues > 0 ? ` · ${issues} issue${issues > 1 ? 's' : ''} (${status})` : '';
    return `${bay.unit.label} · ${bay.unit.serial} — ${activity}${tail}`;
  }

  /** Raycaster tests invisible objects too — a hit only counts if its whole chain is shown. */
  private isShown(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  /** First shown intersection under the pointer. Orbiting close to a unit can
   * put a neighbor's invisible hull between the camera and the machine — if
   * the ray reaches the focused unit at all, it wins. */
  private hitAt(e: PointerEvent): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelRoot.children, true).filter((h) => this.isShown(h.object));
    const focusedHit = this.focusedId
      ? hits.find((h) => this.bayFor(h.object)?.unit.id === this.focusedId) ?? null
      : null;
    return focusedHit ?? hits[0] ?? null;
  }

  /** Pointer position on the focused unit's console screen in device space
   * (origin top-left), or null when the ray misses the screen. */
  private screenUV(e: PointerEvent): { u: number; v: number } | null {
    const hitI = this.hitAt(e);
    if (!hitI?.uv || !hitI.object.userData.consoleScreen) return null;
    const bay = this.bayFor(hitI.object);
    if (!bay || bay.unit.id !== this.focusedId) return null;
    // CanvasTexture flipY: texture v runs bottom-up, device y runs top-down
    return { u: hitI.uv.x, v: 1 - hitI.uv.y };
  }

  private endScreenDrag(): void {
    this.screenDrag = null;
    this.controls.enabled = true;
  }

  private pick(e: PointerEvent, isClick: boolean): void {
    const hitI = this.hitAt(e);
    const hit = hitI?.object ?? null;
    const bay = hit ? this.bayFor(hit) : null;
    const slot = hit ? this.slotFor(hit) : null;

    for (const b of this.bayList) b.hovered = false;
    for (const sl of this.slotList) sl.hovered = false;

    if (!bay) {
      if (slot && !this.focusedId) {
        // empty bay: a floor slot waiting for a machine
        if (isClick) {
          this.onSelectBay(slot.bay.id);
        } else {
          slot.hovered = true;
          this.renderer.domElement.style.cursor = 'pointer';
          this.onHover(`${slot.bay.label} — empty bay · ${slot.bay.width} × ${slot.bay.depth} m (click to place a machine)`);
        }
        return;
      }
      this.renderer.domElement.style.cursor = 'default';
      if (isClick && this.focusedId) this.onSelectPart(null);
      if (!isClick) this.onHover(null);
      return;
    }

    const isFocusedBay = this.focusedId === bay.unit.id;
    if (!isFocusedBay) {
      // lab level (or a neighboring unit while drilled in): whole-unit target —
      // or the slot itself while the floor editor is open
      if (isClick) {
        if (this.editMode && !this.focusedId) this.onSelectBay(bay.unit.id);
        else this.onSelectUnit(bay.unit.id);
      } else {
        bay.hovered = true;
        this.renderer.domElement.style.cursor = 'pointer';
        this.onHover(this.hoverText(bay));
      }
      return;
    }

    // tap-through: a click on the live console screen is a device tap, not a pick
    if (this.screenTapOn && hitI?.uv && hit?.userData.consoleScreen) {
      if (isClick) {
        // CanvasTexture flipY: texture v runs bottom-up, device y runs top-down
        this.onScreenTap(hitI.uv.x, 1 - hitI.uv.y);
      } else {
        this.renderer.domElement.style.cursor = 'crosshair';
        this.onHover(null);
      }
      return;
    }

    // focused unit: part-level picking
    const name = hit ? partNameFor(hit, bay.root) : null;
    if (isClick) {
      this.onSelectPart(name);
    } else {
      this.renderer.domElement.style.cursor = name ? 'pointer' : 'default';
      this.onHover(name);
    }
  }

  // --- Per-frame ---

  private updateBayIndicators(): void {
    for (const slot of this.slotList) {
      if (slot.machine) continue;
      const m = slot.outline.material as THREE.LineDashedMaterial;
      m.opacity = slot.hovered ? 1 : 0.7;
      m.color.setHex(slot.hovered ? SLOT_SELECT : SLOT_LINE_EMPTY);
    }
    for (const bay of this.bayList) {
      const st = bay.state;
      const status = worstStatus(st);
      const running = (st?.running ?? false) || (st?.setpoints.speed ?? 0) > 0;
      const colorKey = status === 'ok' ? (running ? 'ok' : 'idle') : status;
      bay.haloMat.color.setHex(HALO_COLORS[colorKey]);
      let opacity = colorKey === 'idle' || colorKey === 'stale' ? 0.22 : 0.5;
      if (status === 'warn') opacity = 0.55 + 0.2 * Math.sin(this.time * 4 + bay.pulsePhase);
      if (status === 'fail') opacity = 0.6 + 0.35 * Math.sin(this.time * 7 + bay.pulsePhase);
      if (bay.hovered) opacity = Math.min(1, opacity + 0.3);
      bay.haloMat.opacity = opacity;

      // detection badge above the console
      const issues = issueCount(st);
      const show = issues > 0 && status !== 'ok';
      bay.badge.visible = show;
      if (show) {
        const key = `${status}:${issues}`;
        if (key !== bay.badgeKey) {
          bay.badgeKey = key;
          const g = bay.badgeCanvas.getContext('2d')!;
          g.clearRect(0, 0, 192, 96);
          g.fillStyle = status === 'fail' ? '#dc2626' : '#d97706';
          g.beginPath();
          g.roundRect(8, 14, 176, 68, 32);
          g.fill();
          g.fillStyle = '#ffffff';
          g.font = '700 52px system-ui';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(`⚠ ${issues}`, 96, 52);
          bay.badgeTex.needsUpdate = true;
        }
        const s = status === 'fail' ? 0.62 + 0.05 * Math.sin(this.time * 7 + bay.pulsePhase) : 0.6;
        bay.badge.scale.set(s, s / 2, 1);
      }
    }
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;

    if (this.camAnim) {
      const a = this.camAnim;
      const t = Math.min(1, (this.time - a.start) / a.dur);
      const s = t * t * (3 - 2 * t); // smoothstep
      this.camera.position.lerpVectors(a.fromPos, a.toPos, s);
      this.controls.target.lerpVectors(a.fromTgt, a.toTgt, s);
      if (t >= 1) this.camAnim = null;
    }

    this.controls.update();

    for (const bay of this.bayList) {
      const modelVisible = bay.lod ? bay.lod.visible : bay.proxy.visible;
      if (modelVisible) bay.animator.update(dt, bay.state);
    }
    const cad = this.focusedCad();
    if (cad?.entry.animator) cad.entry.animator.update(dt, cad.bay.state);
    this.updateBayIndicators();

    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --- Layer groups (CAD only; proxies have too few parts to need layers) ---

  private applyGroups(entry: CadEntry, groups: { name: string; parts: string[]; display: string }[]): void {
    if (!entry.group) return;
    const mode = new Map<string, string>();
    for (const g of groups) for (const p of g.parts) mode.set(p, g.display);

    for (const name of entry.partKinds.keys()) {
      const part = entry.group.getObjectByName(name);
      if (!part) continue;
      const m = mode.get(name) ?? 'solid';
      part.visible = m !== 'hidden';
      part.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (m === 'xray') {
          if (!mesh.userData.__solidMat) {
            mesh.userData.__solidMat = mesh.material;
            mesh.userData.__solidRaycast = mesh.raycast;
          }
          mesh.material = XRAY_MAT;
          mesh.raycast = () => undefined;
        } else if (mesh.userData.__solidMat) {
          mesh.material = mesh.userData.__solidMat;
          mesh.raycast = mesh.userData.__solidRaycast;
          delete mesh.userData.__solidMat;
          delete mesh.userData.__solidRaycast;
        }
      });
    }
  }
}
