#!/usr/bin/env python3
"""
Pi port of the Arduino rig-monitor sketch.

Streams the WT901 inclinometer (I2C @ 0x50) and the open-collector quadrature
tach as newline-delimited channel lines over a TCP server, for TwinView's
`net` telemetry source to dial into:

    incline.roll/pitch/yaw/temp   WT901 regs 0x3D..0x40 (int16 LE), same scaling
    tach.hz/dir/count/mph/dist    quadrature decode (x4), same math + constants
                                  as the sketch (PULSES_PER_REV=600, wheel 0.50 m)

Edges are captured by pigpio (hardware-timed sampling in the pigpiod daemon), so
counting is robust to Linux scheduler jitter. The quadrature table and the x4
decode are carried over verbatim from the sketch, so the existing calibration
holds.

Wiring on this build (physical pin -> BCM):
    encoder A line -> pin 11 -> GPIO17   (old Mega A0 line; Green wire)
    encoder B line -> pin 13 -> GPIO27   (old Mega A1 line; White wire)
    WT901 SDA/SCL  -> pins 3/5 -> GPIO2/3 (I2C bus 1), powered from 3.3 V
Which color is A vs B only sets the direction sign — flip INVERT_DIR if belt
distance/speed counts backwards.
"""

import socket
import struct
import threading
import time

import pigpio
from smbus import SMBus

# --- I2C / WT901 ---
I2C_BUS = 1
WT901_ADDR = 0x50
REG_ROLL = 0x3D            # 0x3D..0x40: roll/pitch/yaw/temp, int16 little-endian

# --- tach (quadrature) ---
PIN_A = 17                 # bit 0 — old Mega A0 line (phys pin 11)
PIN_B = 27                 # bit 1 — old Mega A1 line (phys pin 13)
INVERT_DIR = False         # set True if distance/speed counts the wrong way

PULSES_PER_REV = 600.0     # Taiss E38S6-600-24G
WHEEL_CIRC_M = 0.50        # NOTE: 0.238 m for the 2.98 in wheel variant
MPS_TO_MPH = 2.23694

# --- server / cadence ---
TCP_PORT = 5000
REPORT_HZ = 10

# index = (oldAB << 2) | newAB, A = bit0, B = bit1  (same table as the sketch)
QTAB = (0, +1, -1, 0,
        -1, 0, 0, +1,
        +1, 0, 0, -1,
        0, -1, +1, 0)


class Tach:
    """Quadrature decoder driven by pigpio edge callbacks."""

    def __init__(self, pi, pin_a, pin_b):
        self.pi = pi
        self.pin_a = pin_a
        self.pin_b = pin_b
        self.count = 0
        self.lock = threading.Lock()
        for p in (pin_a, pin_b):
            pi.set_mode(p, pigpio.INPUT)
            pi.set_pull_up_down(p, pigpio.PUD_UP)  # backstop; external 4.7k to 3.3V preferred
        self.a = pi.read(pin_a) & 1
        self.b = pi.read(pin_b) & 1
        self.last = self.a | (self.b << 1)
        self._cb_a = pi.callback(pin_a, pigpio.EITHER_EDGE, self._edge)
        self._cb_b = pi.callback(pin_b, pigpio.EITHER_EDGE, self._edge)

    def _edge(self, gpio, level, tick):
        if level > 1:  # 2 = watchdog timeout, not a real edge
            return
        if gpio == self.pin_a:
            self.a = level
        else:
            self.b = level
        now = self.a | (self.b << 1)
        with self.lock:
            self.count += QTAB[(self.last << 2) | now]
            self.last = now

    def read(self):
        with self.lock:
            return self.count


def read_wt901(bus):
    """Return (roll, pitch, yaw, tempC) in deg/deg/deg/C, or None on I2C error."""
    try:
        data = bus.read_i2c_block_data(WT901_ADDR, REG_ROLL, 8)
    except OSError:
        return None
    r, p, y, t = struct.unpack("<hhhh", bytes(data))
    return (
        r / 32768.0 * 180.0,
        p / 32768.0 * 180.0,
        y / 32768.0 * 180.0,
        t / 100.0,
    )


class Broadcaster:
    """Accept TCP clients and fan every line out to all of them."""

    def __init__(self, port):
        self.clients = set()
        self.lock = threading.Lock()
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("0.0.0.0", port))
        self.srv.listen(5)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                break
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with self.lock:
                self.clients.add(conn)

    def send(self, text):
        data = text.encode("ascii", "replace")
        with self.lock:
            dead = []
            for c in self.clients:
                try:
                    c.sendall(data)
                except OSError:
                    dead.append(c)
            for c in dead:
                self.clients.discard(c)
                try:
                    c.close()
                except OSError:
                    pass


def main():
    pi = pigpio.pi()
    if not pi.connected:
        raise SystemExit("pigpio daemon not running (systemctl enable --now pigpiod)")
    bus = SMBus(I2C_BUS)
    tach = Tach(pi, PIN_A, PIN_B)
    bcast = Broadcaster(TCP_PORT)

    period = 1.0 / REPORT_HZ
    last_count = 0
    last_t = time.monotonic()

    while True:
        time.sleep(period)
        now = time.monotonic()
        dt = now - last_t
        last_t = now

        count = tach.read()
        if INVERT_DIR:
            count = -count
        d_steps = count - last_count
        last_count = count

        tach_hz = (d_steps / dt / 4.0) if dt > 0 else 0.0
        abs_hz = abs(tach_hz)
        mph = abs_hz / PULSES_PER_REV * WHEEL_CIRC_M * MPS_TO_MPH
        dist = count / (4.0 * PULSES_PER_REV) * WHEEL_CIRC_M
        direction = 1 if d_steps > 0 else (-1 if d_steps < 0 else 0)

        lines = []
        imu = read_wt901(bus)
        if imu is not None:
            roll, pitch, yaw, temp = imu
            lines.append(f"incline.roll: {roll:.2f}")
            lines.append(f"incline.pitch: {pitch:.2f}")
            lines.append(f"incline.yaw: {yaw:.2f}")
            lines.append(f"incline.temp: {temp:.2f}")
        lines.append(f"tach.hz: {abs_hz:.1f}")
        lines.append(f"tach.dir: {direction}")
        lines.append(f"tach.count: {count}")
        lines.append(f"tach.mph: {mph:.2f}")
        lines.append(f"tach.dist: {dist:.2f}")
        bcast.send("".join(line + "\n" for line in lines))


if __name__ == "__main__":
    main()
