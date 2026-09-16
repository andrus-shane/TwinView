#!/usr/bin/env python3
"""rig_monitor.py - stream WT901 incline + quadrature tach over TCP.

Reads a WT901 IMU (I2C bus 1, 0x50) and a Taiss E38S6-600-24G quadrature
encoder and fans newline-terminated "channel: value" lines out to every
connected TCP client on port 5000 at ~10 Hz.

Consumer (TwinView 'net' source) regex-matches lines beginning "incline.pitch:"
and "tach.mph:", so those prefixes are contractual.

Every line also carries the sample's own CLOCK_MONOTONIC time as an " @<ns>"
suffix ("tach.mph: 11.130 @123456789012345"). Tach lines use the C child's
t_ns -- the instant the count was sampled, the same timestamp the hz/mph
math differences -- and incline lines the time of the last successful WT901
read. TwinView strips the suffix before pattern-matching and uses it as the
sample's measurement time, so TCP/Wi-Fi arrival jitter and read coalescing
never re-enter interval/derivative math on the host; its arrival clock is
kept only for staleness watchdogs. This clock has an arbitrary epoch (boot)
and ~20 ppm drift -- the host maps it onto its own timeline with a
min-delay offset fit (see TwinView server/src/sources/net.ts PiClockSync).
Consumers that ignore the suffix keep working as long as their patterns
aren't $-anchored.

Tach backend: the tach_quad C child process (libgpiod v2). Edge handling used
to be lgpio Python callbacks, but above ~11 mph the encoder produces >50k
edges/s across A+B and per-edge Python dispatch saturates a Zero 2 W core --
events then queue and drop in bursts and the reported speed jumps around.
Moving the x4 decode into C wasn't enough either: every edge is still one
kernel interrupt (~20 us of system time on the Zero 2 W), which saturates at
~51k edges/s = an indicated ~11 mph -- the 2026-08-12 matrix run's ceiling.
The child therefore counts x1 (line A, rising edges only; the kernel never
raises the other 3/4 of the interrupts) and prints "t_ns count" samples at
50 Hz; count is PULSES (1/600 rev each), not x4 steps. Python computes
hz/mph from count deltas using the child's own monotonic timestamps, so
interpreter scheduling can no longer distort the math. x1 cannot sense
direction: the belt only runs forward, so tach.dir is motion (0/1) and
tach.count/tach.dist are monotonic.

Incline calibration: roll/pitch/yaw offsets are read from OFFSET_FILE (see
calibrate_incline.py) and subtracted from the raw angles. The file is re-read
automatically whenever it changes, so recalibration takes effect without a
restart.
"""

import math
import os
import socket
import struct
import subprocess
import threading
import time
import sys

# ---- I2C client: prefer smbus2, fall back to smbus ----
try:
    from smbus2 import SMBus
except ImportError:  # pragma: no cover
    from smbus import SMBus  # type: ignore

# ---------------------------------------------------------------------------
# Configuration / calibration (mirrors the old Arduino rig)
# ---------------------------------------------------------------------------
I2C_BUS = 1
WT901_ADDR = 0x50
WT901_ROLL_REG = 0x3D          # 0x3D..0x40 -> roll, pitch, yaw, temp (int16 LE)

GPIO_A = 17                    # encoder channel A (pin 11)
GPIO_B = 27                    # encoder channel B (pin 13)
TACH_BIN = "/opt/rig-monitor/tach_quad"   # C quadrature counter child

PULSES_PER_REV = 600           # E38S6-600: 600 PPR (= rising edges of A/rev)
# Effective rolling circumference, calibrated 2026-08-17 against the
# machine's own belt speed (14.035 mph true vs 13.849 read with the nominal
# pi*0.075 = 0.2356): the wheel rolls ~1.3% bigger than nominal (76.0 mm
# effective diameter -- tire compression/contact patch). Single scale
# constant; verified linear 1-14 mph in run ce13785c.
WHEEL_CIRC_M = 0.2388
INVERT_DIR = True              # still passed to tach_quad; unused by x1 decode

# ---- Incline pitch calibration (bubble-level ground truth, 2026-07-28) -------
# The WT901 is a gravity inclinometer, so its angle scale is physically exact
# (gain = -1); only the mounting offset needs fitting. Raw pitch (deg) at three
# treadmill settings vs the true grade measured on the deck with a level:
#     display   raw_pitch   level grade
#       -3%       +0.696      ~ -2.4%
#        0%       -1.084      ~  0.7%   <- deck sits ~0.7% uphill even at "0" to
#       30%      -17.66       ~ 30.6%      reduce motor drag: a REAL incline the
#                                          rig must report, not tare away.
# All three fit raw pitch at TRUE horizontal = PITCH_RAW_LEVEL with gain -1.
PITCH_RAW_LEVEL = -0.68        # deg: raw pitch when the deck is physically level
# true incline angle (deg, uphill +) = -(raw_pitch - PITCH_RAW_LEVEL)
# grade (%) = tan(that) * 100

# Incline zero/tare offsets (deg), written by calibrate_incline.py. Reloaded
# live when the file's mtime changes.
OFFSET_FILE = "/home/testingdept/rig-monitor-offsets.conf"

MS_TO_MPH = 2.23694
TCP_PORT = 5000
RATE_HZ = 10.0
LOOP_DT = 1.0 / RATE_HZ


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def load_offsets(path):
    off = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip().lower()
                if k in off:
                    off[k] = float(v.strip())
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print("WARN: bad offset file %s: %s" % (path, e), file=sys.stderr)
    return off


# ---------------------------------------------------------------------------
# Quadrature counter: C child process (tach_quad) does the per-edge work
# ---------------------------------------------------------------------------
class QuadratureProc:
    """Reads "t_ns count" samples from the tach_quad child.

    count is x1 encoder pulses (rising edges of A, monotonic; 600/rev);
    t_ns is the child's CLOCK_MONOTONIC timestamp, the
    same clock as time.monotonic_ns(), taken when the count was sampled.
    The (t_ns, count) pair is published as ONE tuple assignment: readers must
    never see a fresh timestamp with a stale count (that pairing skews the
    hz math low). If the child dies the whole service exits so systemd
    restarts the pair.
    """

    def __init__(self, path, gpio_a, gpio_b, invert=False):
        self.sample = (time.monotonic_ns(), 0)   # (t_ns, count), atomic swap
        argv = [path, str(gpio_a), str(gpio_b), "1" if invert else "0"]
        self.proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=None, text=True, bufsize=1)
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            try:
                t_s, c_s = line.split()
                t, c = int(t_s), int(c_s)
            except ValueError:
                continue
            self.sample = (t, c)
        rc = self.proc.wait()
        print("ERROR: tach_quad exited rc=%s -- exiting for systemd restart"
              % rc, file=sys.stderr, flush=True)
        os._exit(1)

    def cancel(self):
        self.proc.terminate()


# ---------------------------------------------------------------------------
# WT901 IMU reader
# ---------------------------------------------------------------------------
class WT901:
    def __init__(self, bus_num, addr):
        self.addr = addr
        self.bus = SMBus(bus_num)
        self.last = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0, "temp": 0.0}
        # When `last` was actually measured. On a failed read the loop reuses
        # `last`, and the wire timestamp must say so -- it stays at the last
        # SUCCESSFUL read, not the attempt.
        self.last_t_ns = time.monotonic_ns()

    def read(self):
        # 8 bytes = 4 x int16 LE: roll, pitch, yaw, temp
        raw = self.bus.read_i2c_block_data(self.addr, WT901_ROLL_REG, 8)
        self.last_t_ns = time.monotonic_ns()
        roll, pitch, yaw, temp = struct.unpack("<4h", bytes(raw))
        self.last = {
            "roll": roll / 32768.0 * 180.0,
            "pitch": pitch / 32768.0 * 180.0,
            "yaw": yaw / 32768.0 * 180.0,
            "temp": temp / 100.0,
        }
        return self.last


# ---------------------------------------------------------------------------
# TCP fan-out server
# ---------------------------------------------------------------------------
# Max per-client outbound backlog before we drop a slow/stuck client. This is
# fire-hose telemetry: if a client stops draining (e.g. a paused terminal), we
# must never let its full socket buffer block the broadcast loop for everyone
# (including TwinView). ~256 KiB is many seconds of backlog at 10 Hz.
MAX_CLIENT_BACKLOG = 262144


class _Client:
    __slots__ = ("sock", "addr", "buf")

    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.buf = bytearray()


class Broadcaster:
    def __init__(self, port):
        self.port = port
        self.clients = []
        self.lock = threading.Lock()
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("0.0.0.0", port))
        self.srv.listen(8)
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while True:
            try:
                conn, addr = self.srv.accept()
            except OSError:
                return
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.setblocking(False)          # never block the broadcast loop
            with self.lock:
                self.clients.append(_Client(conn, addr))
            print("client connected: %s" % (addr,), flush=True)

    def send(self, text):
        data = text.encode("ascii", "replace")
        dead = []
        with self.lock:
            for cl in self.clients:
                cl.buf += data
                try:
                    while cl.buf:
                        sent = cl.sock.send(cl.buf)
                        if sent <= 0:
                            break
                        del cl.buf[:sent]
                except BlockingIOError:
                    pass                     # kernel buffer full; keep backlog
                except OSError:
                    dead.append(cl)          # client gone
                    continue
                if len(cl.buf) > MAX_CLIENT_BACKLOG:
                    print("dropping slow client %s (backlog %d B)"
                          % (cl.addr, len(cl.buf)), flush=True)
                    dead.append(cl)
            for cl in dead:
                self.clients.remove(cl)
                try:
                    cl.sock.close()
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    quad = QuadratureProc(TACH_BIN, GPIO_A, GPIO_B, invert=INVERT_DIR)

    offsets = load_offsets(OFFSET_FILE)
    off_mtime = _mtime(OFFSET_FILE)
    print("incline offsets: %s" % offsets, flush=True)

    imu = None
    imu_err_logged = False
    try:
        imu = WT901(I2C_BUS, WT901_ADDR)
    except Exception as e:  # noqa: BLE001
        print("WARN: WT901 init failed: %s (will retry)" % e, file=sys.stderr)

    bcast = Broadcaster(TCP_PORT)
    print("rig-monitor streaming on tcp/%d at %.0f Hz (tach_quad backend)"
          % (TCP_PORT, RATE_HZ), flush=True)

    last_t_ns, last_count = quad.sample

    while True:
        loop_start = time.monotonic()

        # --- hot-reload incline offsets if the file changed ---
        m = _mtime(OFFSET_FILE)
        if m != off_mtime:
            offsets = load_offsets(OFFSET_FILE)
            off_mtime = m
            print("incline offsets reloaded: %s" % offsets, flush=True)

        # --- tach (count + timestamp sampled together by the C child) ---
        t_ns, count = quad.sample
        dt = (t_ns - last_t_ns) / 1e9
        dpulses = count - last_count
        tach_hz = (dpulses / dt) if dt > 0 else 0.0   # pulses/sec (x1 count)
        last_count = count
        last_t_ns = t_ns

        abs_hz = abs(tach_hz)
        mph = abs_hz / PULSES_PER_REV * WHEEL_CIRC_M * MS_TO_MPH
        dist = count / PULSES_PER_REV * WHEEL_CIRC_M
        direction = 1 if tach_hz > 0 else 0

        # --- incline ---
        inc = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0, "temp": 0.0}
        if imu is None:
            try:
                imu = WT901(I2C_BUS, WT901_ADDR)
            except Exception:  # noqa: BLE001
                imu = None
        if imu is not None:
            try:
                inc = imu.read()
                imu_err_logged = False
            except Exception as e:  # noqa: BLE001
                inc = imu.last
                if not imu_err_logged:
                    print("WARN: WT901 read failed: %s" % e, file=sys.stderr)
                    imu_err_logged = True

        # roll/yaw: simple tare from the offset file (not incline-critical)
        roll = inc["roll"] - offsets["roll"]
        yaw = inc["yaw"] - offsets["yaw"]
        # pitch: absolute, level-calibrated true incline angle (uphill positive)
        pitch = -(inc["pitch"] - PITCH_RAW_LEVEL)
        grade = math.tan(math.radians(pitch)) * 100.0

        # Source timestamps (see module docstring): tach lines carry the C
        # child's t_ns (frozen t_ns = child stalled, and the wire says so);
        # incline lines carry the last successful IMU read.
        imu_t_ns = imu.last_t_ns if imu is not None else time.monotonic_ns()
        lines = (
            "incline.roll: %.3f @%d\n" % (roll, imu_t_ns) +
            "incline.pitch: %.3f @%d\n" % (pitch, imu_t_ns) +
            "incline.grade: %.2f @%d\n" % (grade, imu_t_ns) +
            "incline.yaw: %.3f @%d\n" % (yaw, imu_t_ns) +
            "incline.temp: %.2f @%d\n" % (inc["temp"], imu_t_ns) +
            "tach.hz: %.3f @%d\n" % (tach_hz, t_ns) +
            "tach.dir: %d @%d\n" % (direction, t_ns) +
            "tach.count: %d @%d\n" % (count, t_ns) +
            "tach.mph: %.3f @%d\n" % (mph, t_ns) +
            "tach.dist: %.4f @%d\n" % (dist, t_ns)
        )
        bcast.send(lines)

        # pace to ~RATE_HZ
        elapsed = time.monotonic() - loop_start
        if elapsed < LOOP_DT:
            time.sleep(LOOP_DT - elapsed)


if __name__ == "__main__":
    main()
