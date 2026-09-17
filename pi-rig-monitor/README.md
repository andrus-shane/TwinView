# pi-rig-monitor

The Raspberry Pi Zero 2 W port of the `rig-monitor` sketch. Reads the WT901
inclinometer (I2C) and the open-collector quadrature tach (GPIO), and streams
the same one-channel-per-line protocol over a **TCP server on port 5000** for
TwinView's `net` telemetry source.

## Wire protocol

Newline-terminated `channel: value @<t_ns>` lines at ~10 Hz:

```
incline.grade: 0.71 @123456789012345
tach.mph: 11.130 @123456789012345
```

`@<t_ns>` is the **sample's own CLOCK_MONOTONIC time in nanoseconds**, taken
on the Pi when the value was measured: tach lines carry the C child's sample
timestamp (the same `t_ns` the hz/mph math differences), incline lines the
last successful WT901 read. TwinView strips the suffix before its channel
patterns run and uses it as the sample's measurement time, so interval and
derivative math (speed, RPM, coast-down fits) is immune to TCP/Wi-Fi arrival
jitter and read coalescing; the host's own arrival clock feeds only its
staleness watchdogs.

The clock's epoch is arbitrary (Pi boot) and it drifts ~20 ppm against the
host, so TwinView aligns it to its timeline with a sliding min-delay offset
fit per endpoint (`PiClockSync` in `server/src/sources/net.ts`) — no NTP
needed on the isolated bench Wi-Fi. (Running chrony on the Pi pointed at the
TwinView host would be the ops-side alternative.) Consumers that ignore the
suffix keep working as long as their value patterns aren't `$`-anchored.

## Wiring (this build)

| Signal            | Encoder/IMU wire | Pi phys pin | BCM     |
|-------------------|------------------|-------------|---------|
| Tach A            | (old Mega A0)     | 11          | GPIO17  |
| Tach B            | (old Mega A1)     | 13          | GPIO27  |
| Tach Vcc (Red)    | 5–24 V            | 4           | 5 V     |
| Tach GND (Black)  | 0 V              | 6           | GND     |
| WT901 SDA         |                  | 3           | GPIO2   |
| WT901 SCL         |                  | 5           | GPIO3   |
| WT901 Vcc         | 3.3 V            | 1           | 3.3 V   |
| WT901 GND         |                  | 9           | GND     |

- Tach A/B each need a **4.7 kΩ pull-up to 3.3 V** (open-collector). The program
  also enables the Pi's internal pull-ups as a backstop, but external resistors
  give cleaner edges.
- I2C needs enabling: `dtparam=i2c_arm=on` in `/boot/firmware/config.txt`.

## Deploy (done automatically on first boot via cloud-init)

The SD card's `user-data` copies `rig_monitor.py` → `/opt/rig-monitor/`,
installs the systemd unit, installs `pigpio python3-pigpio python3-smbus
i2c-tools`, enables `pigpiod`, and starts `rig-monitor.service`.

To update the code later on a running Pi:

```bash
scp rig_monitor.py testingdept@testingraspberryzero2.local:/tmp/
ssh testingdept@testingraspberryzero2.local \
  'sudo cp /tmp/rig_monitor.py /opt/rig-monitor/ && sudo systemctl restart rig-monitor'
```

## Verify on the Pi

```bash
i2cdetect -y 1                       # WT901 should appear at 0x50
systemctl status rig-monitor         # should be active (running)
journalctl -u rig-monitor -f         # watch for errors
nc localhost 5000                    # see the live channel lines
```

If `i2cdetect` is blank: I2C not enabled, WT901 in UART mode, or SDA/SCL swapped.
If the tach reads nonsense: check the two 4.7 kΩ pull-ups and common ground.
If distance counts backwards: set `INVERT_DIR = True` (or swap A/B).

## TwinView side

Point TwinView at this Pi with `network_sensors.json` (host
`testingraspberryzero2.local`, port 5000) and set `config.json` to
`"source": "mock"` + `"netConfigPath": "network_sensors.json"`.

## Network and remote access (as of 2026-09-16)

The Pi lives on the lab Wi-Fi **`OS Testing`** (TP-Link Omada, WPA2/WPA3 transition,
192.168.1.0/24, has internet + NTP) and keeps the lease **192.168.1.134**; the old
"isolated bench Wi-Fi" `ifit` is the same LAN and stays configured as a fallback. From
a laptop on `OS Testing`, `testingraspberryzero2.local` resolves (mDNS) and
`nc testingraspberryzero2.local 5000` shows the stream. Corporate `iconwireless`
cannot reach it.

The card runs Raspberry Pi OS (Debian 13 trixie) with **cloud-init + NetworkManager**,
not Ubuntu/netplan: `network-config` on the boot partition is rendered into
`netplan-wlan0-<ssid>` NM profiles once per `instance-id` (see DEPLOY.md step 3). The
2026-09-16 re-home added `"OS Testing"` (`auth: key-management: sae`) and bumped the id to
`rig-20260916-ostesting` in both `meta-data` and the `i=` token of `cmdline.txt`.

Health check from Windows (Git Bash + PuTTY plink; PuTTY prompts for unknown host keys
on the console, not stdin, so the script pins the key it fetches with `ssh-keyscan`):

```bash
PI_PASS=... bash pi-rig-monitor/check_pi.sh                 # by mDNS name
PI_PASS=... bash pi-rig-monitor/check_pi.sh 192.168.1.134   # by IP
PI_PASS=... bash pi-rig-monitor/check_pi.sh 192.168.1.134 --no-adb-bridge
```

`i2c-tools` is not installed on the Pi, so the `i2cdetect` row reads blank even though
the WT901 is streaming; trust the `incline.*` timestamps advancing instead.

**Bay move 2026-09-16:** the Pi moved from bay 1 (Android console, adb relay) to the
BLE-console treadmill bay `u03` (NTL17915). `adb-server.service` and
`adb-bridge.service` are **disabled** there (no USB console; re-enable with
`sudo systemctl enable --now adb-server adb-bridge`). TwinView's `network_sensors.json`
keys the Pi to `u03`. The WT901 mount differs on this unit: the deck reads about +2.6 %
grade at rest against bay 1's `PITCH_RAW_LEVEL`, so incline needs a fresh level
calibration on the NTL17915 before its readings mean anything.

## Console adb bridge (USB, no Wi-Fi)

The Pi doubles as an adb bridge to the machine console plugged into its data
USB port, replacing wireless debugging (whose connect port rotated on every
power cycle). `adb_bridge.sh` + the two `.service` units re-arm `adb tcpip
5555` over the cable after each console power cycle and publish the console's
adbd at `<pi>:5555` — a never-changing endpoint for TwinView's
`fleet.screens`.

One-time install (flips the USB port from the old gadget/tachometer mode to
host mode — see the backups it leaves in `/boot/firmware`):

```bash
scp adb_bridge.sh adb-server.service adb-bridge.service setup_adb_bridge.sh \
  testingdept@testingraspberryzero2.local:/tmp/pi-adb-bridge/
ssh -t testingdept@testingraspberryzero2.local \
  "sed -i 's/\r$//' /tmp/pi-adb-bridge/* && cd /tmp/pi-adb-bridge && sudo bash setup_adb_bridge.sh && sudo reboot"
```

After reboot, tap **Allow USB debugging → Always allow** once on the console.
From a host that can reach the Pi: `adb connect <pi>:5555`. (From the wired
TwinView box, relay through a bridge tablet first — recipe in team notes.)
