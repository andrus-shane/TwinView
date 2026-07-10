import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { RigConfig, TwinState } from '@twinview/shared';
import { buildFallbackTreadmill } from './fallback';
import { RigAnimator } from './rig';

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
    this.scene.background = new THREE.Color(0x0b0e13);

    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(3, 5, 2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x223, 0.5));

    const grid = new THREE.GridHelper(12, 48, 0x2a3040, 0x1a1f2a);
    this.scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.35 }),
    );
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(this.modelRoot);

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
    } else {
      model = buildFallbackTreadmill();
    }
    model.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
    });
    this.modelRoot.add(model);
    this.fitCamera();

    this.animator = new RigAnimator(this.modelRoot);
    if (this.consoleCanvas) this.animator.setConsoleCanvas(this.consoleCanvas);
    if (this.rig) this.animator.setRig(this.rig);

    const names = new Set<string>();
    model.traverse((o) => {
      if (o.name && !o.name.startsWith('__')) names.add(o.name);
    });
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
    const radius = Math.max(size.x, size.y, size.z);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 1.1, radius * 0.7, radius * 1.2));
    this.camera.near = radius / 100;
    this.camera.far = radius * 20;
    this.camera.updateProjectionMatrix();
  }

  applyState(state: TwinState): void {
    this.state = state;
  }

  applyRig(rig: RigConfig): void {
    this.rig = rig;
    this.animator?.setRig(rig);
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
