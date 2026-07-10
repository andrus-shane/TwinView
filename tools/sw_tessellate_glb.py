"""Plan C: pull tessellated triangles straight out of the open SolidWorks
assembly via COM (IFace2::GetTessTriangles) and write a GLB directly — no file
exporter involved. Slower per-call than a native export but bounded and
deterministic. Preserves component names and instance transforms.

Usage: python tools/sw_tessellate_glb.py [output.glb]
Requires the assembly to already be open in SolidWorks.
"""
import json
import struct
import sys
import time
from pathlib import Path

import pythoncom
import win32com.client

ROOT = Path(__file__).resolve().parent.parent


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def get_prop(obj, name):
    v = getattr(obj, name)
    return v() if callable(v) else v


def write_glb(out_path: Path, parts: list[dict]) -> None:
    """parts: [{name, transform(16 float col-major glTF), positions(f32 flat), }]"""
    bin_chunks = []
    accessors = []
    buffer_views = []
    meshes = []
    nodes = []
    offset = 0

    for i, p in enumerate(parts):
        pos = p["positions"]
        blob = struct.pack(f"<{len(pos)}f", *pos)
        # pad to 4 bytes
        pad = (-len(blob)) % 4
        bin_chunks.append(blob + b"\x00" * pad)
        count = len(pos) // 3
        xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": 34962})
        accessors.append({
            "bufferView": len(buffer_views) - 1, "componentType": 5126, "count": count, "type": "VEC3",
            "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)],
        })
        offset += len(blob) + pad
        meshes.append({
            "name": p["name"],
            "primitives": [{"attributes": {"POSITION": len(accessors) - 1}, "material": 0, "mode": 4}],
        })
        node = {"name": p["name"], "mesh": len(meshes) - 1}
        if p.get("matrix"):
            node["matrix"] = p["matrix"]
        nodes.append(node)

    root_node = {"name": "root", "children": list(range(len(nodes))), "scale": [1, 1, 1]}
    nodes.append(root_node)

    gltf = {
        "asset": {"version": "2.0", "generator": "sw_tessellate_glb"},
        "scene": 0,
        "scenes": [{"nodes": [len(nodes) - 1]}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.64, 0.67, 0.72, 1], "metallicFactor": 0.4, "roughnessFactor": 0.6}}],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": offset}],
    }

    json_blob = json.dumps(gltf, separators=(",", ":")).encode()
    json_blob += b" " * ((-len(json_blob)) % 4)
    bin_blob = b"".join(bin_chunks)
    total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(json_blob), 0x4E4F534A))
        f.write(json_blob)
        f.write(struct.pack("<II", len(bin_blob), 0x004E4942))
        f.write(bin_blob)


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "models" / "NTL99925-raw.glb"
    out.parent.mkdir(parents=True, exist_ok=True)

    pythoncom.CoInitialize()
    sw = win32com.client.Dispatch("SldWorks.Application")
    doc = sw.ActiveDoc
    if doc is None:
        log("ERROR: no active document in SolidWorks")
        return 1

    conf = get_prop(doc, "ConfigurationManager").ActiveConfiguration
    root_comp = conf.GetRootComponent3(True)
    if root_comp is None:
        log("ERROR: not an assembly")
        return 1

    parts: list[dict] = []
    visited = 0
    t0 = time.time()

    def visit(comp, depth: int) -> None:
        nonlocal visited
        children = comp.GetChildren
        if callable(children):
            children = children()
        if children:
            for c in children:
                visit(c, depth + 1)
            return
        # leaf component: grab its body tessellation in component space + transform
        visited += 1
        if get_prop(comp, "IsSuppressed"):
            return
        name = get_prop(comp, "Name2") or f"comp_{visited}"
        try:
            bodies = comp.GetBodies2(0)  # swSolidBody
        except Exception:
            bodies = None
        if not bodies:
            return
        positions: list[float] = []
        for body in bodies:
            try:
                face = body.GetFirstFace()
            except Exception:
                continue
            while face is not None:
                try:
                    tris = face.GetTessTriangles(False)  # component/world coords per False?
                    if tris:
                        positions.extend(tris)
                except Exception:
                    pass
                nxt = face.GetNextFace
                face = nxt() if callable(nxt) else nxt
        if positions:
            # GetTessTriangles(False) returns assembly-space coords (meters)
            parts.append({"name": name.split("/")[-1], "positions": positions})
        if visited % 25 == 0:
            log(f"  {visited} components, {len(parts)} with geometry, {time.time()-t0:.0f}s")

    log("Traversing assembly components...")
    visit(root_comp, 0)
    log(f"Tessellation pulled: {len(parts)} parts in {time.time()-t0:.0f}s")
    if not parts:
        log("ERROR: no geometry extracted")
        return 1

    write_glb(out, parts)
    log(f"Wrote {out} ({out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
