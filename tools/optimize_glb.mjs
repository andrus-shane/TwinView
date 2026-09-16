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

/** Env knobs (defaults reproduce the original NTL99925/rower/elliptical/pilates outputs):
 *  SIMPLIFY_RATIO  fraction of triangles to keep (0.35). Coarse SolidWorks display
 *                  tessellations (p90 edge > ~10 mm on big shells) need 0.7+ or they melt.
 *  SIMPLIFY_ERROR  simplifier error bound as a fraction of mesh radius (0.002).
 *  CREASE_DEG      write a NORMAL attribute with creased smoothing: vertices are shared
 *                  (smooth) where adjacent faces meet under this angle and split (hard) above
 *                  it. Without it the GLB has no normals and the viewer's
 *                  computeVertexNormals() smooths across every edge, which on a coarse
 *                  tessellation reads as melted plastic. 0/unset = legacy (no normals).
 *  DROP_NODES      comma-separated part names to leave out of the GLB, for CAD artifacts
 *                  such as an unmated instance floating in space. `name` drops every
 *                  instance; `name#k` drops only the k-th (0-based, GLB node order — the
 *                  viewer names that instance `name` for k=0 and `name_k` otherwise). */
const SIMPLIFY_RATIO = Number(process.env.SIMPLIFY_RATIO) || 0.35;
const SIMPLIFY_ERROR = Number(process.env.SIMPLIFY_ERROR) || 0.002;
const CREASE_DEG = Number(process.env.CREASE_DEG) || 0;
const DROP_NODES = (process.env.DROP_NODES ?? '').split(',').map((x) => x.trim()).filter(Boolean);

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

/**
 * Creased vertex normals on welded, indexed geometry: per vertex, cluster the incident face
 * normals by angle; one shared vertex per cluster (smooth inside, hard edge between). Only
 * crease vertices are duplicated, so the index stays valid for meshopt and the lab LOD.
 * Accessors shared by duplicate parts (dedup) are processed once.
 * Complexity: Input n = triangles per primitive, k = faces per vertex (~6). Time O(n*k),
 * Space O(n). Tradeoff: greedy clustering (order-dependent at exactly the threshold) vs an
 * exact partition. Note: CPU.
 */
function creaseNormals(doc, creaseDeg) {
  const cosT = Math.cos((creaseDeg * Math.PI) / 180);
  const done = new Map(); // POSITION accessor -> NORMAL accessor (shared accessors: once)
  const buffer = doc.getRoot().listBuffers()[0];
  let splitTotal = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      const idxAcc = prim.getIndices();
      if (!posAcc || !idxAcc) continue;
      if (done.has(posAcc)) { prim.setAttribute('NORMAL', done.get(posAcc)); continue; }
      const pos = posAcc.getArray();
      const idx = idxAcc.getArray();
      const nTri = idx.length / 3;
      const nV = posAcc.getCount();
      // area-weighted face normals
      const fn = new Float32Array(nTri * 3);
      for (let t = 0; t < nTri; t++) {
        const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        fn[3 * t] = uy * vz - uz * vy; fn[3 * t + 1] = uz * vx - ux * vz; fn[3 * t + 2] = ux * vy - uy * vx;
      }
      // vertex -> incident corners (CSR)
      const count = new Uint32Array(nV + 1);
      for (let i = 0; i < idx.length; i++) count[idx[i] + 1]++;
      for (let v = 0; v < nV; v++) count[v + 1] += count[v];
      const corners = new Uint32Array(idx.length);
      const fill = count.slice(0, nV);
      for (let i = 0; i < idx.length; i++) corners[fill[idx[i]]++] = i;
      const outPos = [...pos];
      const outNrm = new Array(nV * 3).fill(0);
      const newIdx = new Uint32Array(idx.length);
      for (let v = 0; v < nV; v++) {
        const clusters = []; // { sx, sy, sz, corners[] }
        for (let k = count[v]; k < count[v + 1]; k++) {
          const corner = corners[k], t = (corner / 3) | 0;
          let nx = fn[3 * t], ny = fn[3 * t + 1], nz = fn[3 * t + 2];
          const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
          let hit = null;
          for (const c of clusters) {
            const cl = Math.hypot(c.sx, c.sy, c.sz) || 1;
            if ((nx * c.sx + ny * c.sy + nz * c.sz) / cl >= cosT) { hit = c; break; }
          }
          if (!hit) clusters.push((hit = { sx: 0, sy: 0, sz: 0, corners: [] }));
          hit.sx += fn[3 * t]; hit.sy += fn[3 * t + 1]; hit.sz += fn[3 * t + 2]; hit.corners.push(corner);
        }
        clusters.forEach((c, ci) => {
          let vid = v;
          if (ci > 0) { vid = outPos.length / 3; outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); outNrm.push(0, 0, 0); splitTotal++; }
          const l = Math.hypot(c.sx, c.sy, c.sz) || 1;
          outNrm[3 * vid] = c.sx / l; outNrm[3 * vid + 1] = c.sy / l; outNrm[3 * vid + 2] = c.sz / l;
          for (const corner of c.corners) newIdx[corner] = vid;
        });
      }
      posAcc.setArray(new Float32Array(outPos));
      idxAcc.setArray(newIdx);
      const nrmAcc = doc.createAccessor().setType('VEC3').setArray(new Float32Array(outNrm)).setBuffer(buffer);
      prim.setAttribute('NORMAL', nrmAcc);
      done.set(posAcc, nrmAcc);
    }
  }
  console.log(`Creased normals (${creaseDeg} deg): ${splitTotal} vertices split at hard edges`);
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

// explicit drops (CAD artifacts), by name or name#instance
if (DROP_NODES.length) {
  const seen = new Map();
  const hit = new Set();
  for (const node of root.listNodes()) {
    if (!node.getMesh()) continue;
    const name = node.getName();
    const k = seen.get(name) ?? 0;
    seen.set(name, k + 1);
    for (const spec of DROP_NODES) {
      if (spec === name || spec === `${name}#${k}`) {
        node.setMesh(null);
        hit.add(spec);
      }
    }
  }
  console.log(`Dropped by DROP_NODES: ${[...hit].join(', ') || 'none'}`);
  const miss = DROP_NODES.filter((d) => !hit.has(d));
  if (miss.length) console.warn(`WARNING: DROP_NODES not found in model: ${miss.join(', ')}`);
}

let tris = 0;
for (const mesh of root.listMeshes())
  for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
console.log(`Triangles before simplify: ${Math.round(tris / 1000)}k`);

await MeshoptSimplifier.ready;
console.log(`simplify ratio=${SIMPLIFY_RATIO} error=${SIMPLIFY_ERROR} creaseDeg=${CREASE_DEG || 'off'}`);
await doc.transform(
  dedup(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: SIMPLIFY_RATIO, error: SIMPLIFY_ERROR }),
  prune(),
);
if (CREASE_DEG > 0) creaseNormals(doc, CREASE_DEG);

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
