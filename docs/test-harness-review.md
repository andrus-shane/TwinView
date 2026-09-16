# Hardware plan review — Pi 5 system-test harness for the NTL99925

**Verdict: architecturally sound in intent, but not buildable exactly as drawn.** There is one hard GPIO pin collision, a three-HAT stack that doesn't physically work, a grounding model that is under-specified in the one place it's dangerous, two "passive tap" configs that aren't passive without specific settings, and roughly $700–1200 of missing items (probes, tooling, mains hardware) that the parts-list total hides. Worst first.

---

## 1. Hard errors — these will not work as specified

### 1.1 GPIO17 collision: CAN FD HAT overlay vs. belt encoder (blocking)

The Waveshare 2-CH CAN FD HAT Mode-A recipe uses `dtoverlay=spi1-3cs`, which claims the full SPI1 ALT4 block: **GPIO16 (CE2), GPIO17 (CE1), GPIO18 (CE0), GPIO19–21 (MISO/MOSI/SCLK)**. Your encoder's channel A is **GPIO17** (`GPIO_A = 17` in `pi-rig-monitor\rig_monitor.py`, default in `pi-rig-monitor\tach_quad.c`, and the README wiring table). Even though the HAT only populates `spi1-0` (CE0), the overlay still pinmuxes GPIO17 away.

Failure is asymmetric and ugly: `tach_quad` fails its libgpiod line request ("already claimed") and `rig_monitor.py` exits, then systemd restart-loops — or, if the tach wins the race, `can1` silently never probes.

**Fix, cheapest first:**
1. **Use `dtoverlay=spi1-1cs`** — the HAT only uses CE0/GPIO18, so the 1-CS variant leaves GPIO16/17 free. Zero hardware change. Verify with `raspi-gpio get 16 17 18` after boot that 16/17 are not in ALT4.
2. Move the encoder to a free GPIO (5/6/12/13/22/23/26). `tach_quad` takes `gpio_a` as argv[1]; only `rig_monitor.py`'s constant and the README table need edits — but you're moving a physical wire, so re-run a speed sweep against the console (you have a known-good baseline: `WHEEL_CIRC_M = 0.2388`, 14.038 vs 14.035 true).
3. Mode B (both controllers on SPI0) frees GPIO16–21 entirely, but on this board it's selected by moving 0Ω resistors — soldering — and Waveshare recommends Mode A. Avoid.

### 1.2 The three-HAT stack (M.2 + thermocouple + CAN FD) is not physically or thermally viable

- The **M.2 HAT+ must sit at the bottom** (short PCIe FFC), but its bundled stacking header is cut to sit flush at 16 mm — nothing plugs in above it without a deliberately extra-long 2×20 stacking header, and the official spec doesn't support this stacking.
- The **Waveshare CAN FD HAT is terminal** — plain 2×20 socket, no pass-through pins on top. It must be the top board.
- That forces the **Sequent thermocouple HAT into the middle** — the worst spot. Its 8 pluggable field-wiring terminals (16 TC conductors) end up sandwiched between two PCBs: unserviceable.
- **Cold-junction compensation error:** the Sequent's CJC reference is on-board. Buried mid-stack 15 mm above a Pi 5 running 60–70 °C with an NVMe alongside, it bakes and every channel picks up a systematic offset. (The parts doc flags this for the MCC 134 alternate — it applies equally to any onboard-CJC board.)
- The CanaKit active cooler almost certainly doesn't fit under a stacked HAT either.

**The clean fix:** the Sequent card is **I2C-only (GPIO2/3) with its own 2-pin 5V input** — so don't make it a HAT at all. Mount it off-board on a short 4-wire pigtail (SDA/SCL/GND + its own 5V), 15–25 cm away in open air. That fixes stacking, CJC heating, and serviceability in one move. Then **drop the M.2 HAT+ and boot from a USB 3 SSD** (~350 MB/s — plenty for logging, which is the only real justification for fast storage; continuous CAN FD logging will kill microSD cards). Net rule: **one board on the 40-pin header (the CAN FD HAT); everything else on I2C cable, USB, or its own MCU.**

### 1.3 HAT ID EEPROM collision at 0x50 on i2c-0

Every compliant HAT puts an ID EEPROM at 0x50 on the separate ID bus (GPIO0/1), and the M.2 HAT+ *requires* its EEPROM readable for PCIe config. Two populated EEPROMs in a stack collide. Another reason to keep one board on the header. (Your WT901 is also 0x50 but on **i2c-1** — different bus, no conflict; just never move it to i2c-0.)

### 1.4 Sequent HAT's onboard RS485 transceiver uses the Pi UART (GPIO14/15)

Per Sequent's own docs, the board's RS485/MODBUS feature rides the Pi UART, configured by the same DIP switches that set stack address. Set the DIP to disable RS485 and keep the serial console off `ttyAMA0`/GPIO14/15, or you'll get mysterious UART contention.

### 1.5 The mains CT will read ≈ zero if clamped around the line cord

A split-core CT around a 2-conductor cord sees hot + neutral cancel. You must clamp **one conductor**, which means a line-splitter accessory or a built inline metering box — and the PZEM also needs L/N tapped for voltage sense. In a corporate lab that's a fabricated mains device on a ~15 A circuit: EHS review, enclosure, fusing, strain relief, labeling. See §5.2 for the recommendation to sidestep this.

---

## 2. I2C address and pin map — clean on paper, with caveats

**No I2C address conflicts** as designed:

| Bus | Device | Address | Notes |
|---|---|---|---|
| i2c-0 (ID) | HAT EEPROM(s) | 0x50 | collision risk only if >1 HAT stacked (§1.3) |
| i2c-1 | Sequent 8-TC | 0x16 base (DIP-selectable 0x16–0x1D) | verified in Sequent's library source |
| i2c-1 | INA228 ×3 | 0x40/0x41/0x44 or 0x45 | **all three ship at 0x40** — set A0/A1 jumpers *before* first power-up; only 4 addresses available on the Adafruit breakout |
| i2c-1 | WT901 | 0x50 | |
| i2c-1 | ACS37800 | 0x60 | confirm — DIO strapping can land 0x60/0x61 |

**Address-masking trap:** if you wire all three INA228s before setting jumpers, `i2cdetect -y 1` shows a single healthy-looking device at 0x40 and hides the conflict. Bring boards up one at a time.

**Bus speed and loading:** the Sequent card is an MCU-based I2C slave that typically wants 100 kHz, which pins the shared bus at 100 kHz. Six devices' parallel pull-ups (~10 kΩ each plus the Pi's 1.8 kΩ) approach the 3 mA sink limit; remove pull-ups on all but one board per bus. Better: **split the buses** — Sequent on i2c-1 at 100 kHz; a second bus (`dtoverlay=i2c3` on GPIO4/5) at 400 kHz for the Qwiic power-monitor chain. Bonus: a hung SDA takes out one sensor group, not the whole harness. The Pi's I2C controller has no bus recovery for a slave holding SDA low — and the ACS37800 will sit physically near the motor drive, your noisiest neighbor, at the end of the longest cable run. For that run specifically, use a differential extender (PCA9615) or a separate bus so a glitch there is contained.

**GPIO occupancy after the §1.1 fix:** 2/3 (I2C1), 0/1 (ID), 7–11 (SPI0, CAN0 CE0=8, INT=25), 18–21 (SPI1, CAN1 CE0=18, INT=24), 14/15 (UART — keep clear per §1.4), 17/27 (encoder). **Free: GPIO4, 5, 6, 12, 13, 16, 22, 23, 26 — nine lines.** That covers 8 relay inputs *or* key-state sensing, not both. Write the full pin map down before the first wire; nothing errors at boot on a silent overlap. Cleanest fix: an **MCP23017 I2C expander (0x20, ~$9)** — 8 outputs sinking the active-low relay inputs, 8 opto-buffered inputs for key/fault state sensing — freeing the header entirely.

---

## 3. Grounding and isolation — the biggest real risk

Work this as a domain graph, not a per-part checklist. **You already have one non-isolated bond you can't remove: the ADB USB cable** puts the Pi inside the console tablet's ground domain. That's fine — it's a design constraint. Correct architecture: **exactly one bond point, at console/logic ground; every other measurement path isolated.** Where the plan violates it:

**3.1 The INA228s bond all three rails' grounds to the Pi.** An INA228 is a high-side monitor, but its VS/GND/SDA/SCL are Pi-ground-referenced. Three of them on one bus hard-bonds tablet-USB return, console return, and MC-logic return together through your I2C reference. If those returns aren't already one node in the machine, you've built ground loops carrying PWM return current — symptom: NACKs, stuck SDA, garbage that correlates with belt speed. **Verify continuity between the three returns on the treadmill before wiring any shunt.** Any rail on a separate return gets an I2C isolator (Qwiic isolator + isolated 5V, ~$12) in front of its board.

**3.2 The motor-controller rail may be mains-referenced — verify before connecting anything.** Icon/NordicTrack MC boards rectify 120 VAC directly; the drive's "ground" is often rectified-line negative, not earth. If the "MC logic" rail lives on that side and you land a non-isolated INA228 or the SparkFun ACS37800 on it (the SparkFun board isolates only the *current path*, not the I2C/supply side), you put line potential on the Pi ground — and therefore on the tablet and the CAN bus. **Mandatory first step: DMM each candidate rail's negative to earth (AC and DC), ideally confirmed on a battery-powered scope.** If it's not console-referenced, that channel needs a fully isolated path (Pololu #5410-style ACS37800 with isolated I2C, or SparkFun behind a Qwiic isolator) or you don't measure it electrically.

**3.3 Thermocouples: use ungrounded-junction probes only.** The Sequent inputs are not channel-isolated; a grounded-tip probe clamped to a heatsink bonded to the DC bus puts that potential onto the DAQ and the Pi. Treat every TC mounting point as potentially live until measured. This is the most likely way this build destroys hardware or hurts someone.

**3.4 The PZEM 5V pin is a trap.** The PZEM-004T v3's TTL side is opto-isolated but **requires external 5V on the comms header to power the optos**. If you feed that 5V from the Pi, you re-bond the domains and defeat the isolated adapter entirely. Spec the adapter as: *isolated USB-TTL, isolated 5V output, 5V logic levels* (many isolated adapters are 3.3V-only or have no isolated VCC out).

**3.5 CAN and ADB.** The Waveshare HAT's transceivers are Pi-powered (not galvanically isolated), so the CAN tap bonds Pi ground to the machine's CAN common — acceptable *if* that common really is console/logic ground (same domain as ADB); confirm before plugging in. Don't try to isolate the ADB link — USB isolators top out at 12 Mbps and scrcpy would crawl. Keep that bond and design around it.

**3.6 ADB back-power corrupts your own measurement.** A normal USB cable from Pi to tablet will charge the tablet — blowing the Pi's USB current budget *and* contaminating the INA228 reading on the "tablet USB" rail (the tablet then draws from two sources). Use a data-only/power-blocked cable, a per-port-switchable hub, or ADB-over-TCP.

---

## 4. Sensor, driver, and actuation issues

### 4.1 CAN "sniffing" is not passive by default — two required steps the doc omits

1. **Disable the HAT's onboard 120 Ω termination** before tapping an already-terminated bus (the doc makes exactly this call for RS485 but not CAN — a third terminator gives ~40 Ω instead of 60 Ω and degrades the machine's own bus).
2. **Bring interfaces up listen-only**: `ip link set can0 up type can bitrate <n> dbitrate <d> fd on listen-only on`. Without it the controller ACKs frames and, on any bitrate/sample-point mismatch, injects error frames — your "passive tap" becomes an active disruptor on the treadmill's control network. This is the single most likely "worked on the bench, broke the machine" event in the plan.

Also confirm up front whether the bus is actually CAN FD (and the nominal/data bitrates) or classic CAN — owning an FD HAT doesn't tell you what the target runs. And keep the PCAN-USB FD escape hatch in mind: the mcp251xfd-on-Pi 5 RX-delay/SPI-overflow issues (raspberrypi/linux #6407, #6644) are real; plan for the possibility that only `can0` is reliable.

### 4.2 Scope the console↔MC link before trusting the bus taps — you may need a plain UART tap

FitPro-style console↔lower-board links on this platform have historically been serial, not CAN. The plan buys CAN FD and RS485 taps but **no TTL-UART tap** — possibly the most probable physical layer for the traffic you care about. Scope the harness first; if it's 3.3/5V UART, you need 1–2 isolated UART RX channels (~$20), and *two* channels for a full-duplex link (direction attribution needs independent RX per wire on a shared timebase). Related: half-duplex RS485 sniffing gives one interleaved stream with no direction info — you infer master/slave from addressing and timing; no hardware fixes that. And the RS485 tap needs **three wires (A, B, and a ground reference)** even with an isolated adapter, or common-mode can walk outside the receiver's range.

### 4.3 INA228: headroom and driver reality

- ADCRANGE=0 full scale is ±163.84 mV; across the Adafruit board's 15 mΩ shunt that's **±10.9 A** — a "10 A" rail has 9% headroom, and inrush clips silently (plateau, not an overload flag). 10 A continuous is also ~1.5 W in a small 2512 shunt; self-heating drifts calibration. If any rail truly runs near 10 A, use an external shunt or the hall sensor.
- **Driver:** mainline supports INA228 via the **`ina238` hwmon driver**, not `ina2xx` as the parts doc says — and Raspberry Pi OS ships no stock overlay for it, so you'd hand-build a `.dtbo` (address + `shunt-resistor` in µΩ) or use sysfs `new_device`. hwmon also doesn't expose the 40-bit energy/charge accumulators — half the reason to pick an INA228. Realistically plan on the Adafruit CircuitPython library or a small direct-register reader; budget the time.

### 4.4 ACS37800: no Python library, AC part on a DC rail

SparkFun ships Arduino C++ only — budget a Python port (register reads are easy; the shadow/EEPROM config sequence is easy to get wrong). Configure DC mode and read the instantaneous registers with your own averaging; the RMS machinery is AC-metering-oriented. The ±30 A limit applies to **PWM peaks, not averages** — the doc's "measure the rail first" flag is right. And INA228 abs-max is 85 V: neither part touches the motor *armature* node (PWM-chopped rectified mains, ~170 V peaks) without a properly isolated front end.

### 4.5 The 100 A CT and the 1 Hz PZEM are the wrong instruments for half the questions

A NTL99925 draws ~0.1–0.5 A idle, 10–15 A loaded — the bottom 15% of a 100 A CT's range, where phase error and offset dominate (the 0.5% class spec doesn't hold there; looping the conductor through the CT multiple turns helps resolution). And the PZEM updates at ~1 Hz, so it **cannot see motor-start inrush** — likely one of the things you actually want. Steady-state energy and transients need different instruments (§5.2). Validate whatever you use against a known resistive load *and* a true-RMS clamp meter — motor-drive current has high crest factor and cheap meters lie on distorted waveforms.

### 4.6 Safety-key relay — the doc's isolation instruction needs a rewrite, and fail-safe direction is undefined

- **The relay contacts are the actual isolation barrier** — a kV-rated mechanical gap between Pi domain and key loop. The JD-VCC ritual doesn't create that barrier; what the jumper split genuinely buys is keeping 8 × ~70 mA of coil current and inductive kick **off the Pi's 5V rail**. Worth doing (separate 5V/2A brick), but not for the reason stated.
- **Continuity-test the actual board you receive.** On many of these modules the header logic-GND and the JD-VCC coil-GND are the *same copper net* — the jumper only ever separated the supply rails. The "never tie Pi GND to board GND" instruction is satisfiable only in the specific wiring where VCC + INx are the sole Pi connections (LED current flows VCC→LED→INx→GPIO sink). Verify what you got, then rewrite the wiring note from measurement, not boilerplate.
- **Logic level:** with VCC=5V and a 3.3V GPIO driving active-low INx, GPIO-high leaves ~1.7V across the opto input — channels can sit half-on. Use 3.3V for VCC, drive INx open-drain, or use the MCP23017 sinking outputs (§2), which is exactly what an active-low opto input wants.
- **Fail-safe direction — decide and document it.** Wire the relay **in series with the real key circuit, never in parallel** (the physical key must remain a working human e-stop; never build anything that permanently simulates "key present"). Recommend NO contact, **coil energized = key present**: Pi crash, script death, or coil-supply loss all resolve to key-out = belt stops. Cost: a power glitch wastes a run — the right trade for unattended fault injection. Verify the de-energized state with a meter, and check boot-time GPIO behavior on the Pi 5 (RP1) with the treadmill unplugged before trusting it.
- **Contact wetting:** a 10 A power relay switching a milliamp signal loop develops intermittent high-resistance contacts over thousands of automated cycles. For the key line, use a gold-flashed signal relay or a PhotoMOS (AQY212-class). The failure symptom — flaky "key removed" events — looks exactly like a DUT bug.
- **Best structural upgrade:** put the key relay behind a **$4 RP2040/Pico with a heartbeat watchdog** that de-energizes (key out) if the Pi stops talking. A kernel oops in mcp251xfd should not leave the belt running with no way to stop it. The same Pico solves the encoder too: PIO quadrature decode handles millions of counts/s, restores x4 resolution and true direction, and sidesteps the question of Pi 5 GPIO interrupt latency entirely (RP1 edges route over PCIe — not reliably better than the Zero 2 W, just differently jittery).

### 4.7 Missing sense path: Key 1/Key 2 state lines

The original sketch sensed the key lines at 12–0 V; the parts list only actuates. **12 V on a Pi GPIO destroys the pin.** Add opto-isolated digital-input channels or divider+clamp (~$10) for every state line you log — folded neatly into the MCP23017's input side.

---

## 5. What's missing

### 5.1 Thermocouple probes — you bought an 8-channel TC DAQ and zero thermocouples

Add: 8× **ungrounded-junction**, fiberglass/PTFE-insulated K-type surface probes (~$10–18 ea); K-type extension wire (ANSI: yellow +, red − — reversed polarity reads inverted, the classic day-one bug); Kapton/high-temp tape or thermal adhesive (mounting error dominates TC accuracy); one channel always on **ambient**. Note the Sequent uses bare-wire field terminals, not mini-TC jacks. If the intent is *comparative* thermal work (firmware A vs B, ~5 °C deltas), class-2 K at ±2.2 °C is marginal — the HAT also does T/E types with ~2× sensitivity below 150 °C; and report rise-above-ambient, which cancels most offset error for free. Also: 8 TC leads exiting the motor compartment means the cover is off or notched — data with the cover off isn't representative; plan a gasketed exit and reinstall.

### 5.2 Mains metering: buy listed hardware instead of fabricating it

Given §1.5 + §4.5 + EHS exposure, the hand-built PZEM box is the worst option on total cost. Better: a metered PDU or the Shelly Pro EM-50 already on your alternates list (50 A CTs — better ratio; isolated by architecture; polled over HTTP/MQTT on the bench subnet). Keep the PZEM as a cheap redundant steady-state channel if you like. If inrush matters, add a fast channel (SCT-013-020 into an ADC, or a clamp on the scope) — a 1 Hz meter and an inrush question are incompatible.

### 5.3 The highest-value missing measurement channel

Your own open cycle-8 coast-down question needs a **motor-terminal (armature) voltage channel** — the plan measures three logic rails and no drive output. That's an isolated-amplifier problem (AMC1311-class, or divider into an isolated ADC), and the ±30 A hall sensor is arguably better spent on the armature loop (with secondary isolation, per §3.2) than on a logic rail.

### 5.4 Test equipment and safety

- **A battery-powered handheld scope** (~$180) is the highest-ROI purchase not on the list. It answers, on day one: is that bus CAN or UART, what baud, is that rail mains-referenced, what's the key-loop voltage/polarity. **Never** put a USB-powered earth-referenced instrument on a possibly-mains-referenced node. Add a true-RMS clamp meter.
- **A hardware E-stop independent of the Pi/GPIO/relay chain** — a physical mushroom button in the motor kill circuit or a mains disconnect. The software watchdog in `server/src/twin.ts` can't help if the Pi hangs or the coil supply dies mid-run. Add it before any automated fault injection. Plus: GFCI, barrier/signage for a remotely-startable treadmill, camera for unattended runs, and a written nobody-on-the-belt rule for injection runs.

### 5.5 Power and USB budget

- Pi 5 caps USB at **600 mA unless the PSU negotiates 5V/5A** (then 1.6 A). You're planning 2–3 USB-serial dongles, possibly a USB SSD, and a tablet that wants to charge — over budget in every configuration. **Add a powered USB 3 hub**, ideally `uhubctl`-capable (which doubles as your tablet-USB-power fault-injection actuator — per-port power switching beats relay-switching data lines). Verify the CanaKit brick actually negotiates 5.1V/5A (`vcgencmd pmic_read_adc`, watch for the low-PSU warning); check `vcgencmd get_throttled` under full load, not idle.
- **One 5V source only:** the Sequent card can back-feed the Pi header from its own connector — never do that with USB-C PD also connected.
- Pi on a **UPS on a different circuit from the DUT** (treadmill start surge can trip the shared breaker and kill the logger with the data). Add the **Pi 5 RTC battery** (~$5) — isolated bench network, no NTP.
- Consumables: extra-long stacking header (if any stack survives), Qwiic-to-GPIO adapter + cables (flagged in your notes, never itemized), inline fuses for **every** rail you cut into for a shunt, mating pigtails/breakouts for the machine's actual connectors (the biggest hidden time sink in bring-up), ferrules, twisted pair, enclosure/DIN rail separating mains from low-voltage wiring, labels. If "tablet USB" is USB-C PD, you need a PD breakout — and ~50 mΩ of inserted shunt+connector can perturb PD negotiation.

### 5.6 Software/migration traps (repo-specific)

- **`setup_adb_bridge.sh` won't survive the Pi 5.** Its `dtoverlay=dwc2,dr_mode=peripheral→host` sed is a Zero 2 W idiom; on the Pi 5 the USB-A ports are host-native via RP1, the edit doesn't apply, and the script's own `grep -q 'dr_mode=host' || exit 1` sanity check fails. Safe failure, but skip/rewrite it for the Pi 5.
- **`tach_quad.c` hardcodes `/dev/gpiochip0`** — correct on current Pi 5 kernels (RP1 is gpiochip0 since ~6.6.47) but gpiochip4 on older images. Make it robust: resolve by label (`pinctrl-rp1`), and confirm libgpiod v2 on the target image.
- **`rig_monitor.py`'s single 10 Hz loop won't scale** from 2 channels to ~25: one blocking `read_i2c_block_data` already stalls the stream; add a 200 ms Modbus poll and it collapses. Refactor to per-sensor threads publishing latest-value snapshots, with the broadcaster pacing independently. Move the wire protocol from per-line regex (`network_sensors.json`) to JSON-lines, keeping the legacy `incline.pitch:`/`tach.mph:` prefixes for compatibility.
- **udev rules by USB serial number, now** — 3+ USB-serial devices means `ttyUSB0..2` enumeration races that silently swap your RS485 sniffer and mains meter. Set FTDI `latency_timer` to 1 ms (default 16 ms) or inter-frame timing analysis is garbage.
- **Clock discipline:** your 0.3–0.7 s "log trails physical cut" figure mixes real console latency with unmeasured Pi↔tablet skew. Sample `adb shell date +%s.%N` against the Pi's clocks at run start/end, record offset+drift, correct; run chrony on the Pi. Cheap, and it retroactively sharpens a result you already care about. Extend the existing value+`CLOCK_MONOTONIC` timestamp pattern to every new data path (CAN dump, RS485 dump, PZEM, I2C loop) — five unsynchronized streams are useless for fault-injection correlation.
- Enable the hardware watchdog and define per-subsystem restart behavior.

---

## 6. Revised architecture in one paragraph

Pi 5 + **one** HAT: the Waveshare 2-CH CAN FD on the header with `spi1-1cs`, termination off, interfaces listen-only. Boot from USB3 SSD; skip the M.2 HAT+. Sequent 8-TC card off-header on an I2C pigtail with its own 5V, in open air. Second I2C bus (`i2c3` on GPIO4/5, 400 kHz) for the Qwiic power-monitor chain; INA228 addresses jumpered apart before power-up; any board on a non-console-referenced or noisy return goes behind a Qwiic isolator (Pololu-style isolated ACS37800 for the motor rail). Isolated USB-TTL **with isolated 5V out** for the PZEM (or better, a Shelly Pro EM-50 as primary mains meter); isolated USB-RS485 with 3-wire tap, termination off; add an isolated UART tap once the console↔MC link is scoped. A Pico owns the encoder (PIO x4 decode, direction restored) and the safety-key relay behind a heartbeat watchdog that fails to key-out; MCP23017 for remaining relay drives plus opto-isolated 12V key-state sensing. All USB peripherals and the tablet on a powered per-port-switchable hub; Pi on a UPS on a different circuit; hardware mushroom E-stop independent of everything above.

## 7. Bring-up order (don't skip 1–3)

1. **Scope before wiring anything:** rail-to-earth potentials (AC+DC) on all three DC rails and the MC; console↔MC bus physical layer, levels, bitrate; key-loop voltage and polarity; encoder signal quality at speed.
2. **Base Pi 5:** fix `tach_quad` chip resolution, migrate the encoder onto the corrected pin map, reproduce the known-good tach baseline (14.038 vs 14.035) before adding anything.
3. **Write down the grounding decision** — one bond point — before the first shunt goes into a rail. Continuity-check the three DC returns on the machine.
4. `i2cdetect` one device at a time (addresses per §2), then the full bus at 100 kHz.
5. CAN (or UART) tap, listen-only, termination off — confirm frames received, zero transmitted.
6. Thermocouples: two-point ice/boil check, mount with ungrounded probes, reinstall the motor cover.
7. Mains metering (the one item that needs a second pair of eyes / possible sign-off).
8. Safety-key relay last: continuity-test the board's actual ground topology, bench-test fail-safe on power loss / reboot / script kill with the treadmill **unplugged**, then wire in series with the real key.

## 8. Budget reality

The parts-list total is the silicon only. Probes, a scope, a powered hub, proper mains metering, fusing, connectors, enclosure, and the Pico/expander add **$700–1200**. Flag that now so the first purchase order doesn't arrive without a single thermocouple.

**Key files:** `C:\Users\shane.andrus\Documents\GitHub\TwinView\docs\test-harness-parts.md`, `C:\Users\shane.andrus\Documents\GitHub\TwinView\pi-rig-monitor\rig_monitor.py`, `C:\Users\shane.andrus\Documents\GitHub\TwinView\pi-rig-monitor\tach_quad.c`, `C:\Users\shane.andrus\Documents\GitHub\TwinView\pi-rig-monitor\setup_adb_bridge.sh`