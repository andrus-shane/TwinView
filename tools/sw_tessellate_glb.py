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
            stop_evt.wait(0.4)  # fast poll: dialog-dismiss latency gates unsuppress speed

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

    # CRITICAL: the big structural parts (deck, frame rails — 2 m) are SUPPRESSED
    # in this config, and GetBodies2 returns nothing for suppressed components.
    # ResolveAllLightWeightComponents only handles lightweight, NOT suppressed.
    # SolidWorks also CRASHES reliably after ~18-20 unsuppress rebuilds on this
    # assembly, so the harness must make progress durable (Save3 the assembly
    # every few flips), self-heal (kill zombie SW, reopen, continue), and track
    # a crash suspect (the in-flight component) via a sidecar file so a genuine
    # poison part gets blacklisted after crashing twice.
    import json
    import subprocess

    SW_SUPPRESSED = 0  # swComponentSuppressionState_e.swComponentSuppressed
    SW_RESOLVED = 2    # swComponentSuppressionState_e.swComponentResolved
    SAVE_EVERY = 3     # flips between Save3 checkpoints (crashes every ~2-5 flips)
    MIN_EXTENT = 0.25  # m — skip suppressed components smaller than this; crashes
                       # are the scarce resource, don't spend them on screws
    STATE_FILE = ROOT / "models" / "_unsuppress_state.json"

    def load_state() -> dict:
        if STATE_FILE.exists():
            try:
                return json.loads(STATE_FILE.read_text())
            except Exception:
                pass
        return {"blacklist": [], "suspects": {}, "inflight": None}

    def save_state(st: dict) -> None:
        STATE_FILE.write_text(json.dumps(st, indent=1))

    def sw_procs():
        import psutil
        return [p for p in psutil.process_iter(["name"])
                if p.info["name"] and "SLDWORKS" in p.info["name"].upper()]

    def sw_healthy() -> bool:
        procs = sw_procs()
        # a crashed SW lingers as a zombie shell with tiny RSS
        return bool(procs) and sum(p.memory_info().rss for p in procs) > 500e6

    def kill_sw() -> None:
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Stop-Process -Name SLDWORKS -Force -ErrorAction SilentlyContinue"],
                       capture_output=True)
        time.sleep(5)

    sw = None
    doc = None

    def connect(force_new: bool = False):
        """(Re)connect to SolidWorks and get the assembly open + lightweight-resolved."""
        nonlocal sw, doc
        if force_new or not sw_healthy():
            log("  [heal] killing SolidWorks and reconnecting...")
            kill_sw()
        sw = win32com.client.Dispatch("SldWorks.Application")
        sw.Visible = True
        doc = None
        try:
            active = sw.ActiveDoc
            if active is not None and doc_title(active).lower().startswith(src.stem.lower()):
                doc = active
                log("  attached to open assembly")
        except Exception:
            doc = None
        if doc is None:
            log(f"  opening assembly (silent): {src.name}")
            t0 = time.time()
            errs = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
            warns = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
            doc = sw.OpenDoc6(str(src), SW_DOC_ASSEMBLY, SW_OPEN_SILENT, "", errs, warns)
            if doc is None:
                doc = sw.ActiveDoc
            if doc is None:
                raise RuntimeError(f"assembly failed to open (errors={errs.value})")
            log(f"  assembly open in {time.time() - t0:.0f}s")
        try:
            doc.ResolveAllLightWeightComponents(False)
        except Exception:
            pass
        return doc

    def com_alive() -> bool:
        try:
            _ = doc.GetTitle
            return True
        except Exception:
            return False

    def fresh_root():
        return doc.ConfigurationManager.ActiveConfiguration.GetRootComponent3(True)

    def suppressed_names() -> list[str]:
        """Names (not COM refs) of all currently suppressed components.
        Name2 is a full path like 'subasm-1/part-1' usable with GetComponentByName."""
        acc: list[str] = []

        def walk(comp):
            try:
                if comp.GetSuppression2 == SW_SUPPRESSED:
                    nm = comp.Name2
                    if nm:
                        acc.append(nm)
            except Exception:
                pass
            try:
                kids = comp.GetChildren
            except Exception:
                return
            if kids:
                for k in kids:
                    walk(k)

        walk(fresh_root())
        return acc

    def checkpoint_save() -> None:
        """Persist unsuppressed state into the assembly file so crashes can't
        undo progress. Save dialogs are dismissed by the watchdog."""
        errs = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        warns = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        try:
            rc = doc.Save3(1, errs, warns)  # 1 = swSaveAsOptions_Silent
            log(f"  checkpoint Save3 rc={rc} errors={errs.value}")
        except Exception as e:
            log(f"  checkpoint Save3 raised: {e}")

    # A component whose unsuppress was in-flight during a crash is a suspect;
    # two strikes = poison, blacklisted for good. Clean failures (call returns
    # but state stays suppressed, e.g. Toolbox parts missing their size DB)
    # are blacklisted immediately.
    state = load_state()
    if state.get("inflight"):
        nm = state["inflight"]
        state["suspects"][nm] = state["suspects"].get(nm, 0) + 1
        log(f"  [heal] previous run died while unsuppressing {nm!r} "
            f"(strike {state['suspects'][nm]})")
        if state["suspects"][nm] >= 2:
            state["blacklist"].append(nm)
            log(f"  [heal] {nm!r} blacklisted as poison")
        state["inflight"] = None
        save_state(state)

    connect()
    tu = time.time()
    total_flipped = 0
    flips_since_save = 0
    for rnd in range(1, 25):
        if not com_alive():
            connect()
        unresolvable = set(state["blacklist"])
        names = suppressed_names()
        candidates = [n for n in names if n not in unresolvable]

        # Biggest-first: GetBox works on suppressed components (cached bounds),
        # so spend the limited flips-per-crash budget on structure, not hardware.
        def extent_of(nm: str) -> float:
            try:
                c = doc.GetComponentByName(nm)
                box = c.GetBox(False, False) if c is not None else None
                if box and len(box) >= 6:
                    return max(box[3] - box[0], box[4] - box[1], box[5] - box[2])
            except Exception:
                pass
            return 0.0

        sized = sorted(((extent_of(n), n) for n in candidates), reverse=True)
        targets = [n for ext, n in sized if ext >= MIN_EXTENT]
        skipped_small = len(candidates) - len(targets)
        if not targets:
            log(f"Unsuppress round {rnd}: no structural components left "
                f"({skipped_small} small parts and {len(names) - len(candidates)} "
                f"blacklisted remain suppressed) — done")
            break
        log(f"  round {rnd}: {len(targets)} structural targets "
            f"(largest {sized[0][0]:.2f}m), {skipped_small} small skipped")
        flipped = 0
        for i, nm in enumerate(targets):
            if not com_alive():
                # crash mid-round: heal and let the next round retry non-suspects
                if flips_since_save:
                    log("  [heal] crash cost the unsaved flips since last checkpoint")
                connect()
                flips_since_save = 0
                break
            state["inflight"] = nm
            save_state(state)
            ok = False
            clean_fail = False
            try:
                comp = doc.GetComponentByName(nm)
                if comp is None:
                    clean_fail = True
                else:
                    comp.SetSuppression2(SW_RESOLVED)
                    ok = comp.GetSuppression2 != SW_SUPPRESSED
                    clean_fail = not ok
            except Exception:
                # infra failure: crash handling happens at loop top; a live-SW
                # exception is treated as a suspect strike too
                state["suspects"][nm] = state["suspects"].get(nm, 0) + 1
                if state["suspects"][nm] >= 2:
                    state["blacklist"].append(nm)
            state["inflight"] = None
            if ok:
                flipped += 1
                flips_since_save += 1
                if flips_since_save >= SAVE_EVERY:
                    checkpoint_save()
                    flips_since_save = 0
            elif clean_fail and nm not in state["blacklist"]:
                state["blacklist"].append(nm)
            save_state(state)
            if (i + 1) % 25 == 0:
                log(f"  round {rnd}: {i + 1}/{len(targets)} processed, {flipped} flipped")
        total_flipped += flipped
        log(f"Unsuppress round {rnd}: {flipped}/{len(targets)} flipped, "
            f"{len(state['blacklist'])} blacklisted")
        if flips_since_save:
            checkpoint_save()
            flips_since_save = 0
        try:
            doc.ResolveAllLightWeightComponents(False)  # sub-asms arrive lightweight
        except Exception:
            pass
        if flipped == 0 and len(targets) == len(suppressed_names()):
            log("WARNING: remaining suppressed components won't unsuppress; continuing")
            break
    if not com_alive():
        connect()
    try:
        doc.ForceRebuild3(False)
    except Exception as e:
        log(f"ForceRebuild3 raised (continuing): {e}")
    leftover = suppressed_names()
    log(f"Unsuppress done in {time.time() - tu:.0f}s: {total_flipped} flipped this run, "
        f"{len(leftover)} still suppressed")
    root_comp = fresh_root()
    if root_comp is None:
        log("ERROR: not an assembly / no root component")
        return 1

    # Saved-resolved components reopen LIGHTWEIGHT (SW default for big asms) and
    # IsSuppressed reports True for lightweight too — so resolve-and-VERIFY here,
    # or the walk below silently skips all the structure we fought to unsuppress.
    SW_LIGHTWEIGHT = 1

    def count_lightweight() -> int:
        n = 0

        def w(c):
            nonlocal n
            try:
                if c.GetSuppression2 == SW_LIGHTWEIGHT:
                    n += 1
            except Exception:
                pass
            try:
                kids = c.GetChildren
            except Exception:
                return
            if kids:
                for k in kids:
                    w(k)

        w(fresh_root())
        return n

    for _ in range(4):
        lw = count_lightweight()
        log(f"Lightweight components remaining: {lw}")
        if lw == 0:
            break
        try:
            rc = doc.ResolveAllLightWeightComponents(False)
            log(f"ResolveAllLightWeightComponents rc={rc}")
        except Exception as e:
            log(f"ResolveAllLightWeightComponents raised: {e}")
        time.sleep(2)
    root_comp = fresh_root()  # resolve may rebuild; refetch

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
            # ONLY skip truly suppressed (state 0) — IsSuppressed would also
            # skip lightweight components, which is how we lost the structure.
            if prop(comp, "GetSuppression2") == 0:
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
