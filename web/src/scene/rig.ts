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
  private consoleTex: THREE.CanvasTexture | null = null;
  private consoleTexSize = { w: 0, h: 0 };
  private disposables: { dispose(): void }[] = [];
  private overlays: THREE.Object3D[] = [];
  private time = 0;

  constructor(private modelRoot: THREE.Object3D) {}

  setConsoleCanvas(canvas: HTMLCanvasElement): void {
    if (this.consoleTex) {
      // swap in place so materials created in setupConsoleScreen keep their map
      this.consoleTex.image = canvas;
      this.consoleTex.needsUpdate = true;
    } else {
      this.consoleTex = new THREE.CanvasTexture(canvas);
      this.consoleTex.colorSpace = THREE.SRGBColorSpace;
    }
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
    // Reparenting under the platform pivots rewrites local positions, so the
    // vibration rest poses must be captured after the pivots are built.
    for (const p of this.parts) p.basePos.copy(p.object.position);
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

    let frontPos: THREE.Vector3;
    let rearPos: THREE.Vector3;
    if (object.name === 'Deck_Assembly') {
      this.deckPivot = object;
      rearPos = object.getWorldPosition(new THREE.Vector3());
      frontPos = rearPos.clone();
    } else {
      ({ frontPos, rearPos } = this.setupPlatformPivots(object));
    }

    // Ghost wireframe at the COMMANDED angle — sized to the deck part so it
    // reads as "where the platform should be", not a machine-sized box.
    const bbox = new THREE.Box3().setFromObject(object);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
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
    const cx = (mb.min.x + mb.max.x) / 2;
    const outboard = 0.8 * ((mb.max.x - mb.min.x) / 2);
    const lowTopY = mb.min.y + 0.3 * (mb.max.y - mb.min.y);

    const box = new THREE.Box3();
    const platBox = new THREE.Box3();
    const platform: THREE.Object3D[] = [];
    for (const part of [...asm.children]) {
      if (!part.name || part.name.startsWith('__')) continue;
      box.setFromObject(part);
      if (box.isEmpty()) continue;
      const isTower = box.min.x - cx >= outboard || box.max.x - cx <= -outboard || box.max.y >= lowTopY;
      if (!isTower) {
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
    const frontPivot = new THREE.Object3D();
    frontPivot.name = '__platform_pivot_front__';
    frontPivot.position.set(cx, py, platBox.min.z);
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
      rearPos: rearPivot.getWorldPosition(new THREE.Vector3()),
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
      mat.opacity = !active ? 0 : gap > state.channels.incline.warnTol ? 0.75 + 0.25 * Math.sin(this.time * 6) : 0.3;
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

    if (this.consoleTex) {
      // GL storage is immutable at the first upload's size — when the canvas
      // resizes (live stream arriving, source switch) dispose so it re-allocs,
      // else texSubImage2D fails silently and the screen freezes.
      const img = this.consoleTex.image as HTMLCanvasElement;
      if (img.width !== this.consoleTexSize.w || img.height !== this.consoleTexSize.h) {
        this.consoleTex.dispose();
        this.consoleTexSize = { w: img.width, h: img.height };
      }
      this.consoleTex.needsUpdate = true;
    }
  }

  private teardown(): void {
    // Return jittered parts to their rest pose first, or the reattach below
    // (and the next setRig's basePos capture) bakes live vibration offsets
    // into the part's permanent position.
    for (const p of this.parts) p.object.position.copy(p.basePos);
    // Give platform parts back to the assembly before the pivots go, or a GUI
    // rebind would silently delete the deck/belt/rollers from the scene.
    if (this.platformFrontPivot && this.platformRearPivot && this.platformParent) {
      this.platformFrontPivot.rotation.set(0, 0, 0);
      this.platformRearPivot.rotation.set(0, 0, 0);
      this.platformFrontPivot.updateMatrixWorld(true);
      for (const part of this.platformParts) this.platformParent.attach(part);
    }
    if (this.deckPivot) this.deckPivot.rotation.set(0, 0, 0);
    for (const o of this.overlays) o.parent?.remove(o);
    for (const d of this.disposables) d.dispose();
    this.overlays = [];
    this.disposables = [];
    this.parts = [];
    this.rollers = [];
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
