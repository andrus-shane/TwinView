"""Export the open SolidWorks assembly to .glb by driving the Extended Reality
exporter ADD-IN directly (ISWXRExporter::GLTF_FileSave_Assembly) — the same
code path as File > Save As > *.glb in the UI, which the SaveAs COM API refuses
(error 256, invalid extension).

Usage: python tools/sw_xr_addin_export.py [input.SLDASM] [output.glb]
Attaches to a running SolidWorks with the assembly open, or opens it.
"""
import sys
import threading
import time
from pathlib import Path

import pythoncom
import win32com.client
from win32com.client import VARIANT

ROOT = Path(__file__).resolve().parent.parent
SW_DOC_ASSEMBLY = 2
SW_OPEN_SILENT = 1  # swOpenDocOptions_Silent — suppress reference/open dialogs

# swFileLoadError_e (bitmask) — the codes worth naming
FILE_LOAD_ERRORS = {
    1: "swGenericError",
    2: "swFileNotFoundError",
    1024: "swInvalidFileTypeError",
    8192: "swFutureVersion (file saved by a NEWER SolidWorks than this install - cannot be opened; use a machine with a matching or newer SolidWorks)",
    65536: "swFileWithSameTitleAlreadyOpen",
    262144: "swLowResourcesError",
    524288: "swNoDisplayData",
    1048576: "swAddinInteruptError",
    2097152: "swFileRequiresRepairError",
    8388608: "swApplicationBusy",
}


def decode_load_error(mask: int) -> str:
    hits = [name for bit, name in FILE_LOAD_ERRORS.items() if mask & bit]
    return ", ".join(hits) if hits else f"unknown code {mask}"

XR_ADDIN_CLSID = "{0D27D5D6-EB7F-4C0D-82EA-51017C236BDB}"  # SWXRExporter coclass
XR_ADDIN_DLL = r"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\SWXRExporter.dll"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def doc_title(doc) -> str:
    t = doc.GetTitle
    return t if isinstance(t, str) else t()


def start_dialog_watchdog(stop_evt: threading.Event) -> threading.Thread:
    """Belt-and-suspenders: auto-accept any modal SolidWorks dialog (press its
    default button) so a stray prompt can never block the headless run."""
    import win32con
    import win32gui
    import win32process
    import psutil

    def run() -> None:
        while not stop_evt.is_set():
            try:
                sw_pids = {p.pid for p in psutil.process_iter(["name"])
                           if p.info["name"] and "SLDWORKS" in p.info["name"].upper()}
                dialogs = []

                def cb(h, _):
                    _, pid = win32process.GetWindowThreadProcessId(h)
                    if pid in sw_pids and win32gui.GetClassName(h) == "#32770" and win32gui.IsWindowVisible(h):
                        dialogs.append(h)
                    return True

                win32gui.EnumWindows(cb, None)
                for dlg in dialogs:
                    title = win32gui.GetWindowText(dlg)
                    log(f"  [watchdog] dismissing modal: {title!r} (pressing default)")
                    # IDOK / default button
                    win32gui.PostMessage(dlg, win32con.WM_COMMAND, 1, 0)
            except Exception:
                pass
            stop_evt.wait(2)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


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
    rev = str(sw.RevisionNumber)  # major = model year - 1992 (30 = 2022, 32 = 2024)
    log(f"SolidWorks revision {rev} (~{1992 + int(rev.split('.')[0])})")
    try:
        sw.UserControl = False
    except Exception:
        pass

    doc = None
    try:
        active = sw.ActiveDoc
        if active is not None and doc_title(active).lower().startswith(src.stem.lower()):
            log("Attached to already-open assembly")
            doc = active
    except Exception:
        pass
    if doc is None:
        log(f"Opening assembly (silent, resolved): {src.name} (takes ~10-15 min)")
        t0 = time.time()
        errs = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        warns = VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        try:
            doc = sw.OpenDoc6(str(src), SW_DOC_ASSEMBLY, SW_OPEN_SILENT, "", errs, warns)
            log(f"OpenDoc6 errors={errs.value} warnings={warns.value}")
        except Exception as e:
            log(f"OpenDoc6 raised: {e}")
        if doc is None:
            doc = sw.ActiveDoc
        if doc is None:
            log(f"ERROR: assembly failed to open - {decode_load_error(errs.value)}")
            return 1
        if warns.value:
            log(f"Open warnings bitmask: {warns.value}")
        log(f"Assembly open in {time.time() - t0:.0f}s")

    log("Getting XR exporter add-in object...")
    addin = None
    try:
        addin = sw.GetAddInObject(XR_ADDIN_CLSID)
    except Exception as e:
        log(f"GetAddInObject(clsid) raised: {e}")
    if addin is None:
        log("Add-in not loaded; loading SWXRExporter.dll...")
        try:
            rc = sw.LoadAddIn(XR_ADDIN_DLL)
            log(f"LoadAddIn rc={rc}")
            addin = sw.GetAddInObject(XR_ADDIN_CLSID)
        except Exception as e:
            log(f"LoadAddIn/GetAddInObject raised: {e}")
    if addin is None:
        log("ERROR: could not obtain XR exporter add-in object")
        return 1

    log(f"Calling GLTF_FileSave_Assembly -> {out}")
    t0 = time.time()
    try:
        result = addin.GLTF_FileSave_Assembly(str(out))
        log(f"GLTF_FileSave_Assembly returned {result!r}")
    except Exception as e:
        log(f"GLTF_FileSave_Assembly raised: {e}")
        try:
            result = addin.GLTF_FileSave_Part(str(out))
            log(f"GLTF_FileSave_Part returned {result!r}")
        except Exception as e2:
            log(f"GLTF_FileSave_Part raised: {e2}")
            return 1

    # exporter may run async in the UI thread; poll for the file
    for _ in range(180):
        if out.exists() and out.stat().st_size > 0:
            s1 = out.stat().st_size
            time.sleep(3)
            if out.stat().st_size == s1:  # stopped growing
                stop_evt.set()
                log(f"SUCCESS: {out} ({s1 / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
                return 0
        time.sleep(2)

    stop_evt.set()
    log("ERROR: no .glb produced within timeout")
    return 1


if __name__ == "__main__":
    sys.exit(main())
