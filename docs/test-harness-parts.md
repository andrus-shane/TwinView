# Pi 5 system-test harness — parts & purchasing list

Instrumentation build-out for the treadmill system-test harness sketched 2026-08-18
(Pi hub + power metering + thermocouples + bus taps + safety-key actuation).
All prices and stock live-verified 2026-08-18/19 by adversarial multi-source research;
prices are volatile in the current DRAM-shortage environment — re-check at checkout.

Already owned: see [§0](#0-already-on-the-bench) — the existing rig this expansion builds on.

**Revised 2026-08-20** after the design review in [test-harness-review.md](test-harness-review.md)
(council of 4 independent reviewers + synthesis). Architecture rules that came out of it:

1. **One board on the 40-pin header: the CAN FD HAT.** The 3-HAT stack (M.2 + thermocouple
   + CAN FD) is not physically or thermally viable — the CAN HAT has no pass-through, the
   M.2 header terminates flush, and a mid-stack thermocouple board bakes its cold-junction
   reference above the Pi.
2. **Sequent thermocouple board runs off-board** on a 15-25 cm I2C pigtail (SDA/SCL/GND +
   its own 5V input), in open air. Fixes stacking, CJC heating, and terminal access at once.
   Set its DIP to disable the onboard RS485 (it rides the Pi UART on GPIO14/15).
3. **Skip the M.2 HAT+ — boot from a USB 3 SSD.** ~350 MB/s is plenty for logging, and
   continuous CAN logging kills microSD cards.
4. **CAN FD HAT config: `dtoverlay=spi1-1cs`, NOT the wiki's `spi1-3cs`** — the 3-CS
   variant pinmuxes GPIO17 away, which is the belt encoder's channel A (tach dies or
   `can1` never probes). Verify with `raspi-gpio get 16 17 18` after boot.
5. **One ground bond point, at console/logic ground** (the ADB USB cable already creates
   it). Every other measurement path stays isolated. Write the grounding map down before
   the first shunt goes in.
6. **Second I2C bus** (`dtoverlay=i2c3` on GPIO4/5, 400 kHz) for the Qwiic power-monitor
   chain; Sequent stays on i2c-1 at 100 kHz. A hung sensor then takes out one group, not
   the harness.

Bring-up order, grounding analysis, and per-sensor gotchas: see the review doc.

---

## 0. Already on the bench

The working rig this expansion builds on — nothing here needs purchasing.

| Item | Role today | Migration notes |
|---|---|---|
| **Raspberry Pi Zero 2 W** — 192.168.1.134 (`testingraspberryzero2.local`) on the isolated bench Wi-Fi | Runs `rig-monitor.service`: streams `incline.*` + `tach.*` over TCP:5000 at 10 Hz to TwinView's net source | Interrupt-limited (the reason for the Pi 5: x4 tach decode saturated at ~11 mph, forcing x1). After migration it stays useful as a spare node or a dedicated tach+incline satellite |
| **Taiss E38S6-600-24G quadrature encoder** — 600 PPR, channels A/B on GPIO17/27, 5V | Belt speed via the `tach_quad` C child (x1 decode, rising edges of A). Calibrated `WHEEL_CIRC_M = 0.2388` — reads 14.038 vs 14.035 mph true (run ce13785c) | Migrates to the Pi 5. **Pin-map caution**: channel A on GPIO17 is why the CAN FD HAT must use `spi1-1cs` (rule 4). Re-run the speed sweep against the console after any rewire |
| **WitMotion WT901 IMU** — I2C bus 1, addr 0x50 | Incline as a gravity inclinometer: level-calibrated pitch (`PITCH_RAW_LEVEL`, bubble-level ground truth 2026-07-28) → % grade; offsets hot-reload from `rig-monitor-offsets.conf` | Migrates. Keep it on **i2c-1** — 0x50 on i2c-0 collides with HAT ID EEPROMs. Recalibrate after remounting |
| **Console tablet (SZ00000141) + adb bridge** | adb rides USB through the Pi (permanent serial `127.0.0.1:5555`); `adb-bridge.service` / `adb-server.service`; nc relay reaches the bench subnet from the wired box | The bridge concept carries over, but `setup_adb_bridge.sh` is a Zero 2 W dwc2 idiom — needs a rewrite for the Pi 5's host-native USB (review §5.6). The USB link also defines the harness's one ground bond point (rule 5) |
| **Arduino Mega 2560 rig** — COM11, iFIT_TestingSuite.v25, 115200 baud | The predecessor rig (WT901 + HX711 load cell); the Pi firmware's calibration constants mirror it | Stays as-is for suite work. The **HX711 + load cell** is unused capacity — a candidate belt-tension/user-weight channel for a later phase |
| **NTL99925 treadmill + TwinView stack** | The DUT, plus the digital twin consuming `incline.grade` / `tach.mph` per `network_sensors.json` (server :8720, web :5173) | New harness channels (power, temps, bus frames) will need net-source pattern entries and twin channel definitions — separate software task |

## 1. Compute — Raspberry Pi 5 (8GB)

| Item | Price | Link |
|---|---|---|
| **Primary: CanaKit Starter Kit, 128GB / Turbine Black** — Pi 5 8GB + USB-C PD PSU + PWM fan/heatsink + 128GB microSD + card reader + 2× micro-HDMI cables | $269.95 | [canakit.com](https://www.canakit.com/raspberry-pi-5-8gb.html) |
| Alternate: board only (then source PSU/cooler separately) | $175.00 | [CanaKit](https://www.canakit.com/raspberry-pi-5-8gb.html) or [PiShop.us](https://www.pishop.us/product/raspberry-pi-5-8gb/) |
| ~~Official Raspberry Pi SSD Kit (M.2 HAT+)~~ **dropped in review** — boot from a USB 3 SSD instead (any name-brand 256GB+) | ~$35 est. | see [review §1.2](test-harness-review.md) |

Notes:
- Both CanaKit and PiShop.us are confirmed authorized US resellers (raspberrypi.com/resellers) — low counterfeit risk.
- $175 board-only is ~2.2× launch MSRP after successive 2026 DRAM-shortage price hikes; nobody verified beats it.
- Kit PSU/cooler are CanaKit-branded, not the official RPi 27W PSU / Active Cooler — fine for bench use. Verify the brick negotiates 5.1V/5A (`vcgencmd pmic_read_adc`) — the Pi 5 caps USB at 600mA otherwise, and this harness hangs 3+ USB devices off it.
- The M.2 HAT+ was dropped because it can't stack under the CAN FD HAT and the official spec doesn't support boards above it; USB 3 SSD gives the same logging benefit with zero header conflict.
- Add the Pi 5 RTC battery (~$5) — the bench network is isolated, no NTP on boot.

## 2. Thermocouples ×8 (K-type)

| Item | Price | Link |
|---|---|---|
| **Primary: Sequent Microsystems Eight Thermocouples DAQ HAT (SM-I-019)** — 8 ch on one board, J/K/T/N/E/B/R/S, 24-bit ΔΣ ADC, CJC, up to 40 SPS, Pi Zero→5 | $120.00 | [sequentmicrosystems.com](https://sequentmicrosystems.com/products/eight-thermocouples-daq-8-layer-stackable-hat-for-raspberry-pi) · [Amazon (sold by manufacturer)](https://www.amazon.com/Eight-Thermocouples-8-Layer-Stackable-Raspberry/dp/B0CHPNS67Q) |
| Alternate: 2× MCC 134 DAQ HAT (4 ch each, stacked via A0-A2 jumpers) | 2 × $149 = $298 | [digilent.com](https://digilent.com/shop/mcc-134-thermocouple-measurement-daq-hat-for-raspberry-pi/) |
| DIY: 8× Adafruit MAX31856 breakout (SPI, one CS line each) | 8 × $17.50 = $140 | [adafruit.com/product/3263](https://www.adafruit.com/product/3263) |

Notes:
- Sequent wins: single board, I2C-only (GPIO2/3 — leaves SPI + GPIO free for everything else), Pi 5 explicitly supported, [userspace driver on GitHub](https://github.com/SequentMicrosystems/smtc-rpi).
- **Mount it off-board** on a short I2C pigtail with its own 5V (review rule 2) — never mid-stack. Set the DIP switches to disable its onboard RS485 or it fights the Pi UART (GPIO14/15). Never back-feed the Pi 5V header from its connector while USB-C PD is also connected.
- **The DAQ ships with zero thermocouples.** Order 8× ungrounded-junction K-type surface probes (~$10-18 ea), K-type extension wire (yellow +, red − — reversed polarity reads inverted), and Kapton/thermal-adhesive mounting. Keep one channel on ambient and report rise-above-ambient (cancels most offset error). Bare-wire field terminals, not mini-TC jacks.
- Sequent accuracy figures are % of electrical full scale (vendor-claimed), not °C; K-type wire tolerance dominates anyway. For ~5°C comparative deltas, consider T/E-type probes (~2× sensitivity below 150°C).
- Availability flag: The Pi Hut (UK) lists it discontinued while the manufacturer stocks it — order sooner rather than later. One verifier saw $95 vs $120 on the Sequent site; confirm at checkout.
- MCC 134 is 1 sample/sec minimum interval and MCC advises mounting it far from the Pi's heat — stacking two compromises one board's CJC.

## 3. DC rail V/A — tablet, console, controller (<10A each)

| Item | Price | Link |
|---|---|---|
| **Primary: 3× Adafruit INA228 breakout** — 20-bit, 85V bus max, 10A via onboard 15mΩ 0.1% shunt, I2C/STEMMA QT chainable | 3 × $14.95 ≈ $45 | [adafruit.com/product/5832](https://www.adafruit.com/product/5832) |

Notes:
- Kernel support is the `ina238` hwmon driver (not `ina2xx` — that covers older INAs), and Raspberry Pi OS ships no stock overlay for it; realistically plan on the Adafruit Python library or a small register reader. hwmon also doesn't expose the INA228's energy/charge accumulators.
- **All three ship at address 0x40** — set A0/A1 jumpers apart *before* first power-up, and bring boards up one at a time (`i2cdetect` can't see two devices on the same address).
- Sustained ~10A dissipates ~1.5W in the small onboard shunt (runs warm near top of range).
- If any rail exceeds 10A, use the >10A option in §7.
- Shares the I2C bus with the Sequent HAT and WT901 — check address map before wiring (INA228 is address-configurable).

## 4. AC mains power metering (120V / 15-20A, logged into Pi)

*Primary/alternate swapped in the 2026-08-20 review: a hand-built PZEM mains box means clamping one
conductor of a split cord (a CT around the whole 2-conductor cord reads ≈ zero — hot and neutral
cancel), tapping L/N for voltage sense, an enclosure, fusing, and EHS review. Buy the listed
device instead.*

| Item | Price | Link |
|---|---|---|
| **Primary: Shelly Pro EM-50** — DIN-rail, 2× 50A split-core CTs (mains + a motor leg), 100-260V, ±1% (5-50A), isolated by architecture, polled over HTTP/MQTT on the bench subnet | $119.99 | [us.shelly.com](https://us.shelly.com/products/shelly-pro-em-50) (Home Depot had it at $94.99 promo) |
| Optional redundant channel: PZEM-004T v3, 100A split-core CT bundle — 80-260VAC self-powered, 0.5%, Modbus-RTU over TTL serial | $25.99 | [Amazon B0F3J2CM2J](https://www.amazon.com/Peacefair-PZEM-004T-Monitoring-Housing-Software/dp/B0F3J2CM2J) |

Notes:
- Both meters are ~1 Hz steady-state instruments. If motor inrush matters, that's a scope/clamp measurement or a fast CT channel into an ADC — a 1 Hz meter and an inrush question are incompatible.
- PZEM 120V operation is confirmed (80-260VAC spec vs the Peacefair V3.0 datasheet). **If using it**: its mains-to-TTL isolation is unverified either way — treat the TTL pins as mains-referenced and connect through an **isolated USB-TTL adapter that supplies isolated 5V out (the PZEM's opto side needs external 5V), or an ADuM1201 + B0505S stage**, never straight into Pi GPIO.
- The verified PZEM Amazon listing is fragile (1 unit left, zero-review drop-ship seller); the bundle reappears under rotating ASINs — match the "AC 80-260V, 100A" spec line. Bare modules run $16.65-21.61.
- **Do not buy the standard Eastron SDM120M**: nameplate 230V, operating range 176-276VAC — it cannot meter a US 120V circuit. No true Modbus-RTU DIN alternative for 120V survived verification.

## 5. CAN FD tap

| Item | Price | Link |
|---|---|---|
| **Primary: Waveshare 2-CH CAN FD HAT (SKU 17075)** — dual MCP2518FD on SPI, mainline `spi-mcp251xfd` socketcan driver | $46.99 | [waveshare.com](https://www.waveshare.com/2-ch-can-fd-hat.htm) · [wiki](https://www.waveshare.com/wiki/2-CH_CAN_FD_HAT) |
| Alternate (works-out-of-box, pro-grade): PEAK PCAN-USB FD (IPEH-004022) — mainline `peak_usb`, enabled in Pi 5 kernel config | $368.00 | [gridconnect.com](https://www.gridconnect.com/products/can-usb-fd-adapter-pcan-usb-fd) |
| Not recommended: CANable 2.0 — sold out manufacturer-direct; stock firmware is slcan with CAN FD still beta; candleLight/gs_usb has no FD on its STM32G431 | ($35) | [openlightlabs.com](https://openlightlabs.com/products/canable-2-0) |

Notes:
- **Config (corrected in review — do NOT use the wiki's `spi1-3cs`):**
  ```
  dtparam=spi=on
  dtoverlay=spi1-1cs
  dtoverlay=mcp251xfd,spi0-0,interrupt=25
  dtoverlay=mcp251xfd,spi1-0,interrupt=24
  ```
  The wiki's `spi1-3cs` pinmuxes GPIO16/17/18 — and GPIO17 is the belt encoder's channel A, so the tach fails its line request (systemd restart-loop) or `can1` silently never probes. The HAT only uses CE0/GPIO18; `spi1-1cs` leaves 16/17 free. Verify with `raspi-gpio get 16 17 18` after boot. No vendor driver.
- **Bring up listen-only, termination off**: `ip link set can0 up type can bitrate ... listen-only on`. A "passive" CAN tap that ACKs frames or emits error frames on a sample-point mismatch is an active bus disruptor. Check the HAT's onboard 120Ω termination is disabled before touching the machine bus.
- Pi 5 caveat: vendor docs stop at Pi 4B. Community reports (raspberrypi/linux [#6407](https://github.com/raspberrypi/linux/issues/6407), [#6644](https://github.com/raspberrypi/linux/issues/6644)) prove it runs on Pi 5 but document delayed-RX and SPI-overflow quirks under heavy periodic traffic. If the treadmill bus turns out chatty and the quirks bite, the PCAN-USB FD is the escape hatch.
- Two channels = can tap two CAN buses (or TX-inject on one while listening on the other).

## 6. RS485 tap (passive sniff of 2-wire bus)

| Item | Price | Link |
|---|---|---|
| **Primary: DSD TECH SH-U11F isolated USB-RS485** — true galvanic isolation (ADuM3201 + Mornsun B0505LS DC-DC), genuine FTDI, stock `ftdi_sio` | $19.99 | [Amazon](https://www.amazon.com/DSD-TECH-SH-U11F-Industrial-Application/dp/B083XSG1RG) |
| Alternate: Waveshare USB TO RS485/422 (SKU 23949) — FT232RNL, isolated, 120Ω termination jumpered OFF by default, 300bps-3Mbps | $17.99 | [waveshare.com](https://www.waveshare.com/usb-to-rs485-422.htm) |
| Alternate: Waveshare USB TO RS232/485 (B) (SKU 26547) — FT232RNL, isolated, 600W surge / 15kV ESD | $15.99 | [waveshare.com](https://www.waveshare.com/usb-to-rs232-485-b.htm) |

Notes:
- All three verified true power+signal isolation (teardown-corroborated), hardware-automatic direction control — the transmitter stays off unless the host writes, so a listen-only sniffer stays passive.
- Leave the 120Ω termination jumper OFF when tapping an existing (already-terminated) bus.

## 7. Above-10A DC sensing (motor-controller rail fallback, up to ±30A)

| Item | Price | Link |
|---|---|---|
| **Primary: SparkFun Power Meter ACS37800 (Qwiic, SEN-29259)** — hall-effect ±30A, isolated current path, I2C addr 0x60 | $19.95 | [sparkfun.com](https://www.sparkfun.com/sparkfun-power-meter-acs37800-qwiic.html) |
| Alternate (better isolation): Pololu ACS37800 carrier #5410 — adds onboard isolated DC-DC + I2C isolator (true secondary isolation, 4800VRMS reinforced) | $34.95 | [pololu.com/product/5410](https://www.pololu.com/product/5410) — **backorder-only as of Aug 2026** |

Notes:
- Same Allegro ±30A IC on both; default address 0x60 doesn't collide with the INA228s (0x40-0x4F) — everything coexists on one Pi I2C bus. Qwiic/STEMMA QT chains with the Adafruit boards (Pi needs a Qwiic-to-GPIO adapter or jumper wires).
- SparkFun board was NOT verified to have the Pololu-style secondary I2C isolation — if the motor-controller rail is electrically nasty, prefer the Pololu when it restocks.
- **Hard cap ±30A.** Nothing above 30A survived verification (ACS758 50A breakouts, external-shunt INA228/238 setups) — measure or spec the actual rail current first; if it exceeds 30A this category needs another pass.

## 8. Safety-key relay (12V low-current loop, Pi GPIO-driven)

| Item | Price | Link |
|---|---|---|
| **Primary: ProtoSupplies 8-ch 5V relay module w/ opto-isolation (JD-VCC header)** — true galvanic isolation *only when wired per the notes below* | $7.95 | [protosupplies.com](https://protosupplies.com/product/relay-module-5v-x-8-relay-w-opto-isolation/) |
| Alternate (simplest, non-isolated): Adafruit STEMMA non-latching mini relay #4409 — transistor-buffered, contacts 2A @ 30VDC | $6.95 | [adafruit.com/product/4409](https://www.adafruit.com/product/4409) |
| **Rejected**: Waveshare RPi Relay Board HAT ($15.99) — its PC817s are interference suppression, not isolation: relay coils are fed from the Pi's own rails, and the "Relay_JMP" jumper only selects GPIO pins | — | [waveshare.com](https://www.waveshare.com/rpi-relay-board.htm) |

Wiring the ProtoSupplies module for actual isolation (it ships with isolation **bypassed**):
1. Remove the JD-VCC↔VCC jumper (as shipped it ties coil power to logic power, defeating the optos — vendor admits this on the product page).
2. Power JD-VCC/GND from a separate 5V supply (not the Pi's 5V).
3. Connect only VCC (Pi 3.3V/5V) and INx to the Pi — **do NOT connect the Pi's ground to the board GND**; the board has a single ground net and sharing it silently defeats the isolation. Inputs are active-low.

Review caveats on this recipe (see [review §3](test-harness-review.md)):
- **Continuity-test the actual board's ground topology before trusting it** — two reviewers independently argued the single ground net may make the recipe contradictory as written on some board revisions.
- **Check drive levels**: 3.3V GPIO against a 5V VCC leaves ~1.7V across the opto LED — enough on some modules to half-drive the relay. If marginal, drive the INx pins through an MCP23017 I2C expander (0x20, ~$9), which also frees GPIO for 12V key-state *sensing* (the plan needs both actuate AND sense, and the free-GPIO budget only covers one).
- **Bench-test fail-safe with the treadmill unplugged**: power loss, Pi reboot, and script kill must all land in "key out". Check boot-state glitch behavior (one reviewer claimed internal pull-downs can energize active-low inputs at boot; another disputed it — 5 minutes on the bench settles it).
- For the 12V key loop the #4409's 2A/30VDC contacts are ample headroom; use it if GPIO-side isolation doesn't matter (the key loop is low-energy). 8 channels on the ProtoSupplies board = room for key 1 + key 2 + future fault-injection lines.
- **A hardware E-stop independent of the Pi/GPIO/relay chain (physical mushroom button in the motor kill circuit or a mains disconnect) is required before any automated fault injection.** The TwinView software watchdog can't help if the Pi hangs or the coil supply dies mid-run.

## 9. Bench essentials the silicon total hides (est. prices, not research-verified)

| Item | Est. | Why |
|---|---|---|
| 8× K-type ungrounded surface probes + extension wire + Kapton/thermal adhesive | ~$130 | the DAQ ships with zero probes; mounting error dominates TC accuracy |
| Powered USB 3 hub, per-port switchable (`uhubctl`-capable) | ~$35 | Pi 5 USB budget is 600mA-1.6A total; per-port power switching doubles as a tablet-USB fault-injection actuator |
| Battery-powered handheld oscilloscope | ~$180 | day-one answers: is that bus CAN or UART, is that rail mains-referenced, key-loop polarity. Never put an earth-referenced USB instrument on a possibly-mains-referenced node |
| True-RMS clamp meter | ~$50 | rail currents are still unknown — this answers §7's open question |
| Hardware E-stop (mushroom button) + GFCI | ~$45 | required before automated fault injection |
| MCP23017 I2C expander breakout | ~$9 | relay drive + key-state sense without exhausting GPIO |
| USB 3 SSD (256GB+) | ~$35 | replaces the dropped M.2 kit; CAN logging kills microSD |
| Pi 5 RTC battery | ~$5 | isolated bench network, no NTP |
| UPS for the Pi (different circuit from the DUT) | ~$60 | treadmill start surge on a shared breaker kills the logger with the data |
| Fuses for every tapped rail, ferrules, twisted pair, DIN rail/enclosure, machine-connector pigtails, labels | ~$100 | pigtails for the machine's actual connectors are the biggest hidden bring-up time sink |

Roughly **$650 of bench hardware** on top of the silicon — the review put the realistic gap at $700-1200 depending on scope/UPS choices.

---

## Running total (primary picks, post-review)

| Category | Pick | Price |
|---|---|---|
| Pi 5 kit | CanaKit Starter Kit 128GB | $269.95 |
| Thermocouples | Sequent 8-ch DAQ (mounted off-board) | $120.00 |
| DC rails (<10A) | 3× Adafruit INA228 | ~$45 |
| AC metering | Shelly Pro EM-50 (was: PZEM) | $119.99 |
| CAN FD | Waveshare 2-CH CAN FD HAT (`spi1-1cs`) | $46.99 |
| RS485 | DSD TECH SH-U11F | $19.99 |
| >10A DC (if needed) | SparkFun ACS37800 Qwiic | $19.95 |
| Safety-key relay | ProtoSupplies 8-ch JD-VCC module + separate 5V supply | $7.95 |
| **Silicon total** | | **≈ $650** |
| Bench essentials (§9, estimated) | probes, hub, scope, E-stop, SSD, UPS, wiring | **≈ +$650** |

## Bring-up order (from the review — don't skip 1-3)

1. **Scope before wiring anything**: rail-to-earth potentials (AC+DC) on all three DC rails and the motor controller; console↔MC bus physical layer, levels, bitrate; key-loop voltage and polarity; encoder signal quality at speed.
2. **Base Pi 5**: migrate the encoder onto the corrected pin map, reproduce the known-good tach baseline (14.038 vs 14.035 true) before adding anything.
3. **Write down the grounding decision** — one bond point at console ground — before the first shunt goes into a rail. Continuity-check the three DC returns on the machine.
4. `i2cdetect` one device at a time, then the full bus at 100 kHz.
5. CAN tap listen-only, termination off — confirm frames received, zero transmitted.
6. Thermocouples: two-point ice/boil check, mount, reinstall the motor cover (data with the cover off isn't representative).
7. Mains metering (the one item needing a second pair of eyes / EHS sign-off).
8. Safety-key relay last: continuity-test board ground topology, bench-test fail-safe (power loss / reboot / script kill → key out) with the treadmill **unplugged**, then wire in series with the real key.

## Still open

- **Rail currents unknown** — if the motor-controller rail exceeds 30A, no verified sensing option exists yet (ACS758-50A / external-shunt research didn't survive verification). The clamp meter in §9 answers this; measure before ordering §7.
- **Motor-terminal (armature) voltage channel** — the review's highest-value missing measurement (ties to the open coast-down question). It's an isolated-amplifier problem (AMC1311-class); nothing specced yet. The armature node is PWM-chopped rectified mains (~170V peaks) — no INA/ACS part touches it directly.
- **Pi 5 8GB below $175?** — Digi-Key/Mouser/Adafruit/SparkFun price check never completed; $175 at CanaKit/PiShop is the verified floor.
- **Relay board ground topology + boot-glitch behavior** — bench checks, not purchases (see §8).
- **Software migration** — `setup_adb_bridge.sh` is a Zero 2 W idiom that fails on Pi 5; `rig_monitor.py`'s single 10 Hz loop won't scale to ~25 channels (needs per-sensor threads); udev rules by USB serial number before 3+ ttyUSB devices race; details in [review §5.6](test-harness-review.md).
