/**
 * Optimize a raw CAD-exported GLB for the web viewer:
 *   - drop tiny hardware (fasteners etc.) below a bbox threshold
 *   - weld + simplify meshes, dedup, prune
 *   - meshopt-compress
 *   - emit models/parts-manifest.json (selectable node names)
 *
 * Usage: node tools/optimize_glb.mjs [input.glb] [output.glb]
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] ?? join(ROOT, 'models', 'NTL99925-raw.glb');
const output = process.argv[3] ?? join(ROOT, 'models', 'current.glb');
// Per-model manifest lives next to the GLB; 'current.glb' keeps the legacy
// parts-manifest.json name the app already loads.
const modelName = process.argv[4] ?? (output.endsWith('current.glb') ? 'NTL99925' : output.replace(/\\/g, '/').split('/').pop().replace(/\.glb$/i, ''));
const manifestPath = output.endsWith('current.glb')
  ? join(ROOT, 'models', 'parts-manifest.json')
  : output.replace(/\.glb$/i, '.manifest.json');

/** Drop only parts whose largest dimension is below this fraction of the OVERALL
 *  model extent — i.e. true micro-hardware, keeping real components for QA binding. */
const TINY_PART_RATIO = 0.0015;

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const t0 = Date.now();
console.log(`Reading ${input}...`);
const doc = await io.read(input);
const root = doc.getRoot();

function nodeBboxSize(node) {
  // approximate: union of primitive POSITION accessor min/max (local space)
  let size = 0;
  const mesh = node.getMesh();
  if (!mesh) return 0;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const min = pos.getMinNormalized([]);
    const max = pos.getMaxNormalized([]);
    const scale = node.getScale();
    for (let i = 0; i < 3; i++) size = Math.max(size, Math.abs(max[i] - min[i]) * Math.abs(scale[i] || 1));
  }
  return size;
}

// Overall model extent (positions are baked to world space, so a part's accessor
// min/max IS its world AABB). Union them for the whole-model extent.
const gmin = [Infinity, Infinity, Infinity];
const gmax = [-Infinity, -Infinity, -Infinity];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const mn = pos.getMinNormalized([]);
    const mx = pos.getMaxNormalized([]);
    for (let i = 0; i < 3; i++) {
      gmin[i] = Math.min(gmin[i], mn[i]);
      gmax[i] = Math.max(gmax[i], mx[i]);
    }
  }
}
const overallExtent = Math.max(gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2]);
const threshold = overallExtent * TINY_PART_RATIO;
console.log(`Overall model extent: ${overallExtent.toFixed(2)} m; dropping parts < ${(threshold * 1000).toFixed(1)} mm`);

// drop only true hardware (tiny parts)
let dropped = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const s = nodeBboxSize(node);
  if (s > 0 && s < threshold) {
    node.setMesh(null);
    dropped++;
  }
}
console.log(`Dropped ${dropped} tiny parts (< ${(threshold * 1000).toFixed(1)} mm) — fasteners etc.`);

let tris = 0;
for (const mesh of root.listMeshes())
  for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
console.log(`Triangles before simplify: ${Math.round(tris / 1000)}k`);

await MeshoptSimplifier.ready;
await doc.transform(
  dedup(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.002 }),
  prune(),
);

tris = 0;
for (const mesh of root.listMeshes())
  for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
console.log(`Triangles after simplify: ${Math.round(tris / 1000)}k`);

doc.createExtension(EXTMeshoptCompression).setRequired(true);

await io.write(output, doc);

// manifest of selectable parts
const names = [...new Set(root.listNodes().map((n) => n.getName()).filter((n) => n && !n.startsWith('__')))].sort();
writeFileSync(manifestPath, JSON.stringify({ model: modelName, parts: names }, null, 2));
console.log(`Wrote ${output} + manifest (${names.length} named parts) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
