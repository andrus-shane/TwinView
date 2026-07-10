/**
 * Convert a STEP file to GLB preserving assembly hierarchy and part names,
 * using occt-import-js (OpenCascade WASM) + gltf-transform.
 *
 * Usage: node tools/step_to_glb.mjs [input.step] [output.glb]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import occtimportjs from 'occt-import-js';
import { Document, NodeIO } from '@gltf-transform/core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] ?? join(ROOT, 'models', 'NTL99925-raw.step');
const output = process.argv[3] ?? join(ROOT, 'models', 'NTL99925-raw.glb');

const t0 = Date.now();
console.log(`Loading OCCT wasm...`);
const occt = await occtimportjs();

console.log(`Reading ${input} (large assemblies take a while)...`);
const buf = readFileSync(input);
const result = occt.ReadStepFile(new Uint8Array(buf), {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.002, // coarse-ish tessellation, QA viz doesn't need CAD fidelity
  angularDeflection: 0.6,
});
if (!result.success) {
  console.error('STEP read failed');
  process.exit(1);
}
console.log(`STEP parsed in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${result.meshes.length} meshes`);

const doc = new Document();
const gltfBuffer = doc.createBuffer();
const scene = doc.createScene('NTL99925');
const root = doc.createNode('NTL99925').setScale([0.001, 0.001, 0.001]); // mm -> m
scene.addChild(root);

// build glTF meshes once, reference from nodes
const meshCache = [];
for (const [i, m] of result.meshes.entries()) {
  const prim = doc.createPrimitive();
  const pos = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(m.attributes.position.array))
    .setBuffer(gltfBuffer);
  prim.setAttribute('POSITION', pos);
  if (m.attributes.normal) {
    prim.setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.attributes.normal.array)).setBuffer(gltfBuffer),
    );
  }
  prim.setIndices(
    doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(m.index.array)).setBuffer(gltfBuffer),
  );
  const mat = doc.createMaterial(`mat_${i}`).setRoughnessFactor(0.6).setMetallicFactor(0.4);
  if (m.color) mat.setBaseColorFactor([m.color[0], m.color[1], m.color[2], 1]);
  else mat.setBaseColorFactor([0.62, 0.65, 0.7, 1]);
  prim.setMaterial(mat);
  meshCache.push(doc.createMesh(m.name || `mesh_${i}`).addPrimitive(prim));
}

let nodeCount = 0;
function addTree(occtNode, parent) {
  const node = doc.createNode(occtNode.name || `node_${nodeCount++}`);
  parent.addChild(node);
  for (const mi of occtNode.meshes ?? []) {
    // wrap each mesh so its part name survives as a distinct selectable node
    const child = doc.createNode(result.meshes[mi].name || `part_${mi}`);
    child.setMesh(meshCache[mi]);
    node.addChild(child);
  }
  for (const c of occtNode.children ?? []) addTree(c, node);
}
addTree(result.root, root);

await new NodeIO().write(output, doc);
console.log(`Wrote ${output} in ${((Date.now() - t0) / 1000).toFixed(0)}s total`);
