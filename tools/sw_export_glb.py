"""Export a SolidWorks assembly to web formats via the SolidWorks COM API.

Strategy ladder:
  1. IModelDocExtension::SaveAs3 -> .glb  (Extended Reality exporter, needs
     early-bound COM; run makepy on sldworks.tlb first)
  2. IModelDoc2::SaveAs3 -> .step         (always available; convert to GLB
     afterwards with tools/step_to_glb.mjs)

Usage: python tools/sw_export_glb.py [input.SLDASM] [output.glb]
"""
import sys
import time
from pathlib import Path

import pythoncom
import win32com.client
from win32com.client import gencache

ROOT = Path(__file__).resolve().parent.parent

SW_DOC_ASSEMBLY = 2
SW_SAVE_CURRENT_VERSION = 0
SW_SAVE_OPTION_SILENT = 1
SLDWORKS_TLB = r"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\sldworks.tlb"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def doc_title(doc) -> str:
    t = doc.GetTitle
    return t if isinstance(t, str) else t()


def ensure_early_binding() -> bool:
    try:
        gencache.EnsureModule("{83A33D31-27C5-11CE-BFD4-00400513BB57}", 0, 32, 0)  # sldworks 2024
        return True
    except Exception:
        pass
    try:
        from win32com.client import makepy
        makepy.GenerateFromTypeLibSpec(SLDWORKS_TLB)
        return True
    except Exception as e:
        log(f"makepy failed: {e}")
        return False


def try_xr_export(doc, out: Path) -> bool:
    """Extension.SaveAs3 with the XR exporter (.glb). Needs explicit VARIANT marshaling."""
    from win32com.client import VARIANT

    try:
        ext = doc.Extension
        null_disp = VARIANT(pythoncom.VT_DISPATCH, None)
        errs = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        warns = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        result = ext.SaveAs3(str(out), SW_SAVE_CURRENT_VERSION, SW_SAVE_OPTION_SILENT,
                             null_disp, null_disp, errs, warns)
        log(f"Extension.SaveAs3 -> {result!r} errors={errs.value} warnings={warns.value}")
    except Exception as e:
        log(f"Extension.SaveAs3(.glb) raised: {e}")
        return False
    time.sleep(2)
    return out.exists() and out.stat().st_size > 0


def try_saveas3(doc, out: Path) -> bool:
    try:
        rc = doc.SaveAs3(str(out), SW_SAVE_CURRENT_VERSION, SW_SAVE_OPTION_SILENT)
        log(f"SaveAs3({out.suffix}) rc={rc}")
    except Exception as e:
        log(f"SaveAs3({out.suffix}) raised: {e}")
        return False
    time.sleep(2)
    return out.exists() and out.stat().st_size > 0


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "cad" / "NTL99925-1M00" / "NTL99925-1M00.SLDASM"
    out_glb = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "models" / "NTL99925-raw.glb"
    out_step = out_glb.with_suffix(".step")
    out_glb.parent.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        log(f"ERROR: input not found: {src}")
        return 1

    pythoncom.CoInitialize()
    early = ensure_early_binding()
    log(f"Early binding: {early}")

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
        log(f"Opening assembly: {src.name} (may take several minutes)")
        t0 = time.time()
        doc = sw.OpenDoc(str(src), SW_DOC_ASSEMBLY)
        if doc is None:
            doc = sw.ActiveDoc
        if doc is None:
            log("ERROR: assembly failed to open")
            return 1
        log(f"Assembly open in {time.time() - t0:.0f}s")

    t0 = time.time()
    log(f"Attempt 1: XR exporter -> {out_glb.name}")
    if try_xr_export(doc, out_glb):
        log(f"SUCCESS (glb): {out_glb} ({out_glb.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
        return 0

    log(f"Attempt 2: STEP export -> {out_step.name}")
    if try_saveas3(doc, out_step):
        log(f"SUCCESS (step): {out_step} ({out_step.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
        log("Next: node tools/step_to_glb.mjs to convert STEP -> GLB")
        return 0

    log("ERROR: all export attempts failed; leaving SolidWorks open")
    return 1


if __name__ == "__main__":
    sys.exit(main())
