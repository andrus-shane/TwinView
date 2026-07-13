import * as THREE from 'three';
import type { ChannelStatus, RigBinding, RigConfig, TwinState } from '@twinview/shared';

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
  g.beginPath();
  g.moveTo(10, 40);
  g.lineTo(32, 16);
  g.lineTo(54, 40);
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
 * Applies twin state to the 3D model each frame: deck tilts to measured
 * incline (ghost frame shows commanded), belt flow moves at measured speed,
 * bound parts tint by deviation status, vibration shakes the part.
 */
export class RigAnimator {
  private parts: BoundPart[] = [];
  private deckPivot: THREE.Object3D | null = null;
  private ghostPivot: THREE.Object3D | null = null;
  private ghost: THREE.LineSegments | null = null;
  private beltTexture: THREE.Texture | null = null;
  private beltOverlayTex: THREE.Texture | null = null;
  private rollers: THREE.Object3D[] = [];
  private consoleTex: THREE.CanvasTexture | null = null;
  private disposables: { dispose(): void }[] = [];
  private overlays: THREE.Object3D[] = [];
  private wholeMachineTilt = false;
  private time = 0;

  constructor(private modelRoot: THREE.Object3D) {}

  setConsoleCanvas(canvas: HTMLCanvasElement): void {
    this.consoleTex = new THREE.CanvasTexture(canvas);
    this.consoleTex.colorSpace = THREE.SRGBColorSpace;
  }

  setRig(rig: RigConfig): void {
    this.teardown();
    for (const binding of rig.bindings) {
      const object = this.modelRoot.getObjectByName(binding.nodeName);
      if (!object) continue;

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
      }
    }
    this.attachOverlaysToDeck();
  }

  /** The belt-flow and console-screen overlay planes hover over machine parts,
   * so when the whole machine tilts for incline they must ride the pivot too. */
  private attachOverlaysToDeck(): void {
    if (!this.deckPivot || !this.wholeMachineTilt) return;
    for (const nm of ['__belt_flow__', '__console_screen__']) {
      const o = this.modelRoot.getObjectByName(nm);
      if (o && o.parent !== this.deckPivot) this.deckPivot.attach(o);
    }
  }

  private setupDeck(object: THREE.Object3D): void {
    // Fallback model's Deck_Assembly is already pivoted at the rear. For CAD,
    // tilting just the bound deck part would skewer it through the static
    // frame — real treadmills incline by lifting the WHOLE machine about its
    // rear ground contact, so wrap the entire assembly in a rear-bottom pivot.
    if (object.name === 'Deck_Assembly') {
      this.deckPivot = object;
    } else {
      let machine: THREE.Object3D = object;
      while (machine.parent && machine.parent !== this.modelRoot) machine = machine.parent;
      const mb = new THREE.Box3().setFromObject(machine);
      const pivot = new THREE.Object3D();
      pivot.name = '__deck_pivot__';
      pivot.position.set((mb.min.x + mb.max.x) / 2, Math.max(mb.min.y, 0), mb.max.z);
      this.modelRoot.add(pivot);
      pivot.attach(machine);
      this.deckPivot = pivot;
      this.overlays.push(pivot); // teardown reattaches children, then removes
      this.wholeMachineTilt = true;
    }

    // Ghost wireframe at the COMMANDED angle — sized to the deck part so it
    // reads as "where the platform should be", not a machine-sized box.
    const bbox = new THREE.Box3().setFromObject(object);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    const mat = new THREE.LineBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.0 });
    this.ghost = new THREE.LineSegments(geo, mat);
    // Line raycasting uses a fat world-space threshold — an invisible ghost box
    // would swallow every click on the model. Never pickable.
    this.ghost.raycast = () => undefined;
    this.ghost.name = '__deck_ghost__';
    this.disposables.push(geo, mat);

    this.ghostPivot = new THREE.Object3D();
    this.ghostPivot.position.copy(this.deckPivot.getWorldPosition(new THREE.Vector3()));
    this.ghost.position.copy(center).sub(this.ghostPivot.position);
    this.ghostPivot.add(this.ghost);
    this.modelRoot.add(this.ghostPivot);
    this.overlays.push(this.ghostPivot);
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
    plane.position.set(center.x, bbox.max.y + 0.01, center.z);
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
    plane.position.set(center.x, center.y, bbox.max.z + 0.004);
    plane.name = '__console_screen__';
    plane.raycast = () => undefined;
    this.modelRoot.add(plane);
    this.overlays.push(plane);
    this.disposables.push(plane.geometry, mat);
  }

  update(dt: number, state: TwinState | null): void {
    if (!state) return;
    this.time += dt;

    const measSpeed = state.channels.belt_speed.meas;
    const measIncline = state.channels.incline.meas;
    const cmdIncline = state.channels.incline.cmd;

    // belt flow at measured speed (mph → texture units; direction: toward the rear)
    const scroll = measSpeed * dt * 0.9;
    if (this.beltTexture) this.beltTexture.offset.y -= scroll;
    if (this.beltOverlayTex) this.beltOverlayTex.offset.y += scroll;

    for (const r of this.rollers) r.rotation.x -= measSpeed * dt * 4;

    // deck tilt: measured on the model, commanded on the ghost. The fallback
    // tilts only its deck sub-assembly, so it exaggerates 2x to read; the CAD
    // path tilts the whole machine, where true scale already reads clearly.
    const gain = this.wholeMachineTilt ? 1 : 2;
    const measAngle = Math.atan(measIncline / 100) * gain;
    const cmdAngle = Math.atan(cmdIncline / 100) * gain;
    if (this.deckPivot) this.deckPivot.rotation.x = measAngle;
    if (this.ghostPivot && this.ghost) {
      this.ghostPivot.rotation.x = cmdAngle;
      const gap = Math.abs(measIncline - cmdIncline);
      const mat = this.ghost.material as THREE.LineBasicMaterial;
      const active = state.running || state.setpoints.speed > 0 || gap > 0.2;
      mat.opacity = !active ? 0 : gap > state.channels.incline.warnTol ? 0.55 + 0.3 * Math.sin(this.time * 6) : 0.18;
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

      if (part.binding.channels.includes('vibration')) {
        const vib = state.channels.vibration;
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

    if (this.consoleTex) this.consoleTex.needsUpdate = true;
  }

  private teardown(): void {
    // Give grouped platform parts back to the assembly before the pivot goes,
    // or a GUI rebind would silently delete the deck/belt/rollers from scene.
    if (this.deckPivot && this.deckPivot.name === '__deck_pivot__') {
      this.deckPivot.rotation.set(0, 0, 0);
      this.deckPivot.updateMatrixWorld(true);
      const parent = this.deckPivot.parent ?? this.modelRoot;
      for (const child of [...this.deckPivot.children]) {
        if (child.name.startsWith('__')) continue; // overlays are disposed below
        parent.attach(child);
      }
    }
    for (const o of this.overlays) o.parent?.remove(o);
    for (const d of this.disposables) d.dispose();
    this.overlays = [];
    this.disposables = [];
    this.parts = [];
    this.rollers = [];
    this.wholeMachineTilt = false;
    this.deckPivot = null;
    this.ghostPivot = null;
    this.ghost = null;
    this.beltTexture = null;
    this.beltOverlayTex = null;
  }
}
