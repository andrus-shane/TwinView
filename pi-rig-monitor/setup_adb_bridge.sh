#!/bin/bash
# One-time root setup for the console adb bridge. Run on the Pi:
#   sudo bash setup_adb_bridge.sh
# then reboot to apply USB host mode.
#
# Flips the Pi's data USB port from gadget (dr_mode=peripheral, g_serial —
# the dormant tachometer-streaming experiment) to host mode so the Pi can
# drive adb against the console plugged into it. To ever restore the gadget
# port, revert from the .bak-adbbridge copies and re-enable tachometer.service.
set -euo pipefail
cd "$(dirname "$0")"

echo "== backing up boot config"
cp -n /boot/firmware/config.txt /boot/firmware/config.txt.bak-adbbridge
cp -n /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak-adbbridge

echo "== switching dwc2 to host mode"
sed -i 's/^dtoverlay=dwc2,dr_mode=peripheral/dtoverlay=dwc2,dr_mode=host/' /boot/firmware/config.txt
sed -i 's/modules-load=dwc2,g_serial/modules-load=dwc2/' /boot/firmware/cmdline.txt
grep -q 'dr_mode=host' /boot/firmware/config.txt || { echo "config.txt edit failed"; exit 1; }

echo "== installing adb + socat"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq adb socat

echo "== installing bridge services"
install -m 0755 adb_bridge.sh /usr/local/sbin/adb_bridge.sh
install -m 0644 adb-server.service adb-bridge.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable adb-server.service adb-bridge.service

echo "== done. Now run:  sudo reboot"
