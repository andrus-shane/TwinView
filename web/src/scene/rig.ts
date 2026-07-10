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
          this.rollers.push(object);
          break;
        case 'console_screen':
          this.setupConsoleScreen(meshes);
          break;
      }
    }
  }

  private setupDeck(object: THREE.Object3D): void {
    // Fallback model's Deck_Assembly is already pivoted at the rear; for
    // arbitrary CAD nodes, wrap in a pivot at the rear-bottom of the bbox.
    if (object.name === 'Deck_Assembly') {
      this.deckPivot = object;
    } else {
      const bbox = new THREE.Box3().setFromObject(object);
      const pivot = new THREE.Object3D();
      pivot.name = '__deck_pivot__';
      const parent = object.parent ?? this.modelRoot;
      pivot.position.set((bbox.min.x + bbox.max.x) / 2, bbox.min.y, bbox.max.z);
      parent.add(pivot);
      pivot.attach(object);
      this.deckPivot = pivot;
      this.overlays.push(pivot); // tracked for teardown
    }

    // Ghost wireframe of the deck at the COMMANDED angle
    const bbox = new THREE.Box3().setFromObject(this.deckPivot);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    const mat = new THREE.LineBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.0 });
    this.ghost = new THREE.LineSegments(geo, mat);
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

  private setupConsoleScreen(meshes: THREE.Mesh[]): void {
    if (!this.consoleTex) return;
    for (const m of meshes) {
      const mat = new THREE.MeshBasicMaterial({ map: this.consoleTex, toneMapped: false });
      this.disposables.push(mat);
      m.material = mat;
    }
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

    // deck tilt: measured on the model, commanded on the ghost
    const measAngle = Math.atan(measIncline / 100) * 2; // exaggerate 2x so it reads visually
    const cmdAngle = Math.atan(cmdIncline / 100) * 2;
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
    for (const o of this.overlays) o.parent?.remove(o);
    for (const d of this.disposables) d.dispose();
    this.overlays = [];
    this.disposables = [];
    this.parts = [];
    this.rollers = [];
    this.deckPivot = null;
    this.ghostPivot = null;
    this.ghost = null;
    this.beltTexture = null;
    this.beltOverlayTex = null;
  }
}
