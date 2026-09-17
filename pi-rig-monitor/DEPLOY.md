# Deploying rig-monitor to the Pi SD card (from a writable machine)

The original dev machine had a corporate **BitLocker "deny write to removable
drives"** policy, so the SD card mounted read-only ("media is write protected")
and these changes couldn't be applied there. Do them from a machine that can
write the card's **boot partition** (FAT32; shows up as a drive letter on
Windows, mounts at `/boot/firmware` on the Pi).

> **No secrets are in git.** The card's existing `user-data` already contains the
> user + password hash, and `network-config` the Wi-Fi credentials. Leave those
> in place — only MERGE the additions in step 4. Nothing here needs the secrets.

> If the new machine *also* refuses to write the card, it has the same
> removable-drive policy — use a personal machine or one without that group policy.


> **Verified 2026-09-16 on this card:** the OS is Raspberry Pi OS / Debian 13 trixie with
> cloud-init + NetworkManager (not Ubuntu/netplan). Editing `network-config` + bumping the
> instance id from a Windows laptop worked first time; `D:` was writable on the newer
> laptop, so the BitLocker note above only applies to the original machine.

## 1. Copy the program onto the boot partition
Copy both files (from this folder) to the **root of the boot partition** so they
land at `/boot/firmware/` on the Pi:
- `rig_monitor.py`
- `rig-monitor.service`

## 2. Enable I2C — `config.txt`
Uncomment (or add) this line so the WT901 bus comes up:
```
dtparam=i2c_arm=on
```

## 3. Force a re-provision — `meta-data`
cloud-init only applies `user-data` AND `network-config` once per instance id. Bump it here and in the `i=` token of `cmdline.txt` (`ds=nocloud;i=...`) so the two agree; a new id also regenerates the Pi's ssh host keys (re-pin in check_pi.sh/plink):
```
instance-id: rig-20260728-01
```

## 4. Merge into `user-data` (keep everything already there)
```yaml
package_update: true
packages:
- avahi-daemon          # already present — keep it, just add the four below
- pigpio
- python3-pigpio
- python3-smbus
- i2c-tools

write_files:
- path: /etc/modules-load.d/rig-i2c.conf
  content: |
    i2c-dev

runcmd:
- [ mkdir, -p, /opt/rig-monitor ]
- [ cp, /boot/firmware/rig_monitor.py, /opt/rig-monitor/rig_monitor.py ]
- [ cp, /boot/firmware/rig-monitor.service, /etc/systemd/system/rig-monitor.service ]
- [ sh, -c, "sed -i 's/\\r$//' /opt/rig-monitor/rig_monitor.py /etc/systemd/system/rig-monitor.service" ]
- [ chmod, +x, /opt/rig-monitor/rig_monitor.py ]
- [ modprobe, i2c-dev ]
- [ systemctl, daemon-reload ]
- [ systemctl, enable, --now, pigpiod ]
- [ systemctl, enable, --now, rig-monitor.service ]
```

## 5. Eject and boot
First boot installs packages over Wi-Fi (SSIDs `OS Testing` and `ifit` since 2026-09-16) and starts the service —
allow a few minutes. Then verify per `README.md`:
```bash
i2cdetect -y 1                 # WT901 at 0x50
systemctl status rig-monitor   # active (running)
nc <pi-ip-or-.local> 5000      # live incline.* / tach.* lines
```

## 6. Point TwinView at the Pi
On the TwinView host, edit `config.json`:
```json
{ "source": "mock", "netConfigPath": "network_sensors.json", "port": 8720 }
```
`network_sensors.json` (repo root) already targets `testingraspberryzero2.local:5000`.

## Still to do on the hardware
- Two **4.7 kΩ pull-ups** on the encoder A/B lines (GPIO17 pin 11, GPIO27 pin 13)
  to **3.3 V**. The program enables the Pi's weak internal pull-ups as a backstop,
  but externals give clean counts.
- Confirm the WT901 is in **I2C mode** (not UART) — otherwise `i2cdetect` is blank.
