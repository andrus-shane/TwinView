#!/bin/bash
# adb_bridge: expose the USB-attached console's adbd on a fixed TCP port.
#
# The console's wireless-debugging port rotates on every power cycle, which
# kept breaking TwinView's Test Control serial. This loop removes Wi-Fi from
# the path entirely: whenever the console shows up on USB (fresh boot or
# power cycle), switch its adbd into TCP mode (`adb tcpip 5555`), forward
# Pi->console over the USB cable, and publish the forward on 0.0.0.0:5555
# via socat. The TwinView host then reaches it as a never-changing endpoint.
#
# Runs as root under adb-bridge.service alongside adb-server.service.
# First contact from a fresh adb key needs one "Allow USB debugging"
# (Always allow) tap on the console screen.

PORT=5555   # published on all Pi interfaces; also the tcpip port on the console
LOCAL=6555  # Pi-local end of the adb forward (loopback only)

usb_serial() {
  adb devices | awk 'NR>1 && $2=="device" && $1 !~ /:/ {print $1; exit}'
}

armed=""
while true; do
  usb=$(usb_serial)
  if [ -z "$usb" ]; then
    unauth=$(adb devices | awk 'NR>1 && $2=="unauthorized" {print $1; exit}')
    [ -n "$unauth" ] && echo "waiting for 'Allow USB debugging' tap on $unauth"
    armed=""
    sleep 3
    continue
  fi
  # adbd can restart again later in boot (~after our first arm), silently
  # dropping the forward while the USB transport blips back inside one
  # sleep interval — so "armed" alone can't be trusted. Verify the forward
  # actually exists every iteration and re-arm through the normal path.
  if [ "$armed" = "$usb" ] && ! adb forward --list | grep -q "tcp:$LOCAL"; then
    echo "forward tcp:$LOCAL missing (adbd restarted?) — re-arming $usb"
    armed=""
  fi
  if [ "$armed" != "$usb" ]; then
    echo "console $usb on USB — arming tcp adbd on :$PORT"
    adb -s "$usb" tcpip "$PORT"
    # adbd restarts for the mode switch; wait for the USB transport to return
    for _ in $(seq 1 10); do
      sleep 1
      [ -n "$(usb_serial)" ] && break
    done
    if [ -z "$(usb_serial)" ]; then
      echo "USB transport did not come back after tcpip — retrying"
      sleep 3
      continue
    fi
    adb -s "$usb" forward "tcp:$LOCAL" "tcp:$PORT"
    pkill -f "socat TCP-LISTEN:$PORT" 2>/dev/null
    socat "TCP-LISTEN:$PORT,fork,reuseaddr" "TCP:127.0.0.1:$LOCAL" &
    armed="$usb"
    echo "bridge up: 0.0.0.0:$PORT -> usb -> $usb"
  fi
  sleep 5
done
