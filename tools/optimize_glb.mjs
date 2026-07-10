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
const manifestPath = join(ROOT, 'models', 'parts-manifest.json');

/** Parts smaller than this fraction of the model's max dimension get dropped */
const TINY_PART_RATIO = 0.012;

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

// model max dimension (rough, from all positions)
let modelMax = 0;
for (const node of root.listNodes()) modelMax = Math.max(modelMax, nodeBboxSize(node));
console.log(`Model max part dimension: ${modelMax.toFixed(1)}`);

// drop tiny parts
let dropped = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const s = nodeBboxSize(node);
  if (s > 0 && s < modelMax * TINY_PART_RATIO) {
    node.setMesh(null);
    dropped++;
  }
}
console.log(`Dropped ${dropped} tiny parts (< ${(TINY_PART_RATIO * 100).toFixed(1)}% of max dim) — fasteners etc.`);

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
writeFileSync(manifestPath, JSON.stringify({ model: 'NTL99925', parts: names }, null, 2));
console.log(`Wrote ${output} + manifest (${names.length} named parts) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
