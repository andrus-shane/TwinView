#!/bin/bash
# check_pi.sh - health check of a rig-monitor Pi from a Windows host (Git Bash + PuTTY plink).
#
#   PI_PASS=... bash pi-rig-monitor/check_pi.sh [host] [--no-adb-bridge]
#
# host defaults to testingraspberryzero2.local. The password is taken from
# $PI_PASS (never stored here - see team notes). --no-adb-bridge disables the
# console USB adb bridge units on a Pi that sits on a BLE-console unit (no
# tablet on USB, so the bridge loop only logs "waiting" forever).
#
# Checks: reachability, rig-monitor.service + tach_quad child, WT901 on I2C,
# recent journal, and a 1.5 s sample of the tcp/5000 stream, then the same
# stream read from THIS host (what TwinView's net source will see).
set -u
HOST="${1:-testingraspberryzero2.local}"
NOBRIDGE=0; [ "${2:-}" = "--no-adb-bridge" ] && NOBRIDGE=1
USER_="testingdept"
PLINK="/c/Program Files/PuTTY/plink.exe"
[ -x "$PLINK" ] || PLINK="plink"
: "${PI_PASS:?set PI_PASS to the Pi password}"

say() { printf '\n== %s\n' "$*"; }

say "reachability ($HOST)"
if ! ping -n 1 -w 1500 "$HOST" >/dev/null 2>&1; then
  echo "ping failed: name does not resolve or host is down. Is this box on the bench subnet?"
  exit 2
fi
ping -n 1 -w 1500 "$HOST" | grep -E "Reply|TTL" | head -1

# One remote shell, one round trip. plink prompts for unknown host keys on the
# Windows console (not stdin) and hangs when scripted, so fetch the key with
# ssh-keyscan (Git for Windows / OpenSSH) and pin it via -hostkey -batch.
REMOTE=$(cat <<'RS'
echo "--- host"; hostname; hostname -I; uptime -p
echo "--- wifi"; nmcli -t -f ACTIVE,SSID,SIGNAL,FREQ,SECURITY dev wifi 2>/dev/null | grep "^yes" || iwgetid -r 2>/dev/null; cat /proc/net/wireless | tail -n +3; ip -4 -br addr show wlan0
echo "--- rig-monitor.service"; systemctl is-active rig-monitor; systemctl show rig-monitor -p NRestarts -p ActiveEnterTimestamp --no-pager
echo "--- tach_quad child"; pgrep -a tach_quad || echo "tach_quad NOT running"
echo "--- adb bridge units"; systemctl is-active adb-server adb-bridge 2>/dev/null | paste -sd' '; systemctl is-enabled adb-server adb-bridge 2>/dev/null | paste -sd' '
echo "--- i2c (WT901 expected at 0x50)"; i2cdetect -y 1 2>/dev/null | grep -E "^50:" || echo "i2cdetect: no row 50 (i2c-tools missing or bus down)"
echo "--- journal (last 15)"; journalctl -u rig-monitor -n 15 --no-pager -o short-iso 2>/dev/null
echo "--- tcp/5000 sample (1.5 s, local)"; timeout 1.5 nc -w 2 127.0.0.1 5000 2>/dev/null | head -12 || echo "no data on 5000"
echo "--- listeners"; ss -ltnp 2>/dev/null | grep -E ":5000|:5555|:22 " 
RS
)
if [ "$NOBRIDGE" = 1 ]; then
  REMOTE="$REMOTE"$'\n''echo "--- disabling adb bridge (BLE unit, no USB console)"; sudo systemctl disable --now adb-bridge adb-server 2>&1 | tail -2; systemctl is-active adb-server adb-bridge | paste -sd" "'
fi

say "remote checks (plink)"
FP=$(ssh-keyscan -T 5 -t ed25519 "$HOST" 2>/dev/null | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')
if [ -z "$FP" ]; then echo "could not fetch the Pi ssh host key (ssh-keyscan) - is sshd up?"; exit 3; fi
echo "host key: $FP"
"$PLINK" -batch -ssh -hostkey "$FP" -l "$USER_" -pw "$PI_PASS" "$HOST" "$REMOTE" 2>&1

say "stream as seen from this host ($HOST:5000, 2 s)"
python - "$HOST" <<'PY'
import socket, sys, time
h = sys.argv[1]
try:
    s = socket.create_connection((h, 5000), timeout=3)
except OSError as e:
    print("connect failed:", e); sys.exit(3)
s.settimeout(2.5); buf = b""; t0 = time.time()
while time.time() - t0 < 2.0:
    try: buf += s.recv(4096)
    except socket.timeout: break
lines = buf.decode("ascii", "replace").splitlines()
print(f"{len(lines)} lines in 2 s (expect ~200 = 10 channels x 10 Hz)")
for l in lines[:10]: print("  " + l)
ok = any(l.startswith("incline.grade:") for l in lines) and any(l.startswith("tach.mph:") for l in lines)
print("channels TwinView needs:", "present" if ok else "MISSING")
sys.exit(0 if ok else 4)
PY
