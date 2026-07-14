import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { RigConfig, TwinState } from '@twinview/shared';
import { buildFallbackTreadmill } from './fallback';
import { applyCadMaterials, seedGroups, type PartKind } from './materials';
import { RigAnimator } from './rig';

const XRAY_MAT = new THREE.MeshBasicMaterial({
  color: 0x6ea8d8,
  transparent: true,
  opacity: 0.09,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function partNameFor(obj: THREE.Object3D, root: THREE.Object3D): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur && cur !== root) {
    if (cur.name && !cur.name.startsWith('__')) return cur.name;
    cur = cur.parent;
  }
  return null;
}

export class Viewer {
  onSelect: (name: string | null) => void = () => {};
  onHover: (name: string | null) => void = () => {};

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private modelRoot = new THREE.Group();
  private animator: RigAnimator | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private selectedName: string | null = null;
  private state: TwinState | null = null;
  private rig: RigConfig | null = null;
  private consoleCanvas: HTMLCanvasElement | null = null;
  private clock = new THREE.Clock();
  private container!: HTMLElement;
  private downAt: { x: number; y: number } | null = null;
  private disposed = false;
  private partKinds = new Map<string, PartKind>();
  private assemblyRoot: THREE.Object3D | null = null;
  private bgCss = '#0b0e13';
  private grid: THREE.GridHelper | null = null;
  private groundMat!: THREE.ShadowMaterial;

  mount(container: HTMLElement): void {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
    this.camera.position.set(2.4, 1.7, 2.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.7, 0);

    const env = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;

    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(3, 5, 2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x223, 0.5));

    this.groundMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2), this.groundMat);
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.applyBackground();

    this.scene.add(this.modelRoot);
    (window as any).__viewer = this;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved < 5) this.pick(e, true);
    });
    el.addEventListener('pointermove', (e) => this.pick(e, false));

    this.loop();
  }

  setConsoleCanvas(canvas: HTMLCanvasElement): void {
    this.consoleCanvas = canvas;
    this.animator?.setConsoleCanvas(canvas);
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
    this.grid = new THREE.GridHelper(12, 48, mix(light ? 0.24 : 0.17), mix(light ? 0.12 : 0.08));
    this.scene.add(this.grid);
    this.groundMat.opacity = light ? 0.22 : 0.35;
  }

  /** Load a GLB by URL, or the procedural fallback when url is null. Returns selectable part names. */
  async loadModel(url: string | null): Promise<string[]> {
    this.modelRoot.clear();
    this.animator = null;

    let model: THREE.Object3D;
    if (url) {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(url);
      model = gltf.scene;
      this.normalize(model);
      // parts sit under the assembly root group (e.g. "NTL99925")
      this.assemblyRoot = model.children.length === 1 ? model.children[0] : model;
      this.partKinds = applyCadMaterials(this.assemblyRoot);
    } else {
      model = buildFallbackTreadmill();
    }
    model.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
      // Meshopt re-encode drops accessor min/max, so GLTFLoader can't set a valid
      // bounding sphere — without this the meshes get frustum-culled and vanish.
      mesh.geometry.computeBoundingSphere();
      mesh.geometry.computeBoundingBox();
      // CAD tessellation (GetTessTriangles) has inconsistent triangle winding, so
      // render double-sided to avoid back-face culling hiding half the surfaces.
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (m as THREE.Material).side = THREE.DoubleSide;
      }
    });
    this.modelRoot.add(model);
    this.fitCamera();

    // Collect names BEFORE wiring the rig — setRig reparents platform parts
    // out of this subtree, which would silently drop them from the list.
    const names = new Set<string>();
    model.traverse((o) => {
      if (o.name && !o.name.startsWith('__')) names.add(o.name);
    });

    this.animator = new RigAnimator(this.modelRoot);
    if (this.consoleCanvas) this.animator.setConsoleCanvas(this.consoleCanvas);
    if (this.rig) this.animator.setRig(this.rig);

    return [...names].sort((a, b) => a.localeCompare(b));
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

  private fitCamera(): void {
    const bbox = new THREE.Box3().setFromObject(this.modelRoot);
    if (bbox.isEmpty()) return;
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    // Frame to fit the whole bbox in view given the vertical FOV, with a small margin.
    const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 0.72;
    this.controls.target.copy(center);
    // three-quarter view from front-right, slightly above (reads well for a treadmill)
    const dir = new THREE.Vector3(0.85, 0.5, 1).normalize();
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.near = Math.max(0.001, radius / 100);
    this.camera.far = radius * 40;
    this.camera.updateProjectionMatrix();
  }

  applyState(state: TwinState): void {
    this.state = state;
  }

  applyRig(rig: RigConfig): void {
    this.rig = rig;
    this.animator?.setRig(rig);
    this.applyGroups(rig.groups ?? []);
  }

  /** Default layer groups derived from the material classification. */
  getGroupSeeds(): { name: string; parts: string[]; display: 'solid' }[] {
    return seedGroups(this.partKinds);
  }

  /**
   * Apply layer display modes. X-ray parts render as a faint shell and stop
   * intercepting clicks, so inner components can be seen AND selected through
   * them; hidden parts disappear entirely (raycaster skips invisible objects).
   */
  private applyGroups(groups: { name: string; parts: string[]; display: string }[]): void {
    if (!this.assemblyRoot) return;
    const mode = new Map<string, string>();
    for (const g of groups) for (const p of g.parts) mode.set(p, g.display);

    // The deck pivot may have reparented parts, so resolve by name model-wide.
    for (const name of this.partKinds.keys()) {
      const part = this.modelRoot.getObjectByName(name);
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

  setSelected(name: string | null): void {
    if (this.selectedName) {
      const prev = this.modelRoot.getObjectByName(this.selectedName);
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
    if (!name) return;
    const obj = this.modelRoot.getObjectByName(name);
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

  focusOn(name: string): void {
    const obj = this.modelRoot.getObjectByName(name);
    if (!obj) return;
    const bbox = new THREE.Box3().setFromObject(obj);
    const center = bbox.getCenter(new THREE.Vector3());
    this.controls.target.lerp(center, 1);
  }

  private pick(e: PointerEvent, isClick: boolean): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelRoot.children, true);
    const name = hits.length ? partNameFor(hits[0].object, this.modelRoot) : null;
    if (isClick) {
      this.setSelected(name);
      this.onSelect(name);
    } else {
      this.renderer.domElement.style.cursor = name ? 'pointer' : 'default';
      this.onHover(name);
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
    this.controls.update();
    this.animator?.update(dt, this.state);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
