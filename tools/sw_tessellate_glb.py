"""Plan C: pull SolidWorks' already-computed display tessellation straight out of
the open assembly via COM (IFace2::GetTessTriangles) and write a GLB directly —
no file exporter involved. Reads the triangles SolidWorks already has in memory
for display, so it's bounded (COM round-trips, not re-tessellation) and we
control the output size. Preserves per-component names and world transforms.

Usage: python tools/sw_tessellate_glb.py [input.SLDASM] [output.glb]
Opens the assembly silently if not already open.
"""
import struct
import sys
import threading
import time
from pathlib import Path

import pythoncom
import win32com.client
from win32com.client import VARIANT

ROOT = Path(__file__).resolve().parent.parent
SW_DOC_ASSEMBLY = 2
SW_OPEN_SILENT = 1


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def doc_title(doc) -> str:
    t = doc.GetTitle
    return t if isinstance(t, str) else t()


def prop(obj, name):
    v = getattr(obj, name)
    return v() if callable(v) else v


def start_dialog_watchdog(stop_evt: threading.Event) -> None:
    import win32con, win32gui, win32process, psutil

    def run() -> None:
        while not stop_evt.is_set():
            try:
                pids = {p.pid for p in psutil.process_iter(["name"])
                        if p.info["name"] and "SLDWORKS" in p.info["name"].upper()}
                dlgs = []

                def cb(h, _):
                    _, pid = win32process.GetWindowThreadProcessId(h)
                    if pid in pids and win32gui.GetClassName(h) == "#32770" and win32gui.IsWindowVisible(h):
                        dlgs.append(h)
                    return True

                win32gui.EnumWindows(cb, None)
                for d in dlgs:
                    log(f"  [watchdog] dismissing modal: {win32gui.GetWindowText(d)!r}")
                    win32gui.PostMessage(d, win32con.WM_COMMAND, 1, 0)
            except Exception:
                pass
            stop_evt.wait(2)

    threading.Thread(target=run, daemon=True).start()


def transform_points(flat_xyz: list[float], m: list[float]) -> list[float]:
    """Apply a SolidWorks IMathTransform ArrayData (r0..r8 rot, t0..t2 trans, s scale)
    to a flat [x,y,z,...] list, returning a new flat list in assembly space (meters)."""
    r = m[0:9]
    tx, ty, tz = m[9], m[10], m[11]
    s = m[12] if len(m) > 12 and m[12] else 1.0
    out = [0.0] * len(flat_xyz)
    for i in range(0, len(flat_xyz), 3):
        x, y, z = flat_xyz[i], flat_xyz[i + 1], flat_xyz[i + 2]
        # SolidWorks stores rotation column-major: point' = R*point*scale + T
        out[i] = (r[0] * x + r[3] * y + r[6] * z) * s + tx
        out[i + 1] = (r[1] * x + r[4] * y + r[7] * z) * s + ty
        out[i + 2] = (r[2] * x + r[5] * y + r[8] * z) * s + tz
    return out


def write_glb(out_path: Path, parts: list[dict]) -> None:
    bin_chunks, accessors, buffer_views, meshes, nodes = [], [], [], [], []
    offset = 0
    for p in parts:
        pos = p["positions"]
        blob = struct.pack(f"<{len(pos)}f", *pos)
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
        meshes.append({"name": p["name"],
                       "primitives": [{"attributes": {"POSITION": len(accessors) - 1}, "material": 0, "mode": 4}]})
        nodes.append({"name": p["name"], "mesh": len(meshes) - 1})

    nodes.append({"name": "NTL99925", "children": list(range(len(nodes)))})
    import json
    gltf = {
        "asset": {"version": "2.0", "generator": "sw_tessellate_glb"},
        "scene": 0, "scenes": [{"nodes": [len(nodes) - 1]}], "nodes": nodes, "meshes": meshes,
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.64, 0.67, 0.72, 1],
                                                 "metallicFactor": 0.4, "roughnessFactor": 0.6}}],
        "accessors": accessors, "bufferViews": buffer_views, "buffers": [{"byteLength": offset}],
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
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "cad" / "NTL99925-1M00" / "NTL99925-1M00.SLDASM"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "models" / "NTL99925-raw.glb"
    out.parent.mkdir(parents=True, exist_ok=True)

    pythoncom.CoInitialize()
    stop_evt = threading.Event()
    start_dialog_watchdog(stop_evt)

    log("Connecting to SolidWorks...")
    sw = win32com.client.Dispatch("SldWorks.Application")
    sw.Visible = True

    doc = None
    try:
        active = sw.ActiveDoc
        if active is not None and doc_title(active).lower().startswith(src.stem.lower()):
            log("Attached to already-open assembly")
            doc = active
    except Exception:
        pass
    if doc is None:
        log(f"Opening assembly (silent): {src.name}")
        t0 = time.time()
        errs = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        warns = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        doc = sw.OpenDoc6(str(src), SW_DOC_ASSEMBLY, SW_OPEN_SILENT, "", errs, warns)
        if doc is None:
            doc = sw.ActiveDoc
        if doc is None:
            log("ERROR: assembly failed to open")
            return 1
        log(f"Assembly open in {time.time() - t0:.0f}s")

    # Large assemblies open with lightweight components (geometry not loaded),
    # so GetBodies2 returns None until resolved. This pops a "Resolve Lightweight
    # Components" modal — the watchdog auto-clicks its OK (IDOK) for us.
    log("Resolving lightweight components (loads all part geometry — can take minutes)...")
    tr = time.time()
    try:
        doc.ResolveAllLightWeightComponents(True)
        log(f"Resolve complete in {time.time() - tr:.0f}s")
    except Exception as e:
        log(f"ResolveAllLightWeightComponents raised (continuing): {e}")

    # NOTE: don't use prop() for dispatch-returning properties — pywin32 dynamic
    # dispatch objects are always callable(), so prop() would invoke them.
    conf = doc.ConfigurationManager.ActiveConfiguration
    root_comp = conf.GetRootComponent3(True)

    # CRITICAL: the big structural parts (deck, frame rails — 2 m) are SUPPRESSED
    # in this config, and GetBodies2 returns nothing for suppressed components.
    # ResolveAllLightWeightComponents only handles lightweight, NOT suppressed —
    # so select every suppressed component and unsuppress in one batch rebuild.
    SW_SUPPRESSED = 0  # swComponentSuppressionState_e.swComponentSuppressed
    SW_RESOLVED = 2    # swComponentSuppressionState_e.swComponentResolved

    def find_suppressed(comp, acc):
        try:
            if comp.GetSuppression2 == SW_SUPPRESSED:
                acc.append(comp)
        except Exception:
            pass
        kids = comp.GetChildren
        if kids:
            for k in kids:
                find_suppressed(k, acc)

    # Iterative per-component unsuppress: SetSuppression2 acts on one component
    # and returns a checkable result (batch Select4+EditUnsuppress2 silently did
    # nothing here). Newly-resolved sub-assemblies come back LIGHTWEIGHT and only
    # then expose children (which may themselves be suppressed), so alternate
    # unsuppress rounds with resolve-lightweight passes until a pass finds none.
    tu = time.time()
    total_flipped = 0
    try:
        sw.CommandInProgress = True  # defer per-call GUI/rebuild overhead
    except Exception:
        pass
    for rnd in range(1, 13):
        suppressed = []
        find_suppressed(root_comp, suppressed)
        if not suppressed:
            log(f"Unsuppress round {rnd}: none found — done")
            break
        flipped = 0
        for i, comp in enumerate(suppressed):
            try:
                comp.SetSuppression2(SW_RESOLVED)
                if comp.GetSuppression2 != SW_SUPPRESSED:
                    flipped += 1
            except Exception:
                pass
            if (i + 1) % 50 == 0:
                log(f"  round {rnd}: {i + 1}/{len(suppressed)} processed")
        total_flipped += flipped
        log(f"Unsuppress round {rnd}: {flipped}/{len(suppressed)} flipped")
        try:
            doc.ResolveAllLightWeightComponents(True)  # sub-asms arrive lightweight
        except Exception:
            pass
        if flipped == 0:
            log("WARNING: remaining suppressed components won't unsuppress; continuing")
            break
    try:
        sw.CommandInProgress = False
    except Exception:
        pass
    try:
        doc.ForceRebuild3(False)
    except Exception as e:
        log(f"ForceRebuild3 raised (continuing): {e}")
    leftover = []
    find_suppressed(root_comp, leftover)
    log(f"Unsuppress done in {time.time() - tu:.0f}s: {total_flipped} flipped, {len(leftover)} still suppressed")
    if root_comp is None:
        log("ERROR: not an assembly / no root component")
        return 1

    parts: list[dict] = []
    stats = {"visited": 0, "suppressed": 0, "nogeom": 0}
    t0 = time.time()

    def visit(comp) -> None:
        children = prop(comp, "GetChildren")
        if children:
            for c in children:
                visit(c)
            return
        stats["visited"] += 1
        try:
            if prop(comp, "IsSuppressed"):
                stats["suppressed"] += 1
                return
        except Exception:
            pass
        name = (prop(comp, "Name2") or f"comp_{stats['visited']}").split("/")[-1]
        try:
            xform = comp.Transform2
            m = list(xform.ArrayData) if xform is not None else None
        except Exception:
            m = None
        try:
            bodies = comp.GetBodies2(0)  # swSolidBody = 0
        except Exception:
            bodies = None
        if not bodies:
            stats["nogeom"] += 1
            return
        positions: list[float] = []
        for body in bodies:
            # GetFaces() returns all faces as an array — the GetFirstFace/GetNextFace
            # linked-list walk isn't reliably exposed on this dynamic dispatch.
            try:
                faces = body.GetFaces()
            except Exception:
                continue
            if not faces:
                continue
            for face in faces:
                try:
                    tris = face.GetTessTriangles(True)  # True = part-local coords, meters
                    if tris:
                        positions.extend(tris)
                except Exception:
                    pass
        if not positions:
            stats["nogeom"] += 1
            return
        if m:
            positions = transform_points(positions, m)
        parts.append({"name": name, "positions": positions})
        if stats["visited"] % 25 == 0:
            log(f"  {stats['visited']} comps, {len(parts)} w/ geom, {time.time()-t0:.0f}s")

    log("Traversing components and pulling tessellation...")
    visit(root_comp)
    stop_evt.set()
    tris = sum(len(p["positions"]) // 9 for p in parts)
    log(f"Pulled {len(parts)} parts / {tris} triangles in {time.time()-t0:.0f}s "
        f"(visited {stats['visited']}, suppressed {stats['suppressed']}, no-geom {stats['nogeom']})")
    if not parts:
        log("ERROR: no geometry extracted")
        return 1

    # overall bbox (meters) — sanity check on coordinate handling; treadmill ~2m
    allx = [v for p in parts for v in p["positions"][0::3]]
    ally = [v for p in parts for v in p["positions"][1::3]]
    allz = [v for p in parts for v in p["positions"][2::3]]
    log(f"bbox (m): x[{min(allx):.2f},{max(allx):.2f}] "
        f"y[{min(ally):.2f},{max(ally):.2f}] z[{min(allz):.2f},{max(allz):.2f}]  "
        f"extent {max(allx)-min(allx):.2f} x {max(ally)-min(ally):.2f} x {max(allz)-min(allz):.2f}")

    write_glb(out, parts)
    log(f"SUCCESS: {out} ({out.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
