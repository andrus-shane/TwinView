"""Compose a ~117s royalty-free 'inspirational tech demo' track as a stereo WAV.
Warm pads on a I-V-vi-IV progression, plucked arpeggios, soft bass, light
percussion — layers enter progressively and everything fades for the outro."""
import struct
import wave

import numpy as np

SR = 44100
DUR = 117.1
BPM = 72
BEAT = 60 / BPM          # 0.833s
BAR = 4 * BEAT           # 3.333s
N = int(SR * DUR)
t = np.arange(N) / SR

# C major: I  V  vi  IV  ->  C  G  Am  F  (freqs of chord tones, mid register)
NOTE = lambda semis: 261.63 * 2 ** (semis / 12)  # from C4
CHORDS = [
    [NOTE(0), NOTE(4), NOTE(7)],     # C:  C E G
    [NOTE(-5), NOTE(-1), NOTE(2)],   # G:  G B D
    [NOTE(-3), NOTE(0), NOTE(4)],    # Am: A C E
    [NOTE(5), NOTE(9), NOTE(12)],    # F:  F A C
]
ROOTS = [NOTE(-12), NOTE(-17), NOTE(-15), NOTE(-7)]  # roots an octave down

mix = np.zeros((N, 2))


def env_ramp(start, end, attack=0.8, release=1.2):
    """Envelope that fades a layer in at `start` and out at `end` (seconds)."""
    e = np.clip((t - start) / attack, 0, 1) * np.clip((end - t) / release, 0, 1)
    return np.clip(e, 0, 1)


def pluck(freq, at, dur=1.6, amp=0.22, pan=0.0):
    """Exponentially decaying pluck with a couple of harmonics."""
    n0 = int(at * SR)
    n1 = min(int((at + dur) * SR), N)
    if n0 >= N:
        return
    tt = np.arange(n1 - n0) / SR
    decay = np.exp(-tt * 3.2)
    wavef = (np.sin(2 * np.pi * freq * tt) * 0.7
             + np.sin(2 * np.pi * freq * 2 * tt) * 0.18
             + np.sin(2 * np.pi * freq * 3 * tt) * 0.06)
    seg = wavef * decay * amp * np.minimum(tt / 0.008, 1)  # click-free attack
    left = np.clip(0.5 - pan / 2, 0, 1)
    mix[n0:n1, 0] += seg * left
    mix[n0:n1, 1] += seg * (1 - left)


# ---- pads: sustained chords, slow chorus shimmer, whole track ----
pad_env = env_ramp(0.5, DUR - 1.5, attack=4.0, release=6.0)
for bar_start in np.arange(0, DUR, BAR):
    ci = int(bar_start / BAR) % 4
    n0 = int(bar_start * SR)
    n1 = min(int((bar_start + BAR + 0.6) * SR), N)  # slight overlap between bars
    tt = np.arange(n1 - n0) / SR
    bar_env = np.minimum(tt / 1.2, 1) * np.minimum((len(tt) / SR - tt) / 0.6, 1)
    seg = np.zeros(len(tt))
    for f in CHORDS[ci]:
        for mult, a in ((1, 0.5), (2, 0.12), (0.5, 0.25)):
            # slow detune between two oscillators = warm chorus
            seg += a * (np.sin(2 * np.pi * f * mult * tt)
                        + np.sin(2 * np.pi * f * mult * 1.003 * tt)) / 2
    seg *= np.clip(bar_env, 0, 1) * 0.10
    mix[n0:n1, 0] += seg
    mix[n0:n1, 1] += seg * 0.94  # tiny stereo asymmetry

mix *= pad_env[:, None]  # pads dominate the buffer so far

# ---- bass: soft roots, enters at 13s ----
bass_env = env_ramp(13, DUR - 4, attack=2.0)
for bar_start in np.arange(0, DUR, BAR):
    ci = int(bar_start / BAR) % 4
    n0 = int(bar_start * SR)
    n1 = min(int((bar_start + BAR) * SR), N)
    tt = np.arange(n1 - n0) / SR
    seg = np.sin(2 * np.pi * ROOTS[ci] * tt) * np.minimum(tt / 0.05, 1) * 0.16
    mix[n0:n1, 0] += seg * bass_env[n0:n1]
    mix[n0:n1, 1] += seg * bass_env[n0:n1]

# ---- arpeggio: 8th-note plucks over the chord, enters at 26.7s (bar 8) ----
arp_start = 8 * BAR
k = 0
for beat8 in np.arange(arp_start, DUR - 6, BEAT / 2):
    ci = int(beat8 / BAR) % 4
    tones = CHORDS[ci] + [CHORDS[ci][0] * 2]
    freq = tones[k % len(tones)] * (2 if (k % 8) in (3, 7) else 1)
    pluck(freq, beat8, amp=0.16, pan=0.35 * np.sin(k * 0.7))
    k += 1

# ---- percussion: soft kick + brush hat, enters at 53.3s (bar 16) ----
perc_start = 16 * BAR
rng = np.random.default_rng(7)
noise = rng.standard_normal(N) * 0.5
for beat in np.arange(perc_start, DUR - 8, BEAT):
    bi = round((beat % BAR) / BEAT)
    n0 = int(beat * SR)
    if bi in (0, 2):  # kick: pitched-down sine thump
        n1 = min(n0 + int(0.18 * SR), N)
        tt = np.arange(n1 - n0) / SR
        f = 95 * np.exp(-tt * 9) + 42
        seg = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 16) * 0.30
        mix[n0:n1, 0] += seg
        mix[n0:n1, 1] += seg
    # brush hat on every beat (soft filtered noise tick)
    n1 = min(n0 + int(0.05 * SR), N)
    tt = np.arange(n1 - n0) / SR
    seg = noise[n0:n1] * np.exp(-tt * 70) * 0.055
    mix[n0:n1, 0] += seg * 0.8
    mix[n0:n1, 1] += seg

# ---- shimmer: sparse high sparkle notes, final act (from 80s) ----
for beat in np.arange(80, DUR - 10, BEAT * 2):
    ci = int(beat / BAR) % 4
    pluck(CHORDS[ci][int(beat) % 3] * 4, beat + 0.1, dur=2.2, amp=0.05,
          pan=0.5 * np.sin(beat))

# ---- master: gentle intro fade-in + 7s outro fade, soft-knee normalize ----
master = env_ramp(0.0, DUR - 0.2, attack=2.5, release=7.0)
mix *= master[:, None]
mix = np.tanh(mix * 1.4) * 0.82  # soft saturation glue + headroom
peak = np.abs(mix).max()
mix = mix / peak * 0.85

out = (mix * 32767).astype('<i2')
with wave.open(r'demo-video\music.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(out.tobytes())
print(f'wrote music.wav: {DUR}s, peak {peak:.2f}')
