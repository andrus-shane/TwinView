// Scratch analysis: dump per-part world AABBs from a baked GLB (positions are
// world-space, so accessor min/max is the part AABB). Not part of the pipeline.
// Usage: node tools/_analyze_glb.mjs models/FMRW0826-1D30.glb
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const doc = await io.read(process.argv[2]);
const parts = [];
const gmin = [Infinity, Infinity, Infinity];
const gmax = [-Infinity, -Infinity, -Infinity];

for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || !node.getName() || node.getName().startsWith('__')) continue;
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const pmn = pos.getMinNormalized([]);
    const pmx = pos.getMaxNormalized([]);
    for (let i = 0; i < 3; i++) {
      mn[i] = Math.min(mn[i], pmn[i]);
      mx[i] = Math.max(mx[i], pmx[i]);
      gmin[i] = Math.min(gmin[i], pmn[i]);
      gmax[i] = Math.max(gmax[i], pmx[i]);
    }
    tris += (prim.getIndices()?.getCount() ?? 0) / 3;
  }
  if (mn[0] === Infinity) continue;
  const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  parts.push({ name: node.getName(), size, center, vol: size[0] * size[1] * size[2], tris });
}

const f = (a) => a.map((v) => v.toFixed(3)).join(',');
console.log(`MODEL BBOX min=[${f(gmin)}] max=[${f(gmax)}] size=[${f([gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2]])}]`);
console.log(`parts: ${parts.length}`);
console.log('\n--- 45 largest by bbox volume ---');
for (const p of parts.sort((a, b) => b.vol - a.vol).slice(0, 45)) {
  console.log(`${p.name.padEnd(44)} size=[${f(p.size)}] c=[${f(p.center)}] tris=${p.tris}`);
}
console.log('\n--- named of interest ---');
const re = /wheel|seat|belt|rail|handle|grip|tube|console|screen|display|servo|brake|magnet|pedal|foot|strap|pulley|crank/i;
for (const p of parts.filter((x) => re.test(x.name)).sort((a, b) => b.vol - a.vol)) {
  console.log(`${p.name.padEnd(44)} size=[${f(p.size)}] c=[${f(p.center)}] tris=${p.tris}`);
}
