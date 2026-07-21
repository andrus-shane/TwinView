import * as THREE from 'three';

/**
 * Heuristic PBR materials for the CAD model. The tessellation GLB ships one
 * flat gray material and NO UVs, so everything here is untextured PBR color
 * driven by part size/position/name — enough to read as a real machine
 * (rubber belt, graphite frame, plastic shrouds, steel hardware).
 */

function mat(opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial(opts);
  // CAD tessellation has inconsistent winding; keep parity with viewer default
  m.side = THREE.DoubleSide;
  return m;
}

// Shared instances — RigAnimator clones materials for bound parts before tinting.
const LIB = {
  beltRubber: () => mat({ color: 0x1e2124, roughness: 0.96, metalness: 0.0 }),
  deckBoard: () => mat({ color: 0x26282c, roughness: 0.85, metalness: 0.05 }),
  frame: () => mat({ color: 0x34383f, roughness: 0.48, metalness: 0.55 }),
  shroud: () => mat({ color: 0x53575e, roughness: 0.72, metalness: 0.08 }),
  darkPlastic: () => mat({ color: 0x2e3136, roughness: 0.8, metalness: 0.05 }),
  steel: () => mat({ color: 0xaeb4bc, roughness: 0.32, metalness: 0.92 }),
  screenGlass: () => mat({ color: 0x0b0d11, roughness: 0.18, metalness: 0.2 }),
  accent: () => mat({ color: 0x8a8f96, roughness: 0.55, metalness: 0.35 }),
};

/** Explicit part-number overrides for the verified NTL99925 roles/structure. */
const EXPLICIT: Record<string, keyof typeof LIB> = {
  '1000860-1': 'beltRubber', // walking belt
  '1006375-1': 'deckBoard', // deck board
  '456481-3': 'screenGlass', // console display panel
  '1000624-1': 'screenGlass', // display backing
  '387082-1': 'steel', // front roller
  '387083-1': 'steel', // rear roller
  '1000901-1': 'steel', // drive motor
};

const FASTENER_NAME = /screw|bolt|washer|nut|rivet|insert|smd|diode|soic|sot|capae|pcap|edt1|leads|xask|xass|step-1/i;

export type PartKind = keyof typeof LIB;

/** A fresh material instance for a classification — used by the lab-floor LOD merge. */
export function kindMaterial(kind: PartKind): THREE.MeshStandardMaterial {
  return LIB[kind]();
}

/** Applies materials and returns each part's classification (for layer seeding). */
export function applyCadMaterials(assemblyRoot: THREE.Object3D): Map<string, PartKind> {
  const kinds = new Map<string, PartKind>();
  const cache = new Map<PartKind, THREE.MeshStandardMaterial>();
  const get = (k: PartKind): THREE.MeshStandardMaterial => {
    let m = cache.get(k);
    if (!m) {
      m = LIB[k]();
      cache.set(k, m);
    }
    return m;
  };

  const bbox = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  for (const part of assemblyRoot.children) {
    if (!part.name || part.name.startsWith('__')) continue;

    let kind: PartKind | undefined = EXPLICIT[part.name];
    if (!kind) {
      bbox.setFromObject(part);
      if (bbox.isEmpty()) continue;
      bbox.getSize(size);
      bbox.getCenter(center);
      const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
      const maxDim = dims[2];
      const slender = maxDim / Math.max(dims[0], 1e-4);

      if (FASTENER_NAME.test(part.name) || maxDim < 0.05) {
        kind = 'steel'; // hardware, PCB components
      } else if (center.y > 0.95) {
        kind = 'darkPlastic'; // console cluster
      } else if (maxDim > 0.8 && slender > 8) {
        kind = 'frame'; // long structural members / uprights / rails
      } else if (maxDim > 0.35) {
        kind = 'shroud'; // covers, hood, large housings
      } else {
        kind = 'accent'; // mid-size brackets and trims
      }
    }

    kinds.set(part.name, kind);
    const material = get(kind);
    part.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = material;
    });
  }
  return kinds;
}

/** Default visibility layers, seeded from the material classification. */
export function seedGroups(kinds: Map<string, PartKind>): { name: string; parts: string[]; display: 'solid' }[] {
  const GROUP_OF: Record<PartKind, string> = {
    beltRubber: 'Drivetrain',
    deckBoard: 'Drivetrain',
    frame: 'Frame & structure',
    shroud: 'Plastic shells',
    darkPlastic: 'Console',
    screenGlass: 'Console',
    steel: 'Hardware & electronics',
    accent: 'Brackets & trim',
  };
  // Drivetrain explicit parts (rollers/motor classify as steel otherwise)
  const DRIVETRAIN = new Set(['1000860-1', '1006375-1', '387082-1', '387083-1', '1000901-1']);
  const byName = new Map<string, string[]>();
  for (const [part, kind] of kinds) {
    const group = DRIVETRAIN.has(part) ? 'Drivetrain' : GROUP_OF[kind];
    let arr = byName.get(group);
    if (!arr) byName.set(group, (arr = []));
    arr.push(part);
  }
  const ORDER = ['Plastic shells', 'Console', 'Frame & structure', 'Drivetrain', 'Brackets & trim', 'Hardware & electronics'];
  return ORDER.filter((n) => byName.has(n)).map((name) => ({
    name,
    parts: byName.get(name)!.sort(),
    display: 'solid' as const,
  }));
}
