# pi-rig-monitor

The Raspberry Pi Zero 2 W port of the `rig-monitor` sketch. Reads the WT901
inclinometer (I2C) and the open-collector quadrature tach (GPIO), and streams
the same one-channel-per-line protocol over a **TCP server on port 5000** for
TwinView's `net` telemetry source.

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
