"""Compose an upbeat, running-cadence 'fitness app demo' track as a stereo WAV
(~261s to match docs/twinview-demo.webm). 130 BPM four-on-the-floor: pumping
sidechained pads (vi-IV-I-V), off-beat octave bass, 16th-note synth lead,
kick/clap/hats, with drops timed to the demo's phases and a fade-out ending.

Section times come from the MARK lines record_demo.mjs prints while recording.

Usage: python tools/make_demo_music.py [out.wav]
Then:  ffmpeg -i <silent-demo>.webm -i out.wav -map 0:v -map 1:a \
         -c:v copy -c:a libopus -b:a 96k -shortest scored.webm
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 261.0
BPM = 130
BEAT = 60 / BPM            # 0.4615s
BAR = 4 * BEAT             # 1.846s
N = int(SR * DUR)
t = np.arange(N) / SR

# Song map (bars): energy rises with the demo arc, drums out for the outro.
BASS_IN = 5 * BAR      # ~9s   lab intro settles, floor starts moving
DRUMS_IN = 21 * BAR    # ~39s  first bay focus (rower): groove starts
DROP1 = 60 * BAR       # ~111s REAL hardware in bay 01: full kit + lead
DROP2 = 103 * BAR      # ~190s treadmill fault cascade: 16th hats, busier lead
OUTRO = 133 * BAR      # ~246s drums out, pads carry the fade

NOTE = lambda semis: 220.0 * 2 ** (semis / 12)  # from A3
# vi-IV-I-V in C: Am F C G — the classic "keep running" loop
CHORDS = [
    [NOTE(0), NOTE(3), NOTE(7)],      # Am: A C E
    [NOTE(-4), NOTE(0), NOTE(3)],     # F:  F A C
    [NOTE(3), NOTE(7), NOTE(10)],     # C:  C E G
    [NOTE(-2), NOTE(2), NOTE(5)],     # G:  G B D
]
ROOTS = [NOTE(-12), NOTE(-16), NOTE(-9), NOTE(-14)]  # bass roots

mix = np.zeros((N, 2))
rng = np.random.default_rng(42)
noise = rng.standard_normal(N)


def seg_env(n, attack_s, release_s):
    tt = np.arange(n) / SR
    return np.minimum(tt / attack_s, 1) * np.minimum((n / SR - tt) / release_s, 1)


def add(n0, seg, pan=0.0):
    n1 = min(n0 + len(seg), N)
    if n0 >= N:
        return
    seg = seg[: n1 - n0]
    left = np.clip(0.5 - pan / 2, 0, 1)
    mix[n0:n1, 0] += seg * left
    mix[n0:n1, 1] += seg * (1 - left)


def saw_pluck(freq, dur, amp, bright=6):
    """Bright saw-ish pluck: summed harmonics with fast decay."""
    tt = np.arange(int(dur * SR)) / SR
    w = sum(np.sin(2 * np.pi * freq * k * tt) / k for k in range(1, bright + 1))
    return w * np.exp(-tt * 9) * np.minimum(tt / 0.004, 1) * amp


# ---- pads: sustained chords all the way through ----
for bar_start in np.arange(0, DUR, BAR):
    ci = int(bar_start / BAR) % 4
    n0 = int(bar_start * SR)
    n = min(int((BAR + 0.25) * SR), N - n0)
    if n <= 0:
        continue
    tt = np.arange(n) / SR
    seg = np.zeros(n)
    for f in CHORDS[ci]:
        seg += (np.sin(2 * np.pi * f * tt) + np.sin(2 * np.pi * f * 1.004 * tt)
                + 0.4 * np.sin(2 * np.pi * f * 2 * tt)) / 2.4
    seg *= seg_env(n, 0.06, 0.12) * 0.115
    add(n0, seg, pan=0.0)

# ---- off-beat pumping bass: root 8ths, octave jumps ----
k = 0
for e8 in np.arange(BASS_IN, OUTRO, BEAT / 2):
    ci = int(e8 / BAR) % 4
    f = ROOTS[ci] * (2 if k % 4 == 2 else 1)
    tt = np.arange(int(BEAT / 2 * SR)) / SR
    seg = (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * f * 2 * tt))
    seg *= seg_env(len(seg), 0.006, 0.05) * 0.20
    add(int(e8 * SR), seg)
    k += 1

# ---- kick: four on the floor ----
for beat in np.arange(DRUMS_IN, OUTRO, BEAT):
    tt = np.arange(int(0.14 * SR)) / SR
    f = 160 * np.exp(-tt * 22) + 48
    seg = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 17) * 0.5
    add(int(beat * SR), seg)

# ---- clap/snare on 2 & 4 (from DROP1) ----
for beat in np.arange(DROP1 + BEAT, OUTRO, 2 * BEAT):
    n0 = int(beat * SR)
    tt = np.arange(int(0.12 * SR)) / SR
    body = np.sin(2 * np.pi * 185 * tt) * np.exp(-tt * 30) * 0.16
    snap = noise[n0 : n0 + len(tt)] * np.exp(-tt * 26) * 0.16
    add(n0, body + snap[: len(body)])

# ---- hats: off-beat 8ths, then 16ths after DROP2 ----
for e8 in np.arange(DRUMS_IN + BEAT / 2, OUTRO, BEAT):
    n0 = int(e8 * SR)
    tt = np.arange(int(0.045 * SR)) / SR
    add(n0, noise[n0 : n0 + len(tt)][: len(tt)] * np.exp(-tt * 90) * 0.10, pan=0.25)
for e16 in np.arange(DROP2, OUTRO, BEAT / 4):
    n0 = int(e16 * SR)
    tt = np.arange(int(0.03 * SR)) / SR
    add(n0, noise[n0 : n0 + len(tt)][: len(tt)] * np.exp(-tt * 120) * 0.05, pan=-0.2)

# ---- lead: 16th-note arp riff (from DROP1, busier after DROP2) ----
RIFF1 = [0, 2, 1, 2, 0, 2, 1, 3]         # chord-tone indices (3 = octave root)
RIFF2 = [0, 2, 3, 2, 1, 3, 2, 3]
k = 0
for e16 in np.arange(DROP1, OUTRO, BEAT / 2):
    ci = int(e16 / BAR) % 4
    tones = CHORDS[ci] + [CHORDS[ci][0] * 2]
    riff = RIFF2 if e16 >= DROP2 else RIFF1
    f = tones[riff[k % 8]] * 2
    add(int(e16 * SR), saw_pluck(f, 0.35, 0.13), pan=0.35 * np.sin(k * 0.9))
    if e16 >= DROP2:  # extra 16th push
        add(int((e16 + BEAT / 4) * SR), saw_pluck(f / 2, 0.2, 0.06), pan=-0.2)
    k += 1

# ---- risers into the drops + crash at the drops ----
for drop in (DROP1, DROP2):
    n0 = int((drop - 2 * BAR) * SR)
    n = int(2 * BAR * SR)
    tt = np.arange(n) / SR
    add(n0, noise[n0 : n0 + n][:n] * (tt / tt[-1]) ** 2 * 0.09)
    ncr = int(1.2 * SR)
    ttc = np.arange(ncr) / SR
    add(int(drop * SR), noise[:ncr] * np.exp(-ttc * 5) * 0.17)

# ---- sidechain pump: duck everything to the kick grid once drums start ----
pump = np.ones(N)
grid = (t % BEAT) / BEAT
duck = 1 - 0.5 * np.exp(-grid / 0.12)
active = (t >= DRUMS_IN) & (t < OUTRO)
pump[active] = duck[active]
mix *= pump[:, None]

# ---- master: intro fade-in, 6s outro fade, glue saturation ----
master = np.minimum(t / 1.5, 1) * np.clip((DUR - 0.2 - t) / 6.0, 0, 1)
mix *= master[:, None]
mix = np.tanh(mix * 1.5) * 0.9
mix /= np.abs(mix).max() / 0.88

out_path = sys.argv[1] if len(sys.argv) > 1 else 'music.wav'
out = (mix * 32767).astype('<i2')
with wave.open(out_path, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(out.tobytes())
print(f'wrote {out_path}: {DUR}s @ {BPM} BPM')
