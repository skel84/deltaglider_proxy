#!/usr/bin/env python3
"""Generate an ORIGINAL upbeat backing track for the demo video.

Pure additive/subtractive synthesis with the Python stdlib (no numpy, no
external audio) — so the result is 100% license-clean for a public upload.

Arrangement (~124 BPM, energetic but not frantic, sits under a captioned
product demo):
  - four-on-the-floor kick
  - offbeat closed hi-hats (the "drive")
  - a syncopated saw-ish bassline following the chord roots
  - a bright plucked arpeggio over a I-V-vi-IV-ish loop (uplifting/tech)
  - light intro (drums build) + outro (filter-down) handled by the master

Writes a 16-bit stereo WAV to argv[1] for the given duration (argv[2], sec).
"""
import sys, math, struct, wave, random

OUT = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 84.0
SR = 44100
BPM = 124.0
BEAT = 60.0 / BPM            # seconds per quarter note
STEP = BEAT / 4.0            # 16th-note grid
random.seed(7)               # deterministic "humanize"

n_total = int(DUR * SR)
buf = [0.0] * n_total        # mono mix; widened to stereo at write time


def add(start_s, samples, gain=1.0, pan=0.0):
    """Mix a list of mono samples into buf at start_s seconds."""
    i0 = int(start_s * SR)
    for k, s in enumerate(samples):
        j = i0 + k
        if 0 <= j < n_total:
            buf[j] += s * gain


# ---- voice generators (return mono sample lists) ----------------------------
def env(n, a, d, s_level, r):
    """ADSR-ish envelope of length n samples (a/d/r in samples)."""
    out = []
    for i in range(n):
        if i < a:
            out.append(i / max(1, a))
        elif i < a + d:
            out.append(1.0 - (1.0 - s_level) * (i - a) / max(1, d))
        elif i < n - r:
            out.append(s_level)
        else:
            out.append(s_level * max(0.0, (n - i) / max(1, r)))
    return out


def kick(dur=0.22):
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        # pitch sweep 110 -> 45 Hz, fast exponential decay
        f = 45 + 65 * math.exp(-t * 28)
        amp = math.exp(-t * 12)
        out.append(math.sin(2 * math.pi * f * t) * amp)
    return out


def hat(dur=0.05):
    n = int(dur * SR)
    # white noise, crude highpass via first-difference, short decay
    prev = 0.0
    out = []
    for i in range(n):
        w = random.uniform(-1, 1)
        hp = w - prev
        prev = w
        out.append(hp * math.exp(-i / n * 6))
    return out


def saw(freq, dur, detune=0.0):
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        # band-limited-ish saw via summed harmonics (cheap, warm)
        v = 0.0
        for h in range(1, 8):
            v += math.sin(2 * math.pi * freq * h * t) / h
        if detune:
            for h in range(1, 6):
                v += 0.5 * math.sin(2 * math.pi * freq * (1 + detune) * h * t) / h
        out.append(v * 0.5)
    e = env(n, int(0.005 * SR), int(0.04 * SR), 0.7, int(0.06 * SR))
    return [o * e[i] for i, o in enumerate(out)]


def pluck(freq, dur):
    """Bright triangle+sine pluck for the arp."""
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        v = 0.6 * math.sin(2 * math.pi * freq * t) + 0.25 * math.sin(2 * math.pi * 2 * freq * t)
        out.append(v)
    e = env(n, int(0.003 * SR), int(0.10 * SR), 0.0, int(0.02 * SR))  # percussive
    return [o * e[i] for i, o in enumerate(out)]


# ---- note tables ------------------------------------------------------------
def hz(semitones_from_a4):
    return 440.0 * (2 ** (semitones_from_a4 / 12.0))

# Progression: A major-ish uplift  vi-IV-I-V  (F#m - D - A - E), bass roots:
# use A2..E3 region. Semitone offsets from A4.
ROOTS = [hz(-15), hz(-19), hz(-12), hz(-17)]   # F#2, D2, A2, E2 (low bass)
# arp chord tones (one octave up triads) per chord, offsets from A4:
CHORDS = [
    [hz(-3), hz(1), hz(4)],    # F#m: F#4 A4 C#5  (approx)
    [hz(-7), hz(-3), hz(0)],   # D:   D4 F#4 A4
    [hz(0), hz(4), hz(7)],     # A:   A4 C#5 E5
    [hz(-5), hz(-1), hz(2)],   # E:   E4 G#4 B4
]

# ---- sequence ---------------------------------------------------------------
bars = int(DUR / (BEAT * 4)) + 1
intro_bars = 1     # drums-only-ish build
for bar in range(bars):
    bar_t = bar * BEAT * 4
    chord = bar % 4
    full = bar >= intro_bars       # arp/bass enter after the intro bar

    # kick: four on the floor
    for b in range(4):
        add(bar_t + b * BEAT, kick(), gain=0.95)
    # hats: offbeat 8ths (the drive), a touch of swing
    for s in range(8):
        t = bar_t + s * (BEAT / 2) + (0.012 if s % 2 else 0)
        add(t, hat(), gain=0.33 if s % 2 else 0.18)

    if full:
        # bass: root on beats with a syncopated 16th pickup
        r = ROOTS[chord]
        add(bar_t + 0 * BEAT, saw(r, BEAT * 0.9, detune=0.005), gain=0.42)
        add(bar_t + 1.5 * BEAT, saw(r, BEAT * 0.5, detune=0.005), gain=0.35)
        add(bar_t + 2 * BEAT, saw(r, BEAT * 0.9, detune=0.005), gain=0.42)
        add(bar_t + 3.5 * BEAT, saw(r * 1.5, BEAT * 0.5, detune=0.005), gain=0.30)
        # arp: 16th-note up-down through the triad, bright
        tones = CHORDS[chord]
        pattern = [0, 1, 2, 1, 2, 1, 0, 1] * 2  # 16 steps
        for s in range(16):
            t = bar_t + s * STEP
            f = tones[pattern[s] % 3] * 2  # an octave up = sparkle
            add(t, pluck(f, STEP * 1.6), gain=0.16)

# ---- normalize + soft clip --------------------------------------------------
peak = max(1e-9, max(abs(x) for x in buf))
norm = 0.89 / peak
def softclip(x):
    return math.tanh(x * 1.1)

with wave.open(OUT, "w") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for x in buf:
        v = softclip(x * norm)
        s = int(max(-1.0, min(1.0, v)) * 32767)
        frames += struct.pack("<hh", s, s)   # stereo (same L/R; width added in master)
    w.writeframes(bytes(frames))
print(f"wrote {OUT}: {DUR:.1f}s @ {BPM:.0f} BPM, {bars} bars")
