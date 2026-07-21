import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { kindMaterial, type PartKind } from './materials';
import { towerTest } from './rig';

/** Parts smaller than this (m) are dropped from the lab LOD — fasteners, PCB bits.
 * Invisible at lab-floor distance and they carry most of the part count. */
const MIN_PART_DIM = 0.055;
/** Decimation target for merged buckets: CAD tessellation is ~2.5M tris per
 * machine; ×12 bays that saturates mid-range GPUs. 25% keeps silhouettes. */
const SIMPLIFY_RATIO = 0.25;
/** Allowed simplification deviation, relative to bucket extents (~1.5 cm on a 1 m part). */
const SIMPLIFY_ERROR = 0.015;

export interface CadLod {
  /** One LOD copy for a bay: fresh scene nodes, shared GPU geometry. */
  instance(): THREE.Group;
  /** Machine bounds in instance-local space (for pick hulls / framing). */
  machineBox: THREE.Box3;
  triangles: number;
  /** Bound-part names kept separate — rebuild the LOD if these change. */
  keepKey: string;
  /** Free the shared merged geometry (after every instance is removed). */
  dispose(): void;
}

/**
 * Any attribute → tight non-normalized Float32 BufferAttribute.
 * mergeGeometries can't take interleaved attributes, applyMatrix4 clamps
 * normalized-int (quantized GLB) data, and the simplifier wants raw floats.
 */
function plainAttribute(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const interleaved = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute;
  if (!interleaved && !a.normalized && a.array instanceof Float32Array) {
    return (a as THREE.BufferAttribute).clone();
  }
  const out = new THREE.BufferAttribute(new Float32Array(a.count * a.itemSize), a.itemSize);
  for (let i = 0; i < a.count; i++) {
    // getComponent denormalizes quantized values
    for (let c = 0; c < a.itemSize; c++) out.setComponent(i, c, a.getComponent(i, c));
  }
  return out;
}

/**
 * Merge the CAD assembly into a handful of big meshes so the whole fleet can
 * show the real machine: ~16k draw calls for 12 full-part models would sink
 * the frame rate, but ~20 per bay is cheaper than the old procedural proxy.
 *
 * Bound parts (belt, deck, rollers, motor, console screen) are kept as
 * separate cloned nodes so RigAnimator can still tilt, tint, jitter, and
 * texture them per unit. Everything else merges per (platform|towers) ×
 * material-kind — the same split the platform pivots use, so the deck-tilt
 * reparenting carves the merged blobs exactly like the full model.
 *
 * Merged geometry is built once and shared: N bays cost N sets of draw calls
 * but a single set of GPU buffers.
 */
export async function buildCadLod(
  cadGroup: THREE.Object3D,
  assemblyRoot: THREE.Object3D,
  partKinds: Map<string, PartKind>,
  keepNames: Set<string>,
): Promise<CadLod | null> {
  await MeshoptSimplifier.ready;
  cadGroup.updateWorldMatrix(true, true);
  // Everything is baked relative to cadGroup, so instances drop into a bay
  // root exactly where cadGroup itself would sit (cadGroup may currently be
  // parked inside some bay — don't bake that offset in).
  const invRoot = cadGroup.matrixWorld.clone().invert();
  // one flattened holder replicates the chain cadGroup → gltf scene → assembly
  const holderMatrix = invRoot.clone().multiply(assemblyRoot.matrixWorld);
  const invHolderWorld = assemblyRoot.matrixWorld.clone().invert();

  const machineWorld = new THREE.Box3().setFromObject(assemblyRoot);
  if (machineWorld.isEmpty()) return null;
  const isTower = towerTest(machineWorld);

  const buckets = new Map<string, THREE.BufferGeometry[]>();
  const keeps: THREE.Object3D[] = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();

  for (const part of assemblyRoot.children) {
    if (!part.name || part.name.startsWith('__')) continue;
    if (keepNames.has(part.name)) {
      keeps.push(part);
      continue;
    }
    const kind = partKinds.get(part.name) ?? 'accent';
    // interior hardware/electronics never reads at lab distance (screws, PCBs,
    // wiring — all inside the covers) but carries most of the triangle budget
    if (kind === 'steel') continue;
    box.setFromObject(part);
    if (box.isEmpty()) continue;
    box.getSize(size);
    if (Math.max(size.x, size.y, size.z) < MIN_PART_DIM) continue;
    const key = `${isTower(box) ? 'Towers' : 'Platform'}|${kind}`;
    part.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', plainAttribute(pos));
      const norm = mesh.geometry.getAttribute('normal');
      if (norm) g.setAttribute('normal', plainAttribute(norm));
      if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
      else g.setIndex([...Array(pos.count).keys()]);
      if (!norm) g.computeVertexNormals();
      mesh.updateWorldMatrix(true, false);
      g.applyMatrix4(new THREE.Matrix4().copy(invHolderWorld).multiply(mesh.matrixWorld));
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(g);
    });
  }
  if (buckets.size === 0) return null;

  const merged: { mesh: string; geo: THREE.BufferGeometry; kind: PartKind }[] = [];
  let triangles = 0;
  for (const [key, geos] of buckets) {
    const geo = mergeGeometries(geos, false);
    if (!geo) continue;

    // Decimate: index-only simplification, so positions/normals stay exact.
    const index = geo.index!;
    const srcIdx = index.array instanceof Uint32Array ? index.array : new Uint32Array(index.array);
    const target = Math.max(3000, Math.floor((srcIdx.length * SIMPLIFY_RATIO) / 3) * 3);
    if (srcIdx.length > target) {
      const positions = geo.getAttribute('position').array as Float32Array;
      const [simplified] = MeshoptSimplifier.simplify(srcIdx, positions, 3, target, SIMPLIFY_ERROR, []);
      geo.setIndex(new THREE.BufferAttribute(simplified, 1));
    }

    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    triangles += (geo.index?.count ?? 0) / 3;
    const [side, kind] = key.split('|') as [string, PartKind];
    merged.push({ mesh: `LOD_${side}_${kind}`, geo, kind });
  }

  // Snapshot the kept parts NOW, while they sit in the intact assembly — by
  // instance() time the focused unit's rig may have reparented the originals
  // under platform pivots, which rewrites their local transforms.
  const keepTemplates = keeps.map((part) => part.clone(true));

  const materials = new Map<PartKind, THREE.MeshStandardMaterial>();
  const matFor = (k: PartKind) => {
    let m = materials.get(k);
    if (!m) materials.set(k, (m = kindMaterial(k)));
    return m;
  };

  const machineBox = machineWorld.clone().applyMatrix4(invRoot);

  const instance = (): THREE.Group => {
    const group = new THREE.Group();
    group.name = 'CAD_LOD';
    const holder = new THREE.Group();
    holder.name = 'LOD_Assembly';
    holder.applyMatrix4(holderMatrix);
    group.add(holder);
    for (const { mesh: name, geo, kind } of merged) {
      const mesh = new THREE.Mesh(geo, matFor(kind));
      mesh.name = name;
      // No shadow casting from the merged bulk — it would re-render every
      // triangle into the shadow map ×12 bays. The kept deck/belt clones still
      // cast, which is what actually grounds the machines visually.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // lab-level picking goes through the bay hulls — a raycast into a merged
      // blob would test every triangle of the machine (no per-part culling)
      mesh.raycast = () => undefined;
      holder.add(mesh);
    }
    for (const part of keepTemplates) {
      // clone shares geometry; RigAnimator clones materials before tinting
      const clone = part.clone(true);
      clone.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
        // hulls do the picking — a raycastable 300k-tri console clone ×12 bays
        // would stall every pointermove (three.js has no BVH)
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.raycast = () => undefined;
      });
      holder.add(clone);
    }
    return group;
  };

  const dispose = (): void => {
    for (const m of merged) m.geo.dispose();
    for (const m of materials.values()) m.dispose();
  };

  return { instance, machineBox, triangles, keepKey: [...keepNames].sort().join(','), dispose };
}
