"""Extract the SolidWorks pack-and-go zip into cad/<model>/ and normalize the root assembly name.

Usage: python tools/extract_cad.py [zip_path] [dest_dir]
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    zip_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_NTL99925-1M00.zip"
    dest = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "cad" / "NTL99925-1M00"
    dest.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        print(f"Extracting {len(names)} entries from {zip_path.name} -> {dest}")
        z.extractall(dest)

    # SolidWorks pack-and-go roots sometimes carry a leading ~; strip it so the
    # file isn't mistaken for a temp/lock file. Child references are unaffected.
    for f in dest.iterdir():
        if f.name.startswith("~") and f.suffix.upper() in (".SLDASM", ".SLDPRT"):
            target = f.with_name(f.name.lstrip("~"))
            if not target.exists():
                f.rename(target)
                print(f"Renamed root: {f.name} -> {target.name}")

    asms = sorted(dest.glob("*.SLDASM"), key=lambda p: -p.stat().st_size)
    print(f"Done. Largest assembly (likely root): {asms[0].name if asms else 'NONE'}")


if __name__ == "__main__":
    main()
